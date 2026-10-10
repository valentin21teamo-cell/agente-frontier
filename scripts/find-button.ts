import fs from 'node:fs';
import { PNG } from 'pngjs';

const buf = fs.readFileSync('captura.png');
const png = PNG.sync.read(buf);

console.log('Dimensiones:', png.width, 'x', png.height);

// Search for the button boundary in the region x: 750..920, y: 440..520
let minX = 9999, maxX = -1, minY = 9999, maxY = -1;

// The modal content background is light gray/white, while the button has a distinct border/background
// Let's sample the background at (800, 440):
const bgIdx = (440 * png.width + 800) * 4;
const bgR = png.data[bgIdx];
const bgG = png.data[bgIdx + 1];
const bgB = png.data[bgIdx + 2];
console.log('Color fondo modal cerca del botón: RGB', bgR, bgG, bgB);

for (let y = 450; y <= 510; y++) {
  for (let x = 760; x <= 910; x++) {
    const idx = (y * png.width + x) * 4;
    const r = png.data[idx];
    const g = png.data[idx + 1];
    const b = png.data[idx + 2];

    // If differs noticeably from modal background
    const diff = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
    if (diff > 30) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

console.log(`Botón "Entendido" detectado:`);
console.log(`  BBox: [x=${minX}, y=${minY}, w=${maxX - minX + 1}, h=${maxY - minY + 1}]`);
console.log(`  Centro geométrico: cx=${(minX + maxX) / 2}, cy=${(minY + maxY) / 2}`);
