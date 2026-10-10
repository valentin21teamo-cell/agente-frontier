/**
 * Calibration Script (scripts/calibrate.ts)
 * 1. Captures practice desktop screen (or uses captura.png)
 * 2. Prompts model (MODEL_ID) for coordinates of an easily identifiable target (e.g. "Clientes" menu)
 * 3. Compares COORD_MODE=pixels vs COORD_MODE=norm1000
 * 4. Draws a red crosshair on the resulting point
 * 5. Saves debug/calibracion.png (and debug/calibracion_pixels.png, debug/calibracion_norm1000.png)
 * 6. NO real clicks are sent.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { PNG } from 'pngjs';
import { RfbClient } from '../src/rfb/client.js';
import { safeLogger } from '../src/security/sanitize.js';

dotenv.config();

function drawRedCross(pngData: Buffer, targetX: number, targetY: number, size = 16): Buffer {
  const png = PNG.sync.read(pngData);
  const { width, height, data } = png;

  const setPixelRed = (px: number, py: number) => {
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const idx = (py * width + px) * 4;
    data[idx] = 255;     // Red
    data[idx + 1] = 0;   // Green
    data[idx + 2] = 0;   // Blue
    data[idx + 3] = 255; // Alpha
  };

  for (let d = -size; d <= size; d++) {
    // Horizontal cross line with 3px stroke
    for (let t = -1; t <= 1; t++) {
      setPixelRed(targetX + d, targetY + t);
    }
    // Vertical cross line with 3px stroke
    for (let t = -1; t <= 1; t++) {
      setPixelRed(targetX + t, targetY + d);
    }
  }

  return PNG.sync.write(png);
}

async function getScreenshot(): Promise<{ buffer: Buffer; width: number; height: number }> {
  // If captura.png exists, read dimensions from it
  if (fs.existsSync('captura.png')) {
    const fileBuf = fs.readFileSync('captura.png');
    const png = PNG.sync.read(fileBuf);
    return { buffer: fileBuf, width: png.width, height: png.height };
  }

  // Otherwise, connect via RFB
  const wsUrl = process.env.DESKTOP_WS_URL!;
  const password = process.env.DESKTOP_PASSWORD!;
  const client = new RfbClient({ url: wsUrl, password });
  try {
    const init = await client.connect();
    await client.waitForFirstFrame(8000);
    await new Promise((r) => setTimeout(r, 1000));
    const buffer = await client.captureScreenshotPng();
    return { buffer, width: init.width, height: init.height };
  } finally {
    client.close();
  }
}

async function queryModelCoordinates(
  apiKey: string,
  modelId: string,
  screenshotBuf: Buffer,
  width: number,
  height: number,
  mode: 'pixels' | 'norm1000'
): Promise<{ x: number; y: number; target: string; reasoning: string }> {
  const base64 = screenshotBuf.toString('base64');

  const modeInstructions =
    mode === 'pixels'
      ? `Devuelve coordenadas EXACTAS EN PÍXELES ABSOLUTOS de la imagen (de 0 a ${width} para X, y de 0 a ${height} para Y).`
      : `Devuelve coordenadas NORMALIZADAS de 0 a 1000 (donde 0 es el borde izquierdo/superior y 1000 es el borde derecho/inferior).`;

  const prompt = `Analiza la captura de pantalla adjunta. La resolución real es ${width}x${height} píxeles.
Identifica el centro geométrico del botón o elemento de menú "Clientes" (o el primer elemento del menú lateral principal que veas si no se llama así).

${modeInstructions}

Devuelve ÚNICAMENTE un objeto JSON válido con este formato:
{
  "target": "Nombre del elemento detectado",
  "x": 123,
  "y": 456,
  "reasoning": "Breve explicación de dónde está ubicado el elemento en la interfaz"
}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64}` },
            },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter HTTP ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('Respuesta vacía del modelo');

  const clean = content.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '').trim();
  const parsed = JSON.parse(clean);
  return {
    x: Number(parsed.x),
    y: Number(parsed.y),
    target: String(parsed.target || 'Elemento'),
    reasoning: String(parsed.reasoning || ''),
  };
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY no configurada');
    process.exit(1);
  }

  const modelId = process.env.MODEL_ID || process.argv[2] || 'google/gemini-2.5-flash';
  console.log(`[Calibrate] Usando MODEL_ID: ${modelId}`);

  // Create debug directory
  const debugDir = path.resolve('debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }

  // 1. Get screenshot
  console.log('[Calibrate] Obteniendo captura de pantalla del escritorio...');
  const { buffer: screenshotBuf, width, height } = await getScreenshot();
  console.log(`[Calibrate] Imagen obtenida: ${width}x${height} píxeles.`);

  // 2. Test COORD_MODE = pixels
  console.log('\n--- Probando COORD_MODE = pixels ---');
  const resPixels = await queryModelCoordinates(apiKey, modelId, screenshotBuf, width, height, 'pixels');
  console.log(`El modelo devolvió en modo pixels: x=${resPixels.x}, y=${resPixels.y} (target: "${resPixels.target}")`);
  console.log(`Explicación: ${resPixels.reasoning}`);

  const crossPixels = drawRedCross(screenshotBuf, Math.round(resPixels.x), Math.round(resPixels.y));
  const pixelsPath = path.join(debugDir, 'calibracion_pixels.png');
  fs.writeFileSync(pixelsPath, crossPixels);
  console.log(`Guardado en: ${pixelsPath}`);

  // 3. Test COORD_MODE = norm1000
  console.log('\n--- Probando COORD_MODE = norm1000 ---');
  const resNorm = await queryModelCoordinates(apiKey, modelId, screenshotBuf, width, height, 'norm1000');
  const mappedNormX = Math.round((resNorm.x / 1000) * width);
  const mappedNormY = Math.round((resNorm.y / 1000) * height);
  console.log(`El modelo devolvió en modo norm1000: x=${resNorm.x}, y=${resNorm.y}`);
  console.log(`Convertido a píxeles (${width}x${height}): x=${mappedNormX}, y=${mappedNormY} (target: "${resNorm.target}")`);
  console.log(`Explicación: ${resNorm.reasoning}`);

  const crossNorm = drawRedCross(screenshotBuf, mappedNormX, mappedNormY);
  const normPath = path.join(debugDir, 'calibracion_norm1000.png');
  fs.writeFileSync(normPath, crossNorm);
  console.log(`Guardado en: ${normPath}`);

  // Copy best/primary result to debug/calibracion.png
  // Default primary to pixels
  fs.writeFileSync(path.join(debugDir, 'calibracion.png'), crossPixels);

  console.log('\n================================================================');
  console.log('REPORTE DE CALIBRACIÓN:');
  console.log(`Resolución real de pantalla: ${width}x${height}`);
  console.log(`MODO PIXELS:   Coordenada directa (${Math.round(resPixels.x)}, ${Math.round(resPixels.y)})`);
  console.log(`MODO NORM1000: Coordenada original (${resNorm.x}, ${resNorm.y}) -> mapeada a (${mappedNormX}, ${mappedNormY})`);
  console.log(`Diferencia de posición: dx=${Math.abs(Math.round(resPixels.x) - mappedNormX)}, dy=${Math.abs(Math.round(resPixels.y) - mappedNormY)} px`);
  console.log('Capturas generadas en:');
  console.log(` - debug/calibracion.png`);
  console.log(` - debug/calibracion_pixels.png`);
  console.log(` - debug/calibracion_norm1000.png`);
  console.log('================================================================');
}

main().catch((err) => {
  console.error('[Calibrate] Error:', err);
  process.exit(1);
});
