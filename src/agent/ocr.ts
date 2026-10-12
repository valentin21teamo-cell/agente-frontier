/**
 * Localización EXACTA por texto (OCR con Tesseract).
 *
 * El modelo de visión acierta QUÉ elemento es, pero sus coordenadas fallan decenas o cientos de píxeles.
 * El OCR devuelve la caja de cada palabra en píxeles reales de la captura, sin IA de por medio.
 * Se corren tres variantes en paralelo y se combinan:
 *   A) gris x2, por bloques (párrafos, etiquetas, tablas)
 *   B) gris x2, texto disperso (barras de menú y etiquetas sueltas)
 *   C) texto claro binarizado x2 (texto blanco sobre botones de color o cabeceras)
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
export function preprocess(pngBuf: Buffer, scale: number, mode: 'gray' | 'light'): Buffer {
  const src = PNG.sync.read(pngBuf);
  const W = src.width;
  const H = src.height;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    lum[i] = 0.299 * src.data[i * 4] + 0.587 * src.data[i * 4 + 1] + 0.114 * src.data[i * 4 + 2];
  }
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
  const variants: Array<{ id: string; scale: number; mode: 'gray' | 'light'; psm: string }> = [
    { id: 'A', scale: 2, mode: 'gray', psm: '6' },
    { id: 'B', scale: 2, mode: 'gray', psm: '11' },
    { id: 'C', scale: 2, mode: 'light', psm: '6' },
  ];
  const tmp = os.tmpdir();
  // Gris (bloques y texto disperso: menús) y binarizada para texto claro sobre botones de color.
  const gray2 = preprocess(pngBuf, 2, 'gray');
  await new Promise((r) => setImmediate(r)); // deja respirar al servidor HTTP entre pasos pesados
  const light2 = preprocess(pngBuf, 2, 'light');
  const results = await Promise.all(
    variants.map(async (v) => {
      const file = path.join(tmp, `ocr-${randomUUID()}.pgm`);
      if (!(await acquireProc(12000))) return [] as OcrWord[];
      try {
        fs.writeFileSync(file, v.mode === 'light' ? light2 : gray2);
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
 * Busca la caja de entrada asociada a una etiqueta: primero a la derecha (misma fila), luego debajo.
 * Una caja se reconoce por un borde vertical (u horizontal) seguido de relleno claro, confirmado por los
 * bordes perpendiculares a pocos píxeles. Funciona aunque el campo ya tenga texto. Devuelve un punto dentro o null.
 */
export function findFieldNearLabel(pngBuf: Buffer, label: Rect): { x: number; y: number } | null {
  const png = PNG.sync.read(pngBuf);
  const W = png.width;
  const H = png.height;
  const L = (x: number, y: number) => {
    const i = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4;
    return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
  };
  const light = (x: number, y: number) => L(x, y) > 200;
  const edgeV = (x: number, y: number) => Math.abs(L(x, y) - L(x - 1, y)) >= 20 || Math.abs(L(x + 1, y) - L(x, y)) >= 20;
  const edgeH = (x: number, y: number) => Math.abs(L(x, y) - L(x, y - 1)) >= 20 || Math.abs(L(x, y + 1) - L(x, y)) >= 20;
  const cy = Math.round(label.y + label.h / 2);

  // A la derecha: borde vertical + 6 px claros + bordes superior e inferior a 4..22 px.
  for (let x = Math.round(label.x + label.w + 3); x < Math.min(W - 30, label.x + label.w + 520); x++) {
    if (!edgeV(x, cy)) continue;
    let pad = true;
    for (let k = 2; k <= 7; k++) if (!light(x + k, cy)) pad = false;
    if (!pad) continue;
    let top = -1;
    let bottom = -1;
    for (let d = 4; d <= 22; d++) {
      if (top < 0 && edgeH(x + 5, cy - d)) top = cy - d;
      if (bottom < 0 && edgeH(x + 5, cy + d)) bottom = cy + d;
    }
    if (top >= 0 && bottom >= 0 && bottom - top >= 12 && bottom - top <= 60) {
      return { x: x + 25, y: Math.round((top + bottom) / 2) };
    }
  }

  // Debajo: borde horizontal + 5 px claros + borde izquierdo o derecho cerca.
  const sx = Math.round(label.x + Math.min(20, label.w / 2));
  for (let y = Math.round(label.y + label.h + 2); y < Math.min(H - 12, label.y + label.h + 50); y++) {
    if (!edgeH(sx, y)) continue;
    let pad = true;
    for (let k = 2; k <= 6; k++) if (!light(sx, y + k)) pad = false;
    if (!pad) continue;
    let bottom = -1;
    for (let d = 10; d <= 50; d++) {
      if (edgeH(sx, y + d)) {
        bottom = y + d;
        break;
      }
    }
    if (bottom > 0) return { x: sx + 20, y: Math.round((y + bottom) / 2) };
  }
  return null;
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
