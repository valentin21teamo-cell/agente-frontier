/**
 * Mide, SIN gastar en modelos, qué tan bien ubica el agente los campos de un formulario.
 *
 * Usa el escritorio GESTORA corriendo en local con GESTORA_GEOMETRIA (la app escribe la caja real de cada campo,
 * su etiqueta y su valor). Recorre Clientes, Nuevo cliente, Editar cliente, Facturas (sin filtro y filtrada como
 * en G15) y Pedidos por VNC. Para cada campo aplica `locateField`, la MISMA función que usa el agente, sin visión
 * (el peor caso: si la visión desempata, solo puede mejorar). Un acierto es un punto dentro de la caja real.
 *
 * Dos casos por campo:
 *  - por etiqueta: el planificador nombra el campo por su etiqueta ("Cliente:"), como pide el prompt;
 *  - por valor: lista desplegable nombrada por lo que muestra ("Pagada"), como hizo Claude en G15 (13/10).
 * "antes" reproduce el camino del agente en e124147 (también sin visión) en la misma corrida, con el buscador de
 * campos de ese commit: OCR_ANTES apunta a una copia de su src/agent/ocr.ts (git show e124147:src/agent/ocr.ts).
 * Sin OCR_ANTES, la columna "antes" usa el buscador actual con la lógica vieja (solo sirve de orientación).
 *
 * Antes de cada medición: POST /__reset. Uso (Linux con Xvfb/x11vnc, servidor local de escritorio/):
 *   GESTORA_GEOMETRIA=/tmp/geo.json PORT=8099 DESKTOP_TOKEN=x VNC_PASSWORD=clave123 python3 escritorio/servidor.py &
 *   OCR_ANTES=/tmp/antes/src/agent/ocr.ts npx tsx scripts/medir-localizador.ts ws://localhost:8099/websockify clave123 /tmp/geo.json
 */
import fs from 'node:fs';
import { RfbClient } from '../src/rfb/client.js';
import { ocrScreenshot, findTextMatches, findFieldNearLabel, locateField, TextMatch } from '../src/agent/ocr.js';

const [url = 'ws://localhost:8099/websockify', password = 'clave123', geoPath = '/tmp/geo.json'] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Caja { x: number; y: number; w: number; h: number }
interface Par { etiqueta: string; tipo: string; campo: Caja; valor?: string }

const buscadorAntes: typeof findFieldNearLabel = process.env.OCR_ANTES
  ? (await import(process.env.OCR_ANTES)).findFieldNearLabel
  : findFieldNearLabel;

/** Camino del agente en e124147 para un campo (isField), sin visión. Copia fiel de loop.ts de ese commit. */
function antes(png: Buffer, matches: TextMatch[]): { x: number; y: number } {
  const best = matches[0];
  if (matches.length > 1) {
    for (const cand of [best, ...matches.filter((m) => m !== best)].slice(0, 4)) {
      const f = buscadorAntes(png, cand.box);
      if (f) return f;
    }
  }
  const f = buscadorAntes(png, best.box);
  if (f) return f;
  return { x: Math.min(1275, Math.round(best.box.x + best.box.w + 45)), y: Math.round(best.box.y + best.box.h / 2) };
}

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
  const geo = () => JSON.parse(fs.readFileSync(geoPath, 'utf-8')) as { pantalla: string; pares: Par[] };

  const cuenta = { etiqueta: { total: 0, ahora: 0, antes: 0 }, valor: { total: 0, ahora: 0, antes: 0 } };
  const fallos: string[] = [];
  const dentro = (p: { x: number; y: number } | null, k: Caja) => !!p && p.x >= k.x && p.x <= k.x + k.w && p.y >= k.y && p.y <= k.y + k.h;

  /** valores: valor que muestra cada campo cuando cambió después de pintar la pantalla (la geometría no se reescribe). */
  const medir = async (nombre: string, valores: Record<string, string> = {}) => {
    await sleep(900); // la app escribe la geometría 500 ms después de pintar la pantalla
    const png = await shot();
    const g = geo();
    for (const p of g.pares) if (valores[p.etiqueta] !== undefined) p.valor = valores[p.etiqueta];
    const words = await ocrScreenshot(png);
    const casos: Array<{ tipo: 'etiqueta' | 'valor'; texto: string; par: Par }> = [];
    for (const p of g.pares) {
      casos.push({ tipo: 'etiqueta', texto: p.etiqueta, par: p });
      if (p.tipo === 'TCombobox' && p.valor && p.valor.trim()) casos.push({ tipo: 'valor', texto: p.valor.trim(), par: p });
    }
    for (const caso of casos) {
      const n = cuenta[caso.tipo];
      n.total++;
      const matches = findTextMatches(words, caso.texto);
      let ahora: { x: number; y: number; via: string } | null = null;
      let viejo: { x: number; y: number } | null = null;
      if (matches.length > 0) {
        ahora = await locateField(png, matches, async () => null, 1280);
        viejo = antes(png, matches);
      }
      const okAhora = dentro(ahora, caso.par.campo);
      const okAntes = dentro(viejo, caso.par.campo);
      if (okAhora) n.ahora++;
      if (okAntes) n.antes++;
      const k = caso.par.campo;
      const desc = `${nombre} | ${caso.tipo} "${caso.texto}" (${caso.par.tipo}, ${matches.length} coincidencias)`;
      if (!okAhora)
        fallos.push(`${desc} -> ${ahora ? `(${ahora.x},${ahora.y}) vía ${ahora.via}` : 'texto no leído'}; campo real x ${k.x}-${k.x + k.w}, y ${k.y}-${k.y + k.h}`);
      console.log(`${okAntes ? 'OK   ' : 'FALLA'} -> ${okAhora ? 'OK   ' : 'FALLA'}  ${desc}`);
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

  // Facturas filtrada como en G15: Cliente "Ruiz", Estado "Pagada". "Pagada" queda en la lista y en 15 filas.
  const g = geo();
  const campo = (et: string) => g.pares.find((p) => p.etiqueta === et)!.campo;
  const cli = campo('Cliente:');
  await c.mouseClick(cli.x + 20, cli.y + cli.h / 2);
  await c.typeText('Ruiz');
  const est = campo('Estado:');
  await c.mouseClick(est.x + est.w / 2, est.y + est.h / 2);
  await sleep(600);
  await clickText('Pagada');
  await clickText('Filtrar');
  await c.movePath(1270, 790); // el puntero fuera de los filtros: aquí se mide el localizador, no el OCR bajo el puntero
  await medir('Facturas filtrada (G15)', { 'Estado:': 'Pagada' });

  await clickText('Comercial');
  await clickText('Ventas');
  await clickText('Pedidos');
  await medir('Pedidos');

  const { etiqueta: e, valor: v } = cuenta;
  console.log(`\nBuscador "antes": ${process.env.OCR_ANTES ? 'ocr.ts de e124147' : 'el actual (sin OCR_ANTES)'}`);
  console.log(`\nPor etiqueta: antes ${e.antes}/${e.total}, ahora ${e.ahora}/${e.total}`);
  console.log(`Por valor (lista desplegable nombrada por lo que muestra): antes ${v.antes}/${v.total}, ahora ${v.ahora}/${v.total}`);
  for (const f of fallos) console.log('  ' + f);
  c.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
