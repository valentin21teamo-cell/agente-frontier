/**
 * Mide, SIN gastar en modelos, qué tan bien ubica el agente los campos de un formulario por su etiqueta.
 *
 * Usa el escritorio GESTORA corriendo en local con GESTORA_GEOMETRIA (la app escribe la caja real de cada
 * campo y su etiqueta). Recorre Clientes, Nuevo cliente, Editar cliente, Facturas y Pedidos por VNC, y para
 * cada etiqueta aplica el mismo camino que el agente usa al escribir (OCR de la etiqueta + buscador de campo).
 * Un acierto es un punto que cae dentro de la caja real del campo.
 *
 * Antes de cada medición: POST /__reset (la app debe estar en su pantalla inicial con el aviso de novedades).
 * Uso (Linux con Xvfb/x11vnc, servidor local de escritorio/):
 *   GESTORA_GEOMETRIA=/tmp/geo.json PORT=8099 DESKTOP_TOKEN=x VNC_PASSWORD=clave123 python3 escritorio/servidor.py &
 *   npx tsx scripts/medir-localizador.ts ws://localhost:8099/websockify clave123 /tmp/geo.json
 */
import fs from 'node:fs';
import { RfbClient } from '../src/rfb/client.js';
import { ocrScreenshot, findTextMatches, findFieldNearLabel } from '../src/agent/ocr.js';

const [url = 'ws://localhost:8099/websockify', password = 'clave123', geoPath = '/tmp/geo.json'] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Caja { x: number; y: number; w: number; h: number }
interface Par { etiqueta: string; tipo: string; campo: Caja }

async function main() {
  const c = new RfbClient({ url, password } as any);
  await c.connect();
  await c.waitForFirstFrame(15000);
  await sleep(800);

  const shot = () => c.captureScreenshotPng();
  const clickText = async (texto: string, opts: { doble?: boolean } = {}) => {
    const png = await shot();
    const m = findTextMatches(await ocrScreenshot(png), texto)[0];
    if (!m) throw new Error(`No encontré "${texto}" para navegar`);
    const x = Math.round(m.box.x + m.box.w / 2);
    const y = Math.round(m.box.y + m.box.h / 2);
    if (opts.doble) await c.mouseDoubleClick(x, y);
    else await c.mouseClick(x, y);
    await sleep(700);
  };

  let total = 0;
  let aciertos = 0;
  const fallos: string[] = [];
  const medir = async (nombre: string) => {
    await sleep(900); // la app escribe la geometría 500 ms después de pintar la pantalla
    const png = await shot();
    const geo = JSON.parse(fs.readFileSync(geoPath, 'utf-8')) as { pantalla: string; pares: Par[] };
    const words = await ocrScreenshot(png);
    for (const p of geo.pares) {
      total++;
      const m = findTextMatches(words, p.etiqueta)[0];
      let punto: { x: number; y: number } | null = null;
      let via = '';
      if (m) {
        punto = findFieldNearLabel(png, m.box);
        via = 'campo';
        if (!punto) {
          punto = { x: Math.round(m.box.x + m.box.w + 45), y: Math.round(m.box.y + m.box.h / 2) };
          via = 'derecha+45';
        }
      }
      const dentro =
        !!punto && punto.x >= p.campo.x && punto.x <= p.campo.x + p.campo.w && punto.y >= p.campo.y && punto.y <= p.campo.y + p.campo.h;
      if (dentro) aciertos++;
      else fallos.push(`${nombre} | "${p.etiqueta}" (${p.tipo}) -> ${punto ? `(${punto.x},${punto.y}) vía ${via}` : 'etiqueta no leída'}; campo real x ${p.campo.x}-${p.campo.x + p.campo.w}, y ${p.campo.y}-${p.campo.y + p.campo.h}`);
      console.log(`${dentro ? 'OK   ' : 'FALLA'} ${nombre} | ${p.etiqueta}`);
    }
  };

  await clickText('Entendido');
  await clickText('Comercial');
  await clickText('Maestros');
  await clickText('Clientes');
  await medir('Clientes');
  await clickText('Nuevo cliente');
  await medir('Nuevo cliente');
  await clickText('Volver a la lista');
  await clickText('CL-0002', { doble: true });
  await medir('Editar cliente');
  await clickText('Cartera');
  await clickText('Facturas');
  await medir('Facturas');
  await clickText('Comercial');
  await clickText('Ventas');
  await clickText('Pedidos');
  await medir('Pedidos');

  console.log(`\nCampos ubicados dentro de su caja real: ${aciertos}/${total}`);
  for (const f of fallos) console.log('  ' + f);
  c.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
