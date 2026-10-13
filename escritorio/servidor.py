"""
Servidor del escritorio de prueba (un solo puerto, apto para Cloud Run).

Arranca y vigila: Xvfb (pantalla 1280x800) -> GESTORA ERP (Tk) -> x11vnc (VNC con contraseña, solo local).
Expone en $PORT:
  GET  /health                 estado
  GET  /websockify             VNC por WebSocket (puente a x11vnc), lo usa el agente
  POST /__reset    (token)     vuelve la base a la semilla y reinicia la aplicación
  POST /__check    (token)     compara la base con la semilla y evalúa una prueba
  GET  /ver                    visor en vivo (solo mirar) para personas
  GET  /                       página de información

Variables: PORT, DESKTOP_TOKEN, VNC_PASSWORD. Sin DESKTOP_TOKEN, /__reset y /__check responden 503.
"""

import asyncio
import hmac
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from aiohttp import WSMsgType, web

AQUI = Path(__file__).resolve().parent
APP = AQUI / "app"
sys.path.insert(0, str(APP))
import datos  # noqa: E402
import evaluador  # noqa: E402

PORT = int(os.environ.get("PORT", "8080"))
DISPLAY = os.environ.get("DISPLAY_NUM", ":1")
VNC_PORT = int(os.environ.get("VNC_PORT", "5900"))
TRABAJO = Path(os.environ.get("TRABAJO_DIR", "/tmp/gestora"))
SEMILLA = TRABAJO / "semilla.db"
BASE = TRABAJO / "gestora.db"
LISTO = TRABAJO / "app-listo"
TOKEN = os.environ.get("DESKTOP_TOKEN", "")
VNC_PASSWORD = os.environ.get("VNC_PASSWORD", "")

procesos = {}
reseteando = asyncio.Lock()
inicio = time.time()


def log(msg: str) -> None:
    print(f"[escritorio] {msg}", flush=True)


def lanzar(nombre: str, args: list, env=None) -> None:
    e = dict(os.environ, DISPLAY=DISPLAY)
    if env:
        e.update(env)
    procesos[nombre] = subprocess.Popen(args, env=e, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    log(f"{nombre} iniciado (pid {procesos[nombre].pid})")


def vivo(nombre: str) -> bool:
    p = procesos.get(nombre)
    return p is not None and p.poll() is None


def detener(nombre: str) -> None:
    p = procesos.get(nombre)
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()


def lanzar_app() -> None:
    LISTO.unlink(missing_ok=True)
    lanzar("app", [sys.executable, str(APP / "gestora.py"), "--db", str(BASE), "--listo", str(LISTO)])


async def esperar_app(segundos=15.0) -> bool:
    t = time.time()
    while time.time() - t < segundos:
        if LISTO.exists():
            await asyncio.sleep(0.6)  # deja terminar el primer repintado
            return True
        await asyncio.sleep(0.2)
    return False


def preparar() -> None:
    TRABAJO.mkdir(parents=True, exist_ok=True)
    if not SEMILLA.exists():
        datos.crear_base(str(SEMILLA))
    shutil.copyfile(SEMILLA, BASE)
    clave = TRABAJO / "vncpass"
    subprocess.run(["x11vnc", "-storepasswd", VNC_PASSWORD, str(clave)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    lanzar("xvfb", ["Xvfb", DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp"])
    time.sleep(1.0)
    lanzar_app()
    lanzar("vnc", ["x11vnc", "-display", DISPLAY, "-rfbport", str(VNC_PORT), "-localhost", "-forever",
                   "-shared", "-rfbauth", str(clave), "-noxdamage", "-quiet"])


async def vigilante(_app) -> None:
    """Si la aplicación o el VNC se caen (fuera de un reset), se vuelven a levantar."""
    async def ciclo():
        while True:
            await asyncio.sleep(1.0)
            if reseteando.locked():
                continue
            if not vivo("xvfb"):
                lanzar("xvfb", ["Xvfb", DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp"])
                await asyncio.sleep(1.0)
            if not vivo("app"):
                log("la aplicación se cerró; se reinicia")
                lanzar_app()
            if not vivo("vnc"):
                lanzar("vnc", ["x11vnc", "-display", DISPLAY, "-rfbport", str(VNC_PORT), "-localhost", "-forever",
                               "-shared", "-rfbauth", str(TRABAJO / "vncpass"), "-noxdamage", "-quiet"])

    task = asyncio.create_task(ciclo())
    yield
    task.cancel()
    for n in ("vnc", "app", "xvfb"):
        detener(n)


def autorizado(request: web.Request) -> bool:
    h = request.headers.get("Authorization", "")
    if not TOKEN or not h.startswith("Bearer "):
        return False
    return hmac.compare_digest(h[7:].strip().encode(), TOKEN.encode())


def requiere_token(fn):
    async def envoltura(request):
        if not TOKEN:
            return web.json_response({"error": "DESKTOP_TOKEN no configurado en el servidor"}, status=503)
        if not autorizado(request):
            return web.json_response({"error": "No autorizado"}, status=401)
        return await fn(request)
    return envoltura


async def salud(_request):
    return web.json_response({
        "ok": True, "app": vivo("app"), "vnc": vivo("vnc"), "pantalla": vivo("xvfb"),
        "uptime_s": int(time.time() - inicio), "hoy": datos.HOY.isoformat(),
    })


@requiere_token
async def reset(_request):
    async with reseteando:
        t = time.time()
        detener("app")
        shutil.copyfile(SEMILLA, BASE)
        lanzar_app()
        ok = await esperar_app()
        return web.json_response({"ok": ok, "segundos": round(time.time() - t, 2)}, status=200 if ok else 500)


@requiere_token
async def check(request):
    try:
        prueba = await request.json()
    except Exception:
        return web.json_response({"error": "JSON inválido"}, status=400)
    cambios = evaluador.calcular_cambios(str(SEMILLA), str(BASE))
    return web.json_response(evaluador.evaluar(prueba, cambios))


async def websockify(request):
    if request.headers.get("Upgrade", "").lower() != "websocket":
        return web.Response(text="Este endpoint espera una conexión WebSocket (VNC).", status=400)
    ws = web.WebSocketResponse(protocols=("binary",), compress=False, max_msg_size=0)
    await ws.prepare(request)
    try:
        lector, escritor = await asyncio.open_connection("127.0.0.1", VNC_PORT)
    except OSError:
        await ws.close(message=b"VNC no disponible")
        return ws

    async def tcp_a_ws():
        try:
            while True:
                data = await lector.read(65536)
                if not data:
                    break
                await ws.send_bytes(data)
        finally:
            await ws.close()

    async def ws_a_tcp():
        try:
            async for msg in ws:
                if msg.type == WSMsgType.BINARY:
                    escritor.write(msg.data)
                    await escritor.drain()
                elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break
        finally:
            escritor.close()

    tareas = [asyncio.create_task(tcp_a_ws()), asyncio.create_task(ws_a_tcp())]
    _, pendientes = await asyncio.wait(tareas, return_when=asyncio.FIRST_COMPLETED)
    for p in pendientes:
        p.cancel()
    return ws


async def pagina(_request):
    return web.FileResponse(AQUI / "web" / "index.html")


async def visor(_request):
    return web.FileResponse(AQUI / "web" / "ver.html")


def crear_app() -> web.Application:
    app = web.Application(client_max_size=1024 * 1024)
    app.router.add_get("/health", salud)
    app.router.add_post("/__reset", reset)
    app.router.add_post("/__check", check)
    app.router.add_get("/websockify", websockify)
    app.router.add_get("/ver", visor)
    app.router.add_get("/", pagina)
    app.cleanup_ctx.append(vigilante)
    return app


if __name__ == "__main__":
    if not VNC_PASSWORD:
        sys.exit("Falta VNC_PASSWORD (contraseña del VNC, máximo 8 caracteres efectivos).")
    if not TOKEN:
        log("AVISO: sin DESKTOP_TOKEN, /__reset y /__check quedan deshabilitados")
    preparar()
    web.run_app(crear_app(), host="0.0.0.0", port=PORT, print=None)
