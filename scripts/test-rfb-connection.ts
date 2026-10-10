/**
 * Script de verificación de conexión RFB en Fase 2
 * Conecta contra el escritorio de práctica, lee la resolución real de ServerInit,
 * captura el framebuffer a PNG y lo guarda localmente.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { RfbClient } from '../src/rfb/client.js';
import { safeLogger } from '../src/security/sanitize.js';

dotenv.config();

async function main() {
  const wsUrl = process.env.DESKTOP_WS_URL;
  const password = process.env.DESKTOP_PASSWORD;

  if (!wsUrl || !password) {
    safeLogger.error('DESKTOP_WS_URL o DESKTOP_PASSWORD no están configurados en el entorno.');
    process.exit(1);
  }

  safeLogger.info(`[Test RFB] Conectando a escritorio de práctica...`);

  const client = new RfbClient({
    url: wsUrl,
    password: password,
  });

  try {
    const initInfo = await client.connect();
    safeLogger.info(`[Test RFB] Handshake completado exitosamente.`);
    safeLogger.info(`[Test RFB] Resolución leída de ServerInit: ${initInfo.width}x${initInfo.height}`);
    safeLogger.info(`[Test RFB] Nombre del servidor reportado: "${initInfo.serverName}"`);

    safeLogger.info(`[Test RFB] Esperando primer fotograma del framebuffer...`);
    await client.waitForFirstFrame(10000);

    // Wait a brief moment to let initial repaint complete
    await new Promise((r) => setTimeout(r, 1200));

    safeLogger.info(`[Test RFB] Exportando captura a PNG...`);
    const pngBuffer = await client.captureScreenshotPng();

    const outputPath = path.resolve('captura_practica.png');
    fs.writeFileSync(outputPath, pngBuffer);
    safeLogger.info(`[Test RFB] Captura guardada en: ${outputPath} (${pngBuffer.length} bytes)`);

    console.log(JSON.stringify({
      ok: true,
      ancho: initInfo.width,
      alto: initInfo.height,
      nombre_servidor: initInfo.serverName,
      bytes_png: pngBuffer.length,
      archivo_captura: 'captura_practica.png',
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLogger.error(`[Test RFB] Error durante la conexión: ${msg}`, password);
    process.exit(1);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  safeLogger.error(`Error no controlado: ${err}`);
  process.exit(1);
});
