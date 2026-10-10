/**
 * Rejilla métrica con etiquetas numéricas "x,y" en cada cruce de líneas (cada 100 px).
 * Las etiquetas dan al modelo un ancla local para estimar coordenadas por interpolación.
 */

import { PNG } from 'pngjs';

// Fuente 3x5 para dígitos y la coma.
const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  ',': ['000', '000', '000', '010', '100'],
};

const SCALE = 2;

export function createGridImage(pngBuf: Buffer): Buffer {
  const png = PNG.sync.read(pngBuf);
  const { width, height, data } = png;

  const setPixel = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 4;
    data[idx] = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
  };

  // Líneas discontinuas rojas cada 100 px.
  for (let x = 100; x < width; x += 100) {
    for (let y = 0; y < height; y++) if (y % 6 < 2) setPixel(x, y, 220, 50, 50);
  }
  for (let y = 100; y < height; y += 100) {
    for (let x = 0; x < width; x++) if (x % 6 < 2) setPixel(x, y, 220, 50, 50);
  }

  // Etiqueta "x,y" junto a cada cruce (esquina inferior derecha del cruce).
  const drawLabel = (text: string, ox: number, oy: number) => {
    const w = text.length * 4 * SCALE + SCALE;
    const h = 5 * SCALE + 2 * SCALE;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) setPixel(ox + xx, oy + yy, 255, 255, 210);
    let cx = ox + SCALE;
    for (const ch of text) {
      const g = GLYPHS[ch];
      if (g) {
        for (let r = 0; r < 5; r++) {
          for (let c = 0; c < 3; c++) {
            if (g[r][c] === '1') {
              for (let sy = 0; sy < SCALE; sy++) {
                for (let sx = 0; sx < SCALE; sx++) setPixel(cx + c * SCALE + sx, oy + SCALE + r * SCALE + sy, 190, 0, 0);
              }
            }
          }
        }
      }
      cx += 4 * SCALE;
    }
  };

  for (let y = 100; y < height; y += 100) {
    for (let x = 100; x < width; x += 100) {
      drawLabel(`${x},${y}`, x + 3, y + 3);
    }
  }

  return PNG.sync.write(png);
}
