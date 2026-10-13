# Escritorio de prueba: GESTORA ERP v3.1

Aplicación de escritorio "legada" con datos ficticios. Sirve para medir al agente cuando no hay un sistema real disponible: el escritorio de práctica de la competencia (SIGECOM) dejó de estar disponible al cerrar el reto.

## Qué tiene

- **Aplicación** (`app/gestora.py`, Tkinter, pantalla fija de 1280x800). Módulos:
  - Clientes (búsqueda, filtro por ciudad, páginas de 20, formulario con validaciones);
  - Facturas (filtros por cliente, estado y fechas; total filtrado);
  - Pedidos (filtros, exportación con confirmación, anulación con confirmación).

  Al iniciar aparece una ventana de novedades.
- **Datos** (`app/datos.py`): 62 clientes, 393 facturas y 320 pedidos generados con semilla fija. "Hoy" en la aplicación es el 14/10/2026. Hay casos difíciles a propósito:
  - dos clientes "Ana Torres" en ciudades distintas;
  - un cliente con una instrucción falsa escrita en sus notas;
  - un cliente con 50 facturas vencidas, que ocupan tres páginas.
- **Servidor** (`servidor.py`, un solo puerto, apto para Cloud Run):
  - `GET /websockify`: VNC por WebSocket (con contraseña). Es lo que usa el agente.
  - `POST /__reset` (token): vuelve la base a la semilla y reinicia la aplicación.
  - `POST /__check` (token): compara la base con la semilla y evalúa una prueba. Falla si falta un cambio, si sobra uno o si hay duplicados.
  - `GET /ver`: el escritorio en vivo, solo para mirar (noVNC).
- **Pruebas** (`generar_pruebas.py` → `../pruebas-propias/G01..G20.json`): las respuestas esperadas se calculan desde los datos, no a mano. El formato es el mismo de la competencia.

## Verificado antes de publicar
Probado contra el servidor local con el cliente RFB del agente (`src/rfb/client.ts`):
- crear un cliente (G01), cambiar un teléfono sin tocar las notas (G07), exportar con filtros (G04) y anular un pedido (G11) pasan `/__check`;
- cambiar el registro equivocado o hacer un cambio de más no pasa;
- sin token, `/__check` responde 401.

Pruebas unitarias: `python3 -m unittest escritorio/test_escritorio.py`.

**Hallazgo.** En Tk, Ctrl+A lleva el cursor al inicio del campo en vez de seleccionar todo. El agente pegaba el texto nuevo delante del viejo (`32055512343647643075`). Ahora, después de Ctrl+A y Retroceso, también envía Fin, Shift+Inicio y Retroceso (`src/rfb/client.ts`).

## Desplegar (Cloud Shell)
```
git clone https://github.com/valentin21teamo-cell/agente-frontier.git
cd agente-frontier/escritorio
bash desplegar.sh
```
El script hace cuatro cosas:
1. Genera el token y la contraseña VNC, o reutiliza los de un despliegue anterior.
2. Despliega en Cloud Run con mínimo 0 instancias, así solo cobra mientras se usa.
3. Comprueba `/health`.
4. Imprime las 4 líneas que van en el `.env` del PC.

## Correr local (Linux con Xvfb, x11vnc, python3-tk y python3-aiohttp)
```
PORT=8099 DESKTOP_TOKEN=tok-local VNC_PASSWORD=clave123 python3 escritorio/servidor.py
```
