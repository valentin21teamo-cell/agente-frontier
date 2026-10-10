/**
 * Single Real Click Test on "Entendido" button (scripts/click-entendido.ts)
 * 1. Connects via RFB to the desktop
 * 2. Clicks (840, 482) using the exact actuator (MouseDown, 120ms, MouseUp, 1000ms settling)
 * 3. Captures screenshot to debug/despues_clic_entendido.png
 * 4. Checks if modal closed
 * 5. Executes POST /__reset immediately after
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { PNG } from 'pngjs';
import { RfbClient } from '../src/rfb/client.js';
import { safeLogger } from '../src/security/sanitize.js';

dotenv.config();

async function resetDesktop(): Promise<boolean> {
  const base = process.env.DESKTOP_HTTP_URL;
  const token = process.env.DESKTOP_TOKEN;
  if (!base || !token) throw new Error('DESKTOP_HTTP_URL o DESKTOP_TOKEN no configurados');

  const res = await fetch(`${base}/__reset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as { ok: boolean };
  return data.ok;
}

async function main() {
  const wsUrl = process.env.DESKTOP_WS_URL!;
  const password = process.env.DESKTOP_PASSWORD!;

  console.log('[Click-Entendido] Conectando a escritorio remoto...');
  const client = new RfbClient({ url: wsUrl, password });

  try {
    const init = await client.connect();
    console.log(`[Click-Entendido] Conectado: ${init.width}x${init.height}`);

    await client.waitForFirstFrame(10000);
    await new Promise((r) => setTimeout(r, 1000));

    // Capture before click
    const beforeBuf = await client.captureScreenshotPng();
    const debugDir = path.resolve('debug');
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(path.join(debugDir, 'antes_clic_entendido.png'), beforeBuf);

    // Perform the actuator click on (840, 482)
    console.log('[Click-Entendido] Ejecutando clic en (840, 482) con actuador...');
    await client.mouseClick(840, 482);

    // Settling time already included in mouseClick (1000ms), wait an additional 500ms
    await new Promise((r) => setTimeout(r, 500));

    // Capture after click
    const afterBuf = await client.captureScreenshotPng();
    fs.writeFileSync(path.join(debugDir, 'despues_clic_entendido.png'), afterBuf);

    // Check if modal closed by inspecting color at center of modal (640, 350)
    // When modal is open, center is white/light-gray (dialog box: ~255, 255, 255 or ~248, 248, 248)
    // When modal is closed, center is dark/content-gray (main background: ~216, 221, 230)
    const pngAfter = PNG.sync.read(afterBuf);
    const centerIdx = (350 * pngAfter.width + 640) * 4;
    const r = pngAfter.data[centerIdx];
    const g = pngAfter.data[centerIdx + 1];
    const b = pngAfter.data[centerIdx + 2];
    console.log(`Pixel en centro de pantalla (640, 350) tras el clic: RGB(${r}, ${g}, ${b})`);

    // Button pixel at (840, 482)
    const btnIdx = (482 * pngAfter.width + 840) * 4;
    const btnR = pngAfter.data[btnIdx];
    const btnG = pngAfter.data[btnIdx + 1];
    const btnB = pngAfter.data[btnIdx + 2];
    console.log(`Pixel en (840, 482) tras el clic: RGB(${btnR}, ${btnG}, ${btnB})`);

    const isBackground = r < 230 && g < 230 && b > 215;
    const modalClosed = isBackground || (btnR !== 128 && btnG !== 179 && btnB !== 154);

    console.log(`¿Se cerró el modal?: ${modalClosed ? 'SÍ (CERRADO CON ÉXITO)' : 'NO'}`);

    console.log(JSON.stringify({
      clic_ejecutado: { x: 840, y: 482 },
      modal_cerrado: modalClosed,
      captura_antes: 'debug/antes_clic_entendido.png',
      captura_despues: 'debug/despues_clic_entendido.png',
    }, null, 2));
  } finally {
    client.close();
    console.log('[Click-Entendido] Ejecutando POST /__reset tras la prueba...');
    const ok = await resetDesktop();
    console.log(`[Click-Entendido] Reset completado: ${ok}`);
  }
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
