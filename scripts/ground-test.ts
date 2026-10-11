/**
 * Prueba rápida del localizador contra el escritorio real (≈20 s, ≈US$0.002).
 * Uso: npx tsx scripts/ground-test.ts ["descripción del objetivo"]
 * Requiere en .env: DESKTOP_WS_URL, DESKTOP_PASSWORD, OPENROUTER_API_KEY. Opcional: DESKTOP_HTTP_URL + DESKTOP_TOKEN (hace /__reset).
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { PNG } from 'pngjs';
import { RfbClient } from '../src/rfb/client.js';
import { OpenRouterClient } from '../src/agent/openrouter.js';
import { groundTarget, groundingModel } from '../src/agent/grounder.js';
import { ocrAvailable, ocrScreenshot, findTextMatches, extractTargetText } from '../src/agent/ocr.js';

dotenv.config();

async function main() {
  const objetivo = process.argv[2] || "botón 'Entendido' del diálogo de novedades";
  const http = process.env.DESKTOP_HTTP_URL;
  const token = process.env.DESKTOP_TOKEN;
  if (http && token && process.argv[3] !== '--no-reset') {
    const r = await fetch(`${http}/__reset`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    console.log(`[ground-test] /__reset -> HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 6000));
  }
  const client = new RfbClient({ url: process.env.DESKTOP_WS_URL!, password: process.env.DESKTOP_PASSWORD! });
  await client.connect();
  await client.waitForFirstFrame(60000);
  await new Promise((r) => setTimeout(r, 1500));
  const shot = await client.captureScreenshotPng();

  const wanted = extractTargetText(objetivo);
  if (wanted && (await ocrAvailable())) {
    const t1 = Date.now();
    const m = findTextMatches(await ocrScreenshot(shot), wanted);
    console.log(`[ground-test] OCR "${wanted}":`, m.slice(0, 3).map((x) => `(${Math.round(x.box.x + x.box.w / 2)},${Math.round(x.box.y + x.box.h / 2)}) "${x.text}"`).join(' | ') || 'sin coincidencias', `${Date.now() - t1} ms`);
  } else {
    console.log('[ground-test] OCR no disponible en esta máquina (Tesseract no instalado); en Cloud Run sí lo está.');
  }
  const t0 = Date.now();
  const out = await groundTarget(new OpenRouterClient(), shot, objetivo, client.width, client.height);
  const ms = Date.now() - t0;
  console.log(JSON.stringify({ modelo: groundingModel(), objetivo, punto: out.point, caja: out.box, via: out.via, costo_usd: out.costUsd, ms }, null, 2));

  // Guarda la captura con una cruz roja en el punto localizado.
  if (out.point) {
    const png = PNG.sync.read(shot);
    for (let d = -12; d <= 12; d++) {
      for (const [x, y] of [[out.point.x + d, out.point.y], [out.point.x, out.point.y + d]]) {
        if (x >= 0 && y >= 0 && x < png.width && y < png.height) {
          const i = (y * png.width + x) * 4;
          png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 0;
        }
      }
    }
    fs.mkdirSync('debug', { recursive: true });
    fs.writeFileSync(path.resolve('debug', 'ground-test.png'), PNG.sync.write(png));
    console.log('[ground-test] Imagen con la cruz: debug/ground-test.png');
  }
  if (objetivo.includes('Entendido') && out.point) {
    const dentro = out.point.x >= 760 && out.point.x <= 911 && out.point.y >= 450 && out.point.y <= 511;
    console.log(`[ground-test] ¿Dentro del botón Entendido medido [760,450]-[911,511]? ${dentro ? 'SÍ' : 'NO'}`);
  }
  client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('[ground-test] Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
