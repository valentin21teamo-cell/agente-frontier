/**
 * Script de Captura de Pantalla VNC (scripts/shot.ts)
 * Conecta a DESKTOP_WS_URL con DESKTOP_PASSWORD,
 * lee la resolución exacta de ServerInit,
 * guarda la captura en PNG y reporta los detalles.
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

  safeLogger.info(`[shot.ts] Iniciando conexión con ${wsUrl}...`, password);

  const client = new RfbClient({
    url: wsUrl,
    password: password,
  });

  try {
    const initInfo = await client.connect();
    safeLogger.info(`[shot.ts] Handshake exitoso.`);
    safeLogger.info(`[shot.ts] Resolución de ServerInit: ${initInfo.width}x${initInfo.height}`);
    safeLogger.info(`[shot.ts] Escritorio: "${initInfo.serverName}"`);

    // Esperar primer fotograma completo del framebuffer
    await client.waitForFirstFrame(10000);
    // Espera de asentamiento para repintado completo
    await new Promise((r) => setTimeout(r, 1200));

    // Captura en PNG
    const pngBuffer = await client.captureScreenshotPng();
    const outputPath = path.resolve('captura.png');
    fs.writeFileSync(outputPath, pngBuffer);

    safeLogger.info(`[shot.ts] Captura guardada con éxito en ${outputPath} (${pngBuffer.length} bytes)`);

    console.log(JSON.stringify({
      ok: true,
      ancho: initInfo.width,
      alto: initInfo.height,
      nombre_servidor: initInfo.serverName,
      archivo: 'captura.png',
      bytes: pngBuffer.length,
    }, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLogger.error(`[shot.ts] Error al conectar o capturar: ${msg}`, password);
    console.error(JSON.stringify({
      ok: false,
      error: msg,
    }, null, 2));
    process.exit(1);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  safeLogger.error(`Error no controlado: ${err}`);
  process.exit(1);
});
