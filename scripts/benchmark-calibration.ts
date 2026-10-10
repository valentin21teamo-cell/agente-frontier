/**
 * Rigorous Coordinate Calibration Benchmark
 * Evaluates 6 targets x 3 repetitions x 2 modes (pixels vs norm1000)
 * Computes:
 * - Accuracy (% of predictions landing inside the target's bounding box)
 * - Mean error in pixels from geometric center
 * - Draws crosshair (5px thickness) and circle (12px radius) on debug images
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { PNG } from 'pngjs';
import { safeLogger } from '../src/security/sanitize.js';

dotenv.config();

export interface TargetDef {
  id: string;
  name: string;
  promptDesc: string;
  category: 'pequeño' | 'mediano' | 'grande';
  bbox: { x: number; y: number; w: number; h: number }; // Bounding box on 1280x800 image
  cx: number;
  cy: number;
}

export const TARGETS: TargetDef[] = [
  {
    id: 'archivo',
    name: 'Menú "Archivo"',
    promptDesc: 'El elemento o botón de menú "Archivo" en la barra de menú superior',
    category: 'pequeño',
    bbox: { x: 10, y: 34, w: 65, h: 27 },
    cx: 42.5,
    cy: 47.5,
  },
  {
    id: 'comercial',
    name: 'Menú "Comercial"',
    promptDesc: 'El elemento o botón de menú "Comercial" en la barra de menú superior',
    category: 'mediano',
    bbox: { x: 80, y: 34, w: 100, h: 27 },
    cx: 130,
    cy: 47.5,
  },
  {
    id: 'cartera',
    name: 'Menú "Cartera"',
    promptDesc: 'El elemento o botón de menú "Cartera" en la barra de menú superior',
    category: 'mediano',
    bbox: { x: 180, y: 34, w: 85, h: 27 },
    cx: 222.5,
    cy: 47.5,
  },
  {
    id: 'herramientas',
    name: 'Menú "Herramientas"',
    promptDesc: 'El elemento o botón de menú "Herramientas" en la barra de menú superior',
    category: 'mediano',
    bbox: { x: 265, y: 34, w: 120, h: 27 },
    cx: 325,
    cy: 47.5,
  },
  {
    id: 'ayuda',
    name: 'Menú "Ayuda"',
    promptDesc: 'El elemento o botón de menú "Ayuda" en la barra de menú superior',
    category: 'pequeño',
    bbox: { x: 385, y: 34, w: 55, h: 27 },
    cx: 412.5,
    cy: 47.5,
  },
  {
    id: 'titulo_sigecom',
    name: 'Título cabecera "SIGECOM · Distribuidora Andina"',
    promptDesc: 'El texto del título de cabecera "SIGECOM · Distribuidora Andina" en la barra azul superior izquierda',
    category: 'grande',
    bbox: { x: 15, y: 8, w: 290, h: 20 },
    cx: 160,
    cy: 18,
  },
];

export function drawCrossAndCircle(
  pngData: Buffer,
  targetX: number,
  targetY: number,
  crossLength = 22,
  radius = 12
): Buffer {
  const png = PNG.sync.read(pngData);
  const { width, height, data } = png;

  const setPixelRed = (px: number, py: number) => {
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const idx = (py * width + px) * 4;
    data[idx] = 255;     // R
    data[idx + 1] = 0;   // G
    data[idx + 2] = 0;   // B
    data[idx + 3] = 255; // A
  };

  // Cross with thickness 5 (thickness range -2 to +2)
  for (let d = -crossLength; d <= crossLength; d++) {
    for (let t = -2; t <= 2; t++) {
      setPixelRed(targetX + d, targetY + t); // Horizontal
      setPixelRed(targetX + t, targetY + d); // Vertical
    }
  }

  // Circle with radius 12 (thickness 2)
  for (let dy = -radius - 2; dy <= radius + 2; dy++) {
    for (let dx = -radius - 2; dx <= radius + 2; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= radius - 1 && dist <= radius + 1) {
        setPixelRed(targetX + dx, targetY + dy);
      }
    }
  }

  return PNG.sync.write(png);
}

async function queryTarget(
  apiKey: string,
  modelId: string,
  base64Image: string,
  width: number,
  height: number,
  target: TargetDef,
  mode: 'pixels' | 'norm1000'
): Promise<{ x: number; y: number; inside: boolean; errorPx: number }> {
  const modeInstructions =
    mode === 'pixels'
      ? `Devuelve coordenadas EXACTAS EN PÍXELES ABSOLUTOS de la imagen (X entre 0 y ${width}, Y entre 0 y ${height}).`
      : `Devuelve coordenadas NORMALIZADAS entre 0 y 1000 (donde 0 es el borde izquierdo/superior y 1000 es el borde derecho/inferior).`;

  const prompt = `Analiza la captura de pantalla de resolución ${width}x${height} píxeles.
Identifica el centro geométrico del siguiente elemento:
"${target.promptDesc}"

${modeInstructions}

Devuelve ÚNICAMENTE un JSON válido con el formato:
{"x": number, "y": number}`;

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
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } },
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
  const content = json.choices?.[0]?.message?.content?.trim() || '{}';
  const clean = content.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '').trim();
  const parsed = JSON.parse(clean);

  let finalX = Number(parsed.x);
  let finalY = Number(parsed.y);

  if (mode === 'norm1000') {
    finalX = Math.round((finalX / 1000) * width);
    finalY = Math.round((finalY / 1000) * height);
  }

  const inside =
    finalX >= target.bbox.x &&
    finalX <= target.bbox.x + target.bbox.w &&
    finalY >= target.bbox.y &&
    finalY <= target.bbox.y + target.bbox.h;

  const errorPx = Math.sqrt((finalX - target.cx) ** 2 + (finalY - target.cy) ** 2);

  return { x: finalX, y: finalY, inside, errorPx };
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY no configurada');
    process.exit(1);
  }

  const modelId = process.env.MODEL_ID || 'google/gemini-2.5-flash';
  console.log(`[Benchmark] Iniciando calibración con MODEL_ID: "${modelId}"`);

  const debugDir = path.resolve('debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }

  const screenshotBuf = fs.readFileSync('captura.png');
  const png = PNG.sync.read(screenshotBuf);
  const width = png.width;
  const height = png.height;
  const base64Image = screenshotBuf.toString('base64');

  const modes: Array<'pixels' | 'norm1000'> = ['pixels', 'norm1000'];
  const REPETITIONS = 3;

  interface ResultEntry {
    targetId: string;
    targetName: string;
    category: string;
    mode: 'pixels' | 'norm1000';
    rep: number;
    x: number;
    y: number;
    inside: boolean;
    errorPx: number;
  }

  const results: ResultEntry[] = [];

  for (const target of TARGETS) {
    console.log(`\nEvaluando objetivo: [${target.id}] "${target.name}" (${target.category})`);
    console.log(`  BBox real: x=${target.bbox.x}, y=${target.bbox.y}, w=${target.bbox.w}, h=${target.bbox.h} (Centro: ${target.cx}, ${target.cy})`);

    for (const mode of modes) {
      for (let rep = 1; rep <= REPETITIONS; rep++) {
        try {
          const res = await queryTarget(apiKey, modelId, base64Image, width, height, target, mode);
          results.push({
            targetId: target.id,
            targetName: target.name,
            category: target.category,
            mode,
            rep,
            x: res.x,
            y: res.y,
            inside: res.inside,
            errorPx: res.errorPx,
          });

          console.log(`  Modo: ${mode.padEnd(8)} | Rep ${rep}: (${res.x}, ${res.y}) | Dentro: ${res.inside ? 'SÍ' : 'NO'} | Error: ${res.errorPx.toFixed(1)} px`);

          // Draw and save sample on rep 1
          if (rep === 1) {
            const marked = drawCrossAndCircle(screenshotBuf, res.x, res.y);
            const outName = `calibracion_${target.id}_${mode}.png`;
            fs.writeFileSync(path.join(debugDir, outName), marked);
          }
        } catch (e: any) {
          console.error(`  Error en ${target.id} (${mode}, rep ${rep}):`, e.message);
        }
      }
    }
  }

  // Summary by category and mode
  console.log('\n================================================================');
  console.log('RESUMEN DE MEDICIÓN DE CALIBRACIÓN:');
  console.log(`MODEL_ID: ${modelId}`);
  console.log('================================================================');

  for (const mode of modes) {
    const modeResults = results.filter((r) => r.mode === mode);
    const totalCalls = modeResults.length;
    const totalInside = modeResults.filter((r) => r.inside).length;
    const avgError = modeResults.reduce((acc, r) => acc + r.errorPx, 0) / totalCalls;
    const pctInside = ((totalInside / totalCalls) * 100).toFixed(1);

    console.log(`\nMODO: ${mode.toUpperCase()} (Total llamadas: ${totalCalls})`);
    console.log(`  Aciertos dentro del recuadro: ${totalInside}/${totalCalls} (${pctInside}%)`);
    console.log(`  Error medio global: ${avgError.toFixed(2)} px`);

    // By category
    const categories: Array<'pequeño' | 'mediano' | 'grande'> = ['pequeño', 'mediano', 'grande'];
    for (const cat of categories) {
      const catResults = modeResults.filter((r) => r.category === cat);
      if (catResults.length === 0) continue;
      const catInside = catResults.filter((r) => r.inside).length;
      const catAvgErr = catResults.reduce((acc, r) => acc + r.errorPx, 0) / catResults.length;
      console.log(`    - Tamaño ${cat.padEnd(7)}: Aciertos ${catInside}/${catResults.length} (${((catInside / catResults.length) * 100).toFixed(0)}%) | Error medio: ${catAvgErr.toFixed(2)} px`);
    }
  }

  // Save general debug/calibracion.png with the cross of 5px and circle of 12px
  const firstArchivoPixel = results.find((r) => r.targetId === 'archivo' && r.mode === 'pixels');
  if (firstArchivoPixel) {
    const generalImg = drawCrossAndCircle(screenshotBuf, firstArchivoPixel.x, firstArchivoPixel.y);
    fs.writeFileSync(path.join(debugDir, 'calibracion.png'), generalImg);
  }

  // Write full raw results to debug/calibracion_benchmark.json
  fs.writeFileSync(path.join(debugDir, 'calibracion_benchmark.json'), JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
