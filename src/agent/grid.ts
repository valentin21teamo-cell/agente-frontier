/**
 * Grid overlay generator for precise coordinate calibration
 * Draws subtle metric reference lines every 100px with ticks/labels
 */

import { PNG } from 'pngjs';

export function createGridImage(pngBuf: Buffer): Buffer {
  const png = PNG.sync.read(pngBuf);
  const { width, height, data } = png;

  const setPixelColor = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 4;
    data[idx] = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
  };

  // Draw subtle dashed lines every 100px in X
  for (let x = 100; x < width; x += 100) {
    for (let y = 0; y < height; y++) {
      if (y % 6 < 2) {
        setPixelColor(x, y, 220, 50, 50); // Red dashed line
      }
    }
  }

  // Draw subtle dashed lines every 100px in Y
  for (let y = 100; y < height; y += 100) {
    for (let x = 0; x < width; x++) {
      if (x % 6 < 2) {
        setPixelColor(x, y, 220, 50, 50); // Red dashed line
      }
    }
  }

  return PNG.sync.write(png);
}
