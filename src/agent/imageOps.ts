/**
 * Operaciones de imagen para la localización precisa de elementos:
 * recorte de una zona de la pantalla y ampliación (vecino más cercano) para la segunda pasada.
 */

import { PNG } from 'pngjs';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Lee ancho y alto de la cabecera IHDR de un PNG sin decodificarlo. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Ventana de zoom centrada en (cx, cy): unas 4 veces el tamaño del elemento,
 * entre 360x220 y 640x400 píxeles, sin salirse de la pantalla.
 */
export function zoomRect(cx: number, cy: number, boxW: number, boxH: number, screenW: number, screenH: number): Rect {
  const w = Math.min(screenW, clamp(Math.round(boxW * 4), 360, 640));
  const h = Math.min(screenH, clamp(Math.round(boxH * 4), 220, 400));
  const x = clamp(Math.round(cx - w / 2), 0, Math.max(0, screenW - w));
  const y = clamp(Math.round(cy - h / 2), 0, Math.max(0, screenH - h));
  return { x, y, w, h };
}

/** Recorta `rect` del PNG y lo amplía `scale` veces. Devuelve el PNG y el rectángulo efectivo. */
export function cropAndScale(pngBuf: Buffer, rect: Rect, scale: number): { png: Buffer; rect: Rect } {
  const src = PNG.sync.read(pngBuf);
  const x0 = clamp(Math.round(rect.x), 0, src.width - 1);
  const y0 = clamp(Math.round(rect.y), 0, src.height - 1);
  const w = clamp(Math.round(rect.w), 1, src.width - x0);
  const h = clamp(Math.round(rect.h), 1, src.height - y0);
  const s = Math.max(1, Math.round(scale));

  const out = new PNG({ width: w * s, height: h * s });
  for (let y = 0; y < h * s; y++) {
    const sy = y0 + Math.floor(y / s);
    for (let x = 0; x < w * s; x++) {
      const sx = x0 + Math.floor(x / s);
      const si = (sy * src.width + sx) * 4;
      const di = (y * w * s + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return { png: PNG.sync.write(out), rect: { x: x0, y: y0, w, h } };
}
