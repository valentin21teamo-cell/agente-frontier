import fs from 'node:fs';
import { PNG } from 'pngjs';

export interface UIElement {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export function detectClickableElements(pngBuf: Buffer): UIElement[] {
  const png = PNG.sync.read(pngBuf);
  const { width, height, data } = png;

  const elements: UIElement[] = [];

  // Helper to get pixel RGB
  const getRGB = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2]];
  };

  // Helper to compute contrast between two pixels
  const diff = (rgb1: number[], rgb2: number[]) => {
    return Math.abs(rgb1[0] - rgb2[0]) + Math.abs(rgb1[1] - rgb2[1]) + Math.abs(rgb1[2] - rgb2[2]);
  };

  // Search horizontal edges: rows with noticeable color boundaries
  // Specifically look for rectangular borders (buttons, menu items, inputs)
  const isEdgePixel = (x: number, y: number) => {
    if (x <= 1 || x >= width - 2 || y <= 1 || y >= height - 2) return false;
    const cur = getRGB(x, y);
    const top = getRGB(x, y - 1);
    const bottom = getRGB(x, y + 1);
    const left = getRGB(x - 1, y);
    const right = getRGB(x + 1, y);
    return diff(cur, top) > 40 || diff(cur, bottom) > 40 || diff(cur, left) > 40 || diff(cur, right) > 40;
  };

  // 1. Detect menubar items (y: 34..61)
  // Menubar is divided horizontally:
  // Let's identify the text/button blocks along y=47
  let inItem = false;
  let startX = 0;
  for (let x = 10; x < 600; x++) {
    // Check if column has non-menubar-background pixels
    let hasContent = false;
    for (let y = 38; y <= 58; y++) {
      const [r, g, b] = getRGB(x, y);
      // menubar bg is ~233, 237, 243
      if (Math.abs(r - 233) > 15 || Math.abs(g - 237) > 15 || Math.abs(b - 243) > 15) {
        hasContent = true;
        break;
      }
    }

    if (hasContent && !inItem) {
      inItem = true;
      startX = x;
    } else if (!hasContent && inItem) {
      inItem = false;
      const w = x - startX;
      if (w >= 15) {
        elements.push({
          x: Math.max(0, startX - 8),
          y: 34,
          w: w + 16,
          h: 27,
          cx: startX + w / 2,
          cy: 47,
        });
      }
    }
  }

  // 2. Detect buttons in modals or dialogs (e.g. Entendido, Guardar, Cancelar)
  // Look for prominent button boxes (distinct background or border, w: 50..220, h: 22..60)
  // Sample along y: 100..750
  for (let y = 100; y < height - 60; y += 4) {
    for (let x = 100; x < width - 100; x += 8) {
      // Check for horizontal border of a button
      const [r, g, b] = getRGB(x, y);
      const [topR, topG, topB] = getRGB(x, y - 2);
      const dTop = Math.abs(r - topR) + Math.abs(g - topG) + Math.abs(b - topB);

      // If top border detected, check if it extends horizontally
      if (dTop > 45) {
        let spanW = 0;
        while (x + spanW < width - 50) {
          const c = getRGB(x + spanW, y);
          const t = getRGB(x + spanW, y - 2);
          if (Math.abs(c[0] - t[0]) + Math.abs(c[1] - t[1]) + Math.abs(c[2] - t[2]) > 35) {
            spanW += 4;
          } else {
            break;
          }
        }

        if (spanW >= 50 && spanW <= 220) {
          // Check height
          let spanH = 0;
          while (y + spanH < height - 10 && spanH < 65) {
            spanH += 4;
            const c = getRGB(x + Math.floor(spanW / 2), y + spanH);
            const btm = getRGB(x + Math.floor(spanW / 2), y + spanH + 2);
            if (Math.abs(c[0] - btm[0]) + Math.abs(c[1] - btm[1]) + Math.abs(c[2] - btm[2]) > 35) {
              break;
            }
          }

          if (spanH >= 20 && spanH <= 65) {
            const candidate: UIElement = {
              x,
              y,
              w: spanW,
              h: spanH,
              cx: x + spanW / 2,
              cy: y + spanH / 2,
            };

            // Avoid duplicates
            const exists = elements.some(
              (e) => Math.abs(e.cx - candidate.cx) < 20 && Math.abs(e.cy - candidate.cy) < 15
            );
            if (!exists) {
              elements.push(candidate);
            }
          }
        }
      }
    }
  }

  return elements;
}

export function snapToNearestElement(
  pngBuf: Buffer,
  proposedX: number,
  proposedY: number,
  maxDistance = 180
): { x: number; y: number; snapped: boolean; element?: UIElement } {
  const elements = detectClickableElements(pngBuf);
  let bestElem: UIElement | null = null;
  let minDistance = 9999;

  for (const elem of elements) {
    // If inside, distance is 0
    const inside =
      proposedX >= elem.x &&
      proposedX <= elem.x + elem.w &&
      proposedY >= elem.y &&
      proposedY <= elem.y + elem.h;

    const dist = inside ? 0 : Math.sqrt((proposedX - elem.cx) ** 2 + (proposedY - elem.cy) ** 2);
    if (dist < minDistance) {
      minDistance = dist;
      bestElem = elem;
    }
  }

  if (bestElem && minDistance <= maxDistance) {
    return {
      x: Math.round(bestElem.cx),
      y: Math.round(bestElem.cy),
      snapped: true,
      element: bestElem,
    };
  }

  return { x: proposedX, y: proposedY, snapped: false };
}

// Quick test
if (process.argv[1]?.endsWith('test-locator.ts') || process.argv[1]?.endsWith('locator.ts')) {
  const buf = fs.readFileSync('debug/antes_clic_entendido.png');
  const elems = detectClickableElements(buf);
  console.log('Detected UI elements count:', elems.length);
  for (const e of elems) {
    console.log(`  Elem [${e.x}, ${e.y}, ${e.w}, ${e.h}] -> Centro: (${e.cx}, ${e.cy})`);
  }

  const snapTest = snapToNearestElement(buf, 650, 600);
  console.log('Snap test from (650, 600):', snapTest);
}
