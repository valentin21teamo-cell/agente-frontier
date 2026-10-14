/**
 * Localización EXACTA por texto (OCR con Tesseract).
 *
 * El modelo de visión acierta QUÉ elemento es, pero sus coordenadas fallan decenas o cientos de píxeles.
 * El OCR devuelve la caja de cada palabra en píxeles reales de la captura, sin IA de por medio.
 * Se corren cuatro variantes en paralelo y se combinan:
 *   A) gris x2, por bloques (párrafos, etiquetas, tablas)
 *   B) gris x3, texto disperso (barras de menú, submenús flotantes y etiquetas sueltas)
 *   C) texto claro binarizado x2 (texto blanco sobre botones de color o cabeceras)
 *   D) inversión local x3 (texto claro sobre fondo oscuro: opción de menú resaltada, fondo detrás de un modal)
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { Rect } from './imageOps.js';

export interface OcrWord {
  text: string;
  conf: number;
  box: Rect;
  lineKey: string;
}

export interface TextMatch {
  text: string;
  box: Rect;
  score: number;
  standalone: boolean;
}

let tesseractLang: string | null | undefined; // undefined = sin comprobar, null = no disponible

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Un hilo por proceso: con varias tareas a la vez, los hilos de OpenMP saturan la CPU.
    const env = { ...process.env, OMP_THREAD_LIMIT: '1' };
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

/** Devuelve el idioma a usar ("spa+eng" o "eng"), o null si Tesseract no está instalado. */
export async function ocrAvailable(): Promise<string | null> {
  if (process.env.OCR_DISABLED === '1') return null;
  if (tesseractLang !== undefined) return tesseractLang;
  try {
    const out = await run('tesseract', ['--list-langs'], 5000);
    tesseractLang = /\bspa\b/.test(out) ? 'spa+eng' : 'eng';
  } catch {
    tesseractLang = null;
  }
  return tesseractLang;
}

/**
 * Escala de grises ampliada (bilineal) en formato PGM (sin compresión: escribirlo es casi instantáneo y no
 * bloquea el servidor). mode "light" binariza el texto claro y lo deja negro sobre blanco.
 */
export type OcrMode = 'gray' | 'light' | 'invert';

/**
 * Inversión local: donde el entorno (ventana de 21x21 px) es oscuro, se invierte la luminancia.
 * Así el texto claro sobre fondo oscuro (opción de menú resaltada, botón de color, fondo atenuado
 * detrás de un modal) queda oscuro sobre claro, sin tocar el resto de la pantalla.
 */
function invertLocal(lum: Float32Array, W: number, H: number): void {
  const R = 10;
  const integ = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += lum[y * W + x];
      integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1] + row;
    }
  }
  const src = Float32Array.from(lum);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - R);
    const y1 = Math.min(H, y + R + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - R);
      const x1 = Math.min(W, x + R + 1);
      const sum = integ[y1 * (W + 1) + x1] - integ[y0 * (W + 1) + x1] - integ[y1 * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
      if (sum / ((x1 - x0) * (y1 - y0)) < 128) lum[y * W + x] = 255 - src[y * W + x];
    }
  }
}

export function preprocess(pngBuf: Buffer, scale: number, mode: OcrMode, region?: Rect): Buffer {
  const src = PNG.sync.read(pngBuf);
  const rx = region ? Math.max(0, Math.min(src.width - 1, Math.round(region.x))) : 0;
  const ry = region ? Math.max(0, Math.min(src.height - 1, Math.round(region.y))) : 0;
  const W = region ? Math.max(1, Math.min(src.width - rx, Math.round(region.w))) : src.width;
  const H = region ? Math.max(1, Math.min(src.height - ry, Math.round(region.h))) : src.height;
  const lum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = ((ry + y) * src.width + (rx + x)) * 4;
      lum[y * W + x] = 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2];
    }
  }
  if (mode === 'invert') invertLocal(lum, W, H);
  const OW = W * scale;
  const OH = H * scale;
  const header = Buffer.from(`P5\n${OW} ${OH}\n255\n`, 'ascii');
  const pix = Buffer.alloc(OW * OH);
  for (let y = 0; y < OH; y++) {
    const fy = Math.min(H - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(H - 1, y0 + 1);
    const dy = fy - y0;
    for (let x = 0; x < OW; x++) {
      const fx = Math.min(W - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(W - 1, x0 + 1);
      const dx = fx - x0;
      const v =
        lum[y0 * W + x0] * (1 - dx) * (1 - dy) +
        lum[y0 * W + x1] * dx * (1 - dy) +
        lum[y1 * W + x0] * (1 - dx) * dy +
        lum[y1 * W + x1] * dx * dy;
      pix[y * OW + x] = mode === 'light' ? (v > 170 ? 0 : 255) : Math.round(v);
    }
  }
  return Buffer.concat([header, pix]);
}

export function parseTsv(tsv: string, scale: number, variant: string): OcrWord[] {
  const words: OcrWord[] = [];
  const lines = tsv.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join('\t').trim();
    const conf = Number(c[10]);
    if (!text || !(conf >= 30)) continue;
    words.push({
      text,
      conf,
      box: { x: Number(c[6]) / scale, y: Number(c[7]) / scale, w: Number(c[8]) / scale, h: Number(c[9]) / scale },
      lineKey: `${variant}:${c[2]}-${c[3]}-${c[4]}`,
    });
  }
  return words;
}

const cache = new Map<string, Promise<OcrWord[]>>();

/**
 * Semáforo global de procesos Tesseract: con muchas tareas simultáneas (el set de evaluación) se evita
 * agotar CPU y memoria del contenedor, que es lo que tumba el servidor. Si la espera es larga, se omite el OCR.
 */
const MAX_PROCS = Math.max(1, Number(process.env.OCR_MAX_PROCS) || 2);
let activeProcs = 0;
const waiters: Array<{ go: () => void; done: boolean }> = [];
function acquireProc(timeoutMs: number): Promise<boolean> {
  if (activeProcs < MAX_PROCS) {
    activeProcs++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const w = {
      done: false,
      go: () => {
        if (w.done) return;
        w.done = true;
        clearTimeout(timer);
        activeProcs++;
        resolve(true);
      },
    };
    const timer = setTimeout(() => {
      if (w.done) return;
      w.done = true;
      resolve(false);
    }, timeoutMs);
    waiters.push(w);
  });
}
function releaseProc(): void {
  activeProcs = Math.max(0, activeProcs - 1);
  while (waiters.length > 0) {
    const w = waiters.shift()!;
    if (!w.done) {
      w.go();
      break;
    }
  }
}

/** OCR de la captura con las tres variantes. La caché guarda la promesa: dos pedidos de la misma imagen comparten trabajo. */
export async function ocrScreenshot(pngBuf: Buffer): Promise<OcrWord[]> {
  const lang = await ocrAvailable();
  if (!lang) return [];
  const key = createHash('sha1').update(pngBuf).digest('hex');
  const hit = cache.get(key);
  if (hit) return hit;
  const job = runOcr(pngBuf, lang);
  if (cache.size > 8) cache.clear();
  cache.set(key, job);
  return job;
}

async function runOcr(pngBuf: Buffer, lang: string): Promise<OcrWord[]> {
  // B va a x3: medido sobre capturas reales de SIGECOM, a x2 no leía "Clientes" dentro del submenú
  // flotante de Comercial > Maestros (texto dentro de un recuadro con borde); a x3 sí, por ~200 ms más.
  // D (inversión local x3): medido en capturas reales, recupera texto claro sobre fondo oscuro que A-C
  // no leían: la opción resaltada de un menú desplegable y todo el fondo atenuado detrás de un modal.
  const variants: Array<{ id: string; scale: number; mode: OcrMode; psm: string }> = [
    { id: 'A', scale: 2, mode: 'gray', psm: '6' },
    { id: 'B', scale: 3, mode: 'gray', psm: '11' },
    { id: 'C', scale: 2, mode: 'light', psm: '6' },
    { id: 'D', scale: 3, mode: 'invert', psm: '11' },
  ];
  const tmp = os.tmpdir();
  // Gris (bloques y texto disperso: menús) y binarizada para texto claro sobre botones de color.
  const gray2 = preprocess(pngBuf, 2, 'gray');
  await new Promise((r) => setImmediate(r)); // deja respirar al servidor HTTP entre pasos pesados
  const gray3 = preprocess(pngBuf, 3, 'gray');
  await new Promise((r) => setImmediate(r));
  const light2 = preprocess(pngBuf, 2, 'light');
  await new Promise((r) => setImmediate(r));
  const inv3 = preprocess(pngBuf, 3, 'invert');
  const results = await Promise.all(
    variants.map(async (v) => {
      const file = path.join(tmp, `ocr-${randomUUID()}.pgm`);
      if (!(await acquireProc(12000))) return [] as OcrWord[];
      try {
        fs.writeFileSync(file, v.mode === 'light' ? light2 : v.mode === 'invert' ? inv3 : v.scale === 3 ? gray3 : gray2);
        const tsv = await run('tesseract', [file, 'stdout', '-l', lang, '--psm', v.psm, 'tsv'], 15000);
        return parseTsv(tsv, v.scale, v.id);
      } catch {
        return [] as OcrWord[];
      } finally {
        releaseProc();
        fs.rm(file, { force: true }, () => {});
      }
    })
  );
  return results.flat();
}

/**
 * OCR de una zona ampliada x3 (texto pequeño o en menús flotantes que el OCR de pantalla completa no leyó).
 * Las coordenadas se devuelven en píxeles de la pantalla.
 */
export async function ocrRegion(pngBuf: Buffer, region: Rect, scale = 3): Promise<OcrWord[]> {
  const lang = await ocrAvailable();
  if (!lang) return [];
  const tmp = os.tmpdir();
  // ZB (texto disperso) es la que lee las opciones de submenús flotantes; ZA/ZC cubren bloques y texto claro.
  const variants: Array<{ id: string; mode: OcrMode; psm: string }> = [
    { id: 'ZA', mode: 'gray', psm: '6' },
    { id: 'ZB', mode: 'gray', psm: '11' },
    { id: 'ZC', mode: 'light', psm: '6' },
    { id: 'ZD', mode: 'invert', psm: '11' },
  ];
  const results = await Promise.all(
    variants.map(async (v) => {
      const file = path.join(tmp, `ocrz-${randomUUID()}.pgm`);
      if (!(await acquireProc(8000))) return [] as OcrWord[];
      try {
        fs.writeFileSync(file, preprocess(pngBuf, scale, v.mode, region));
        const tsv = await run('tesseract', [file, 'stdout', '-l', lang, '--psm', v.psm, 'tsv'], 12000);
        return parseTsv(tsv, scale, v.id).map((w) => ({
          ...w,
          box: { x: w.box.x + region.x, y: w.box.y + region.y, w: w.box.w, h: w.box.h },
        }));
      } catch {
        return [] as OcrWord[];
      } finally {
        releaseProc();
        fs.rm(file, { force: true }, () => {});
      }
    })
  );
  return results.flat();
}

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ@#./-]+/g, ' ')
    .replace(/[.,:;]+$/g, '')
    .trim();
}

function tokens(s: string): string[] {
  return normalizeText(s)
    .split(/\s+/)
    .map((t) => t.replace(/^[.,:;()\-]+|[.,:;()\-]+$/g, ''))
    .filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

function tokenMatch(want: string, got: string): number {
  if (want === got) return 1;
  const tol = want.length >= 7 ? 2 : want.length >= 4 ? 1 : 0;
  const dist = levenshtein(want, got);
  if (dist <= tol) return 1 - dist / (want.length + 1);
  return 0;
}

function union(boxes: Rect[]): Rect {
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Busca el texto objetivo en las palabras OCR. Devuelve candidatos ordenados (mejor primero, sin duplicados).
 * Un " | " en el objetivo es el separador de columnas del texto que recibe el planificador: si lo copia, vale
 * por una palabra cualquiera o por ninguna ("Buscar (nombre | documento):" encuentra "Buscar (nombre o documento):").
 */
export function findTextMatches(words: OcrWord[], target: string): TextMatch[] {
  if (target.includes('|')) {
    const parts = target.split('|').map((p) => p.trim()).filter(Boolean);
    const conComodin = matchTokens(words, target, parts.flatMap((p, i) => (i > 0 ? [null, ...tokens(p)] : tokens(p))));
    return conComodin.length > 0 ? conComodin : matchTokens(words, target, tokens(parts.join(' ')));
  }
  return matchTokens(words, target, tokens(target));
}

/** want: tokens del objetivo; null = comodín que acepta cualquier palabra de la línea. */
function matchTokens(words: OcrWord[], target: string, want: Array<string | null>): TextMatch[] {
  if (want.filter((t) => t !== null).length === 0) return [];
  const byLine = new Map<string, OcrWord[]>();
  for (const w of words) {
    const arr = byLine.get(w.lineKey) ?? [];
    arr.push(w);
    byLine.set(w.lineKey, arr);
  }

  const found: TextMatch[] = [];
  for (const lineWords of byLine.values()) {
    lineWords.sort((a, b) => a.box.x - b.box.x);
    const lt = lineWords.map((w) => tokens(w.text).join(' '));
    for (let i = 0; i + want.length <= lt.length; i++) {
      let q = 0;
      let ok = true;
      for (let k = 0; k < want.length; k++) {
        const wk = want[k];
        const s = wk === null ? 1 : tokenMatch(wk, lt[i + k]);
        if (s === 0) {
          ok = false;
          break;
        }
        q += s;
      }
      if (!ok) continue;
      const slice = lineWords.slice(i, i + want.length);
      const conf = slice.reduce((s, w) => s + w.conf, 0) / slice.length / 100;
      const standalone = lt.length === want.length;
      const raw = slice.map((w) => w.text).join(' ');
      const exactCase = raw.replace(/[.,:;]+$/, '') === target.trim().replace(/[.,:;]+$/, '');
      // Una etiqueta de formulario se pide con ":" ("Estado:"); la cabecera de una columna con el mismo
      // nombre no lo lleva. Sin este desempate se escribía en la tabla (medido en GESTORA, 14/10).
      const colon = /:\s*$/.test(target) && /:\s*$/.test(raw);
      const score = (q / want.length) * 0.6 + conf * 0.3 + (standalone ? 0.2 : 0) + (exactCase ? 0.1 : 0) + (colon ? 0.3 : 0);
      found.push({ text: slice.map((w) => w.text).join(' '), box: union(slice.map((w) => w.box)), score, standalone });
    }
  }

  // Quitar duplicados entre variantes (misma zona): conservar el de mayor puntaje.
  found.sort((a, b) => b.score - a.score);
  const unique: TextMatch[] = [];
  for (const m of found) {
    const cx = m.box.x + m.box.w / 2;
    const cy = m.box.y + m.box.h / 2;
    const dup = unique.some((u) => Math.abs(u.box.x + u.box.w / 2 - cx) < 12 && Math.abs(u.box.y + u.box.h / 2 - cy) < 8);
    if (!dup) unique.push(m);
  }
  return unique;
}

/** Texto visible a buscar: campo "texto" de la acción o lo que esté entre comillas en el objetivo. */
export function extractTargetText(objetivo?: string, texto?: string): string | null {
  if (texto && texto.trim()) return texto.trim();
  if (!objetivo) return null;
  const m = objetivo.match(/['"“”‘’«»]([^'"“”‘’«»]{1,60})['"“”‘’«»]/);
  return m ? m[1].trim() : null;
}

/** PNG decodificado por buffer: el localizador revisa varias coincidencias sobre la misma captura. */
const decoded = new WeakMap<Buffer, PNG>();
function decode(pngBuf: Buffer): PNG {
  let png = decoded.get(pngBuf);
  if (!png) {
    png = PNG.sync.read(pngBuf);
    decoded.set(pngBuf, png);
  }
  return png;
}

/** Detectores de bordes rectos sobre una captura (compartidos por los buscadores de campos). */
function edgeKit(png: PNG) {
  const W = png.width;
  const H = png.height;
  const L = (x: number, y: number) => {
    const i = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4;
    return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
  };
  const edgeH = (x: number, y: number) => Math.abs(L(x, y) - L(x, y - 1)) >= 18 || Math.abs(L(x, y + 1) - L(x, y)) >= 18;
  const edgeV = (x: number, y: number) => Math.abs(L(x, y) - L(x - 1, y)) >= 18 || Math.abs(L(x + 1, y) - L(x, y)) >= 18;
  /**
   * ¿Hay una línea horizontal continua en y (±1) desde x0 a lo largo de len px?
   * Se revisa cada píxel y se exige el 95 %: un borde es continuo; la parte de arriba de las minúsculas de una
   * fila de texto ("ermanos") deja huecos entre letras. Con muestras cada 3 px y el 85 %, dos filas de una tabla
   * parecían el borde superior e inferior de un campo (medido en GESTORA, Facturas, 14/10).
   */
  const hLine = (x0: number, y: number, len: number) => {
    let hits = 0;
    let total = 0;
    for (let k = 0; k <= len; k++) {
      total++;
      if (edgeH(x0 + k, y) || edgeH(x0 + k, y - 1) || edgeH(x0 + k, y + 1)) hits++;
    }
    return hits / total >= 0.95;
  };
  /** ¿Hay una línea vertical continua en x (±1) entre y0 e y1? (borde izquierdo de una caja alta) */
  const vLine = (x: number, y0: number, y1: number) => {
    let hits = 0;
    let total = 0;
    for (let y = y0 + 2; y <= y1 - 2; y += 3) {
      total++;
      if (edgeV(x, y) || edgeV(x - 1, y) || edgeV(x + 1, y)) hits++;
    }
    return total > 0 && hits / total >= 0.85;
  };
  /**
   * Dado un punto que está dentro de una posible caja, busca sus bordes superior e inferior rectos.
   * leftX: si se conoce el borde izquierdo, se aceptan cajas altas (áreas de texto de varias líneas)
   * siempre que ese borde sea una línea vertical continua entre arriba y abajo.
   */
  const boxAround = (x: number, y: number, leftX?: number): { top: number; bottom: number } | null => {
    let top = -1;
    let bottom = -1;
    const reach = leftX === undefined ? 26 : 110;
    for (let d = 2; d <= reach; d++) {
      if (top < 0 && y - d > 0 && edgeH(x, y - d) && hLine(x, y - d, 50)) top = y - d;
      if (bottom < 0 && y + d < H - 1 && edgeH(x, y + d) && hLine(x, y + d, 50)) bottom = y + d;
    }
    if (top < 0 || bottom < 0) return null;
    const h = bottom - top;
    if (h >= 14 && h <= 48) return { top, bottom };
    // Área de texto (p. ej. "Notas", 4 líneas ≈ 70 px): solo si el borde izquierdo la cierra de arriba abajo.
    if (leftX !== undefined && h > 48 && h <= 220 && vLine(leftX, top, bottom)) return { top, bottom };
    return null;
  };
  return { W, H, edgeH, edgeV, hLine, vLine, boxAround };
}

/**
 * ¿El texto está DENTRO de una caja (campo, lista desplegable, celda con bordes)? Devuelve el centro de la caja.
 * Sirve para dos cosas:
 *  - Una lista desplegable nombrada por su valor actual ("Pagada"): el clic va sobre ese valor, no a su lado.
 *    En la corrida del 13/10 (G15), el agente hacía clic en la tabla porque "Pagada" se repetía en 15 filas.
 *  - Un texto dentro de una caja no es una etiqueta: no se busca "su campo" al lado (devolvía la cabecera de la tabla).
 * Caja CERRADA: bordes superior e inferior rectos (14–48 px de alto) y bordes izquierdo y derecho verticales,
 * el izquierdo a menos de 40 px del texto y el derecho a menos de 600 px. Una fila de tabla sin líneas, una
 * etiqueta sobre el fondo de la ventana o un panel alto no son cajas cerradas.
 */
export function fieldContaining(pngBuf: Buffer, r: Rect): { x: number; y: number } | null {
  const k = edgeKit(decode(pngBuf));
  const cx = Math.round(r.x + r.w / 2);
  const cy = Math.round(r.y + r.h / 2);
  const box = k.boxAround(cx, cy);
  if (!box) return null;
  if (r.y < box.top - 3 || r.y + r.h > box.bottom + 3) return null;
  let left = -1;
  for (let x = Math.round(r.x) + 3; x >= Math.max(1, Math.round(r.x) - 40); x--) {
    if (k.vLine(x, box.top, box.bottom)) {
      left = x;
      break;
    }
  }
  if (left < 0) return null;
  // Las letras no forman una línea vertical continua de arriba abajo de la caja; el borde derecho, sí.
  let right = -1;
  for (let x = Math.round(r.x + r.w) + 1; x < Math.min(k.W - 1, left + 600); x++) {
    if (k.vLine(x, box.top, box.bottom)) {
      right = x;
      break;
    }
  }
  if (right < 0) return null;
  return { x: cx, y: Math.round((box.top + box.bottom) / 2) };
}

/**
 * Busca la caja de entrada asociada a una etiqueta, a la derecha (misma fila) y debajo, y devuelve la más cercana.
 * Una caja se confirma por un borde superior e inferior RECTOS y continuos de al menos 50 px (las letras de un
 * texto vecino no forman líneas así) y una altura de 14 a 48 px. Funciona aunque el campo ya tenga texto.
 */
export function findFieldNearLabel(pngBuf: Buffer, label: Rect): { x: number; y: number } | null {
  const { W, H, edgeV, edgeH, hLine, boxAround } = edgeKit(decode(pngBuf));

  const lcy = label.y + label.h / 2;
  // gap = espacio en píxeles entre el borde de la etiqueta y el borde del campo. Se compara el hueco y no la
  // distancia entre centros: con etiquetas largas ("Buscar (nombre o documento):") el centro queda lejos del
  // campo de la derecha y ganaba por error la cabecera de la tabla de abajo (medido en GESTORA, 13/10).
  const candidates: Array<{ x: number; y: number; d: number }> = [];

  // A la derecha, en la fila de la etiqueta: primer borde vertical que abre una caja confirmada.
  const cy = Math.round(lcy);
  for (let x = Math.round(label.x + label.w + 3); x < Math.min(W - 60, label.x + label.w + 420); x++) {
    if (!edgeV(x, cy)) continue;
    const box = boxAround(x + 6, cy, x);
    if (box) {
      const px = x + 25;
      const py = Math.round((box.top + box.bottom) / 2);
      candidates.push({ x: px, y: py, d: x - (label.x + label.w) });
      break;
    }
  }

  // Debajo de la etiqueta: borde superior recto y caja confirmada.
  const sx = Math.round(label.x + Math.min(12, label.w / 3));
  for (let y = Math.round(label.y + label.h + 1); y < Math.min(H - 16, label.y + label.h + 45); y++) {
    if (!edgeH(sx, y) || !hLine(sx, y, 50)) continue;
    const box = boxAround(sx + 8, y + 8);
    if (box) {
      const px = sx + 25;
      const py = Math.round((box.top + box.bottom) / 2);
      // Un campo debajo se usa solo si está claramente más cerca que el de la derecha (+8 px de margen).
      candidates.push({ x: px, y: py, d: y - (label.y + label.h) + 8 });
      break;
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.d - b.d);
  return { x: candidates[0].x, y: candidates[0].y };
}

/**
 * Punto donde escribir o hacer clic cuando el objetivo es un CAMPO nombrado por un texto visible.
 * Es el camino que usa el agente (loop.ts) y el que mide scripts/medir-localizador.ts, sin copias.
 *  1) Etiqueta con su campo al lado. Un texto DENTRO de una caja cerrada (cabecera de tabla, valor de una lista,
 *     texto ya escrito) no es una etiqueta: su "campo al lado" era la cabecera o la tabla.
 *  2) Valor dentro de un campo: lista desplegable nombrada por su valor actual ("Pagada", "Todos"), texto ya
 *     escrito o marcador. En G15 (13/10) "Pagada" estaba en la lista y en 15 filas de la tabla.
 *  3) Sin caja detectada: etiqueta a la izquierda y campo a la derecha (+45 px), lo más común.
 * La visión solo se consulta si quedan varios candidatos igual de buenos.
 */
export async function locateField(
  pngBuf: Buffer,
  matches: TextMatch[],
  vision: () => Promise<{ x: number; y: number } | null>,
  screenWidth: number
): Promise<{ x: number; y: number; via: string }> {
  type Cand = { m: TextMatch; f: { x: number; y: number } };
  const nearest = (list: Cand[], vp: { x: number; y: number }) =>
    list.reduce((a, b) => (Math.hypot(b.f.x - vp.x, b.f.y - vp.y) < Math.hypot(a.f.x - vp.x, a.f.y - vp.y) ? b : a));

  const inside = new Map<TextMatch, { x: number; y: number } | null>();
  const insideOf = (m: TextMatch) => {
    if (!inside.has(m)) inside.set(m, fieldContaining(pngBuf, m.box));
    return inside.get(m)!;
  };

  const labels = matches.filter((m) => !insideOf(m)).slice(0, 6);
  const withField = labels
    .map((m) => ({ m, f: findFieldNearLabel(pngBuf, m.box) }))
    .filter((c): c is Cand => c.f !== null);
  if (withField.length > 0) {
    let pick = withField[0];
    const top = withField.filter((c) => c.m.score >= withField[0].m.score - 0.1);
    if (top.length > 1) {
      const vp = await vision();
      if (vp) pick = nearest(top, vp);
    }
    return { x: pick.f.x, y: pick.f.y, via: `ocr("${pick.m.text}")+campo` };
  }

  const values = matches.map((m) => ({ m, f: insideOf(m) })).filter((c): c is Cand => c.f !== null);
  if (values.length > 0) {
    let pick = values[0];
    if (values.length > 1) {
      const vp = await vision();
      if (vp) pick = nearest(values, vp);
    }
    return { x: pick.f.x, y: pick.f.y, via: `ocr("${pick.m.text}")+dentro` };
  }

  const m = matches[0];
  return {
    x: Math.min(screenWidth - 5, Math.round(m.box.x + m.box.w + 45)),
    y: Math.round(m.box.y + m.box.h / 2),
    via: `ocr("${m.text}")+derecha`,
  };
}

/**
 * ¿Apareció un submenú después de pasar el ratón por una opción de menú en (px,py)?
 * Sí, si cambió un bloque de pantalla que EMPIEZA a la derecha del puntero (un panel nuevo, de 40x16 px o más)
 * y dentro de él se lee al menos una palabra de 3+ letras. Resaltar la opción cambia un bloque que empieza a la
 * izquierda del puntero (todo el ancho del menú), así que no cuenta. Comparar solo palabras no sirve: al releer la
 * zona del menú, el OCR devuelve trozos del texto de fondo ("ESTORA") que parecen nuevos (simulación, 14/10).
 */
export function submenuOpened(beforePng: Buffer, afterPng: Buffer, afterWords: OcrWord[], px: number, py: number): boolean {
  const zonas = changedRegions(beforePng, afterPng);
  if (!zonas) return false;
  return zonas.some(
    (r) =>
      r.x >= px + 15 &&
      r.w >= 40 &&
      r.h >= 16 &&
      Math.abs(r.y + r.h / 2 - py) < 320 &&
      afterWords.some((w) => {
        const cx = w.box.x + w.box.w / 2;
        const cy = w.box.y + w.box.h / 2;
        return (
          normalizeText(w.text).replace(/[^\p{L}]/gu, '').length >= 3 && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h
        );
      })
  );
}

/**
 * Texto de la pantalla en filas (de arriba abajo), para que el planificador lea tablas y copie textos exactos.
 * Une las variantes del OCR quitando duplicados; separa columnas lejanas con " | ".
 */
export function screenTextForPrompt(words: OcrWord[], maxChars = 6000): string {
  const uniq: OcrWord[] = [];
  for (const w of [...words].sort((a, b) => b.conf - a.conf)) {
    const n = normalizeText(w.text);
    if (!n) continue;
    const cx = w.box.x + w.box.w / 2;
    const cy = w.box.y + w.box.h / 2;
    const dup = uniq.some(
      (u) =>
        Math.abs(u.box.x + u.box.w / 2 - cx) < 12 &&
        Math.abs(u.box.y + u.box.h / 2 - cy) < 6 &&
        (normalizeText(u.text) === n || Math.abs(u.box.w - w.box.w) < 8)
    );
    if (!dup) uniq.push(w);
  }
  uniq.sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2));
  // Fila = palabras que se solapan en vertical. Antes se comparaba con el centro de la primera palabra (±6 px) y
  // las letras bajas ("o", "a") caían en otra fila: la etiqueta "Buscar (nombre o documento):" llegaba al
  // planificador como "Buscar (nombre | documento):", el planificador la copiaba y el OCR ya no la encontraba
  // (en la corrida del 13/10 con Sonnet, 17 de las 70 consultas de visión pagadas fueron por esto).
  const rows: Array<{ words: OcrWord[]; top: number; bottom: number }> = [];
  for (const w of uniq) {
    const top = w.box.y;
    const bottom = w.box.y + w.box.h;
    const row = rows.find((r) => {
      const overlap = Math.min(bottom, r.bottom) - Math.max(top, r.top);
      return overlap >= 0.5 * Math.min(w.box.h, r.bottom - r.top);
    });
    if (row) {
      row.words.push(w);
      row.top = Math.min(row.top, top);
      row.bottom = Math.max(row.bottom, bottom);
    } else rows.push({ words: [w], top, bottom });
  }
  const lines: string[] = [];
  for (const { words: r, top, bottom } of rows) {
    r.sort((a, b) => a.box.x - b.box.x);
    let line = '';
    let prevRight = -1;
    for (const w of r) {
      if (prevRight >= 0) line += w.box.x - prevRight > 16 ? ' | ' : ' ';
      line += w.text;
      prevRight = w.box.x + w.box.w;
    }
    lines.push(`y=${Math.round((top + bottom) / 2)}: ${line}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n(...)';
  return out;
}

/**
 * Zonas que cambiaron entre dos capturas del mismo tamaño: celdas de 16x16 con algún píxel distinto,
 * agrupadas en rectángulos (componentes conexas). null si las capturas no son comparables.
 */
export function changedRegions(prevPng: Buffer, curPng: Buffer, tile = 16): Rect[] | null {
  const a = PNG.sync.read(prevPng);
  const b = PNG.sync.read(curPng);
  if (a.width !== b.width || a.height !== b.height) return null;
  const W = a.width;
  const H = a.height;
  const tw = Math.ceil(W / tile);
  const th = Math.ceil(H / tile);
  const changed = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      let diff = false;
      for (let y = ty * tile; y < Math.min(H, (ty + 1) * tile) && !diff; y++) {
        const row = y * W * 4;
        for (let x = tx * tile; x < Math.min(W, (tx + 1) * tile); x++) {
          const i = row + x * 4;
          if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
            diff = true;
            break;
          }
        }
      }
      if (diff) changed[ty * tw + tx] = 1;
    }
  }
  const seen = new Uint8Array(tw * th);
  const regions: Rect[] = [];
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue;
    let minX = tw, minY = th, maxX = -1, maxY = -1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const kx = k % tw;
      const ky = Math.floor(k / tw);
      minX = Math.min(minX, kx); maxX = Math.max(maxX, kx);
      minY = Math.min(minY, ky); maxY = Math.max(maxY, ky);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = kx + dx;
          const ny = ky + dy;
          if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue;
          const n = ny * tw + nx;
          if (changed[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    regions.push({ x: minX * tile, y: minY * tile, w: Math.min(W, (maxX + 1) * tile) - minX * tile, h: Math.min(H, (maxY + 1) * tile) - minY * tile });
  }
  return regions;
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * OCR incremental: si desde la captura anterior solo cambiaron zonas pequeñas (escribir en un campo, abrir una
 * lista, mover el puntero), relee solo esas zonas y conserva el resto de palabras. Las palabras que tocan una zona
 * cambiada se descartan y la zona se amplía para releerlas completas. Si cambió mucho, OCR completo.
 * Devuelve también cómo se hizo, para la bitácora.
 */
export async function ocrIncremental(
  png: Buffer,
  prev: { png: Buffer; words: OcrWord[] } | null
): Promise<{ words: OcrWord[]; modo: 'completo' | 'igual' | 'zonas'; zonas: number }> {
  if (!prev) return { words: await ocrScreenshot(png), modo: 'completo', zonas: 0 };
  const regions = changedRegions(prev.png, png);
  if (!regions) return { words: await ocrScreenshot(png), modo: 'completo', zonas: 0 };
  if (regions.length === 0) return { words: prev.words, modo: 'igual', zonas: 0 };
  const { width: W, height: H } = PNG.sync.read(png);
  // Ampliar cada zona: margen y palabras completas que la tocan.
  const zonas = regions.map((r) => {
    let z: Rect = { x: Math.max(0, r.x - 40), y: Math.max(0, r.y - 6), w: r.w + 80, h: r.h + 12 };
    for (const w of prev.words) {
      if (!intersects(w.box, z)) continue;
      const x1 = Math.min(z.x, w.box.x - 4);
      const y1 = Math.min(z.y, w.box.y - 4);
      const x2 = Math.max(z.x + z.w, w.box.x + w.box.w + 4);
      const y2 = Math.max(z.y + z.h, w.box.y + w.box.h + 4);
      z = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    const x = Math.max(0, Math.round(z.x));
    const y = Math.max(0, Math.round(z.y));
    return { x, y, w: Math.min(W - x, Math.round(z.w)), h: Math.min(H - y, Math.round(z.h)) };
  });
  const area = zonas.reduce((s, z) => s + z.w * z.h, 0);
  if (zonas.length > 8 || area > 0.15 * W * H) return { words: await ocrScreenshot(png), modo: 'completo', zonas: zonas.length };
  const kept = prev.words.filter((w) => !zonas.some((z) => intersects(w.box, z)));
  const nuevas = (await Promise.all(zonas.map((z) => ocrRegion(png, z, 3)))).flat();
  return { words: [...kept, ...nuevas], modo: 'zonas', zonas: zonas.length };
}
