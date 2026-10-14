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

/** Busca el texto objetivo en las palabras OCR. Devuelve candidatos ordenados (mejor primero, sin duplicados). */
export function findTextMatches(words: OcrWord[], target: string): TextMatch[] {
  const want = tokens(target);
  if (want.length === 0) return [];
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
        const s = tokenMatch(want[k], lt[i + k]);
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
      const exactCase = slice.map((w) => w.text).join(' ').replace(/[.,:;]+$/, '') === target.trim();
      const score = (q / want.length) * 0.6 + conf * 0.3 + (standalone ? 0.2 : 0) + (exactCase ? 0.1 : 0);
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

/**
 * Busca la caja de entrada asociada a una etiqueta, a la derecha (misma fila) y debajo, y devuelve la más cercana.
 * Una caja se confirma por un borde superior e inferior RECTOS y continuos de al menos 50 px (las letras de un
 * texto vecino no forman líneas así) y una altura de 14 a 48 px. Funciona aunque el campo ya tenga texto.
 */
export function findFieldNearLabel(pngBuf: Buffer, label: Rect): { x: number; y: number } | null {
  const png = PNG.sync.read(pngBuf);
  const W = png.width;
  const H = png.height;
  const L = (x: number, y: number) => {
    const i = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4;
    return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
  };
  const edgeH = (x: number, y: number) => Math.abs(L(x, y) - L(x, y - 1)) >= 18 || Math.abs(L(x, y + 1) - L(x, y)) >= 18;
  const edgeV = (x: number, y: number) => Math.abs(L(x, y) - L(x - 1, y)) >= 18 || Math.abs(L(x + 1, y) - L(x, y)) >= 18;
  /** ¿Hay una línea horizontal continua en y (±1) desde x0 a lo largo de len px? */
  const hLine = (x0: number, y: number, len: number) => {
    let hits = 0;
    let total = 0;
    for (let k = 0; k <= len; k += 3) {
      total++;
      if (edgeH(x0 + k, y) || edgeH(x0 + k, y - 1) || edgeH(x0 + k, y + 1)) hits++;
    }
    return hits / total >= 0.85;
  };
  /** Dado un punto que está dentro de una posible caja, busca sus bordes superior e inferior rectos. */
  const boxAround = (x: number, y: number): { top: number; bottom: number } | null => {
    let top = -1;
    let bottom = -1;
    for (let d = 2; d <= 26; d++) {
      if (top < 0 && y - d > 0 && edgeH(x, y - d) && hLine(x, y - d, 50)) top = y - d;
      if (bottom < 0 && y + d < H - 1 && edgeH(x, y + d) && hLine(x, y + d, 50)) bottom = y + d;
    }
    if (top < 0 || bottom < 0) return null;
    const h = bottom - top;
    return h >= 14 && h <= 48 ? { top, bottom } : null;
  };

  const lcy = label.y + label.h / 2;
  // gap = espacio en píxeles entre el borde de la etiqueta y el borde del campo. Se compara el hueco y no la
  // distancia entre centros: con etiquetas largas ("Buscar (nombre o documento):") el centro queda lejos del
  // campo de la derecha y ganaba por error la cabecera de la tabla de abajo (medido en GESTORA, 13/10).
  const candidates: Array<{ x: number; y: number; d: number }> = [];

  // A la derecha, en la fila de la etiqueta: primer borde vertical que abre una caja confirmada.
  const cy = Math.round(lcy);
  for (let x = Math.round(label.x + label.w + 3); x < Math.min(W - 60, label.x + label.w + 420); x++) {
    if (!edgeV(x, cy)) continue;
    const box = boxAround(x + 6, cy);
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
  const rows: OcrWord[][] = [];
  for (const w of uniq) {
    const cy = w.box.y + w.box.h / 2;
    const row = rows.find((r) => Math.abs(r[0].box.y + r[0].box.h / 2 - cy) < 6);
    if (row) row.push(w);
    else rows.push([w]);
  }
  const lines: string[] = [];
  for (const r of rows) {
    r.sort((a, b) => a.box.x - b.box.x);
    let line = '';
    let prevRight = -1;
    for (const w of r) {
      if (prevRight >= 0) line += w.box.x - prevRight > 16 ? ' | ' : ' ';
      line += w.text;
      prevRight = w.box.x + w.box.w;
    }
    lines.push(`y=${Math.round(r[0].box.y + r[0].box.h / 2)}: ${line}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n(...)';
  return out;
}
