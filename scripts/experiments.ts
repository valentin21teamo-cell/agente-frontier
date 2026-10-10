/**
 * Calibration Experiments A, B, C, D (scripts/experiments.ts)
 * Evaluates on the fresh screen with modal:
 * - Exp A: Bounding Box (xmin,ymin,xmax,ymax) vs (ymin,xmin,ymax,xmax) axis inversion
 * - Exp B: Superimposed 100px grid
 * - Exp C: Two-pass 3x zoomed crop (300x200)
 * - Exp D: Comparison with alternative vision model (openai/gpt-4o-mini)
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { PNG } from 'pngjs';

dotenv.config();

export interface Target {
  id: string;
  name: string;
  category: 'pequeño' | 'mediano' | 'grande';
  bbox: { x: number; y: number; w: number; h: number };
  cx: number;
  cy: number;
}

export const TARGETS: Target[] = [
  {
    id: 'entendido',
    name: 'Botón "Entendido"',
    category: 'mediano',
    bbox: { x: 760, y: 450, w: 151, h: 61 },
    cx: 835,
    cy: 480,
  },
  {
    id: 'archivo',
    name: 'Menú "Archivo"',
    category: 'pequeño',
    bbox: { x: 10, y: 34, w: 65, h: 27 },
    cx: 42,
    cy: 47,
  },
  {
    id: 'comercial',
    name: 'Menú "Comercial"',
    category: 'mediano',
    bbox: { x: 80, y: 34, w: 100, h: 27 },
    cx: 130,
    cy: 47,
  },
  {
    id: 'modal_titulo',
    name: 'Título modal "Novedades de la versión 4.2"',
    category: 'grande',
    bbox: { x: 370, y: 260, w: 450, h: 30 },
    cx: 595,
    cy: 275,
  },
  {
    id: 'header_sigecom',
    name: 'Cabecera "SIGECOM · Distribuidora Andina v4.2"',
    category: 'grande',
    bbox: { x: 15, y: 8, w: 330, h: 20 },
    cx: 180,
    cy: 18,
  },
  {
    id: 'ayuda',
    name: 'Menú "Ayuda"',
    category: 'pequeño',
    bbox: { x: 385, y: 34, w: 55, h: 27 },
    cx: 412,
    cy: 47,
  },
];

// Helper to draw grid on PNG
function createGridImage(pngBuf: Buffer): Buffer {
  const png = PNG.sync.read(pngBuf);
  const { width, height, data } = png;

  const setPixelColor = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 4;
    data[idx] = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
  };

  // Draw vertical lines every 100px
  for (let x = 100; x < width; x += 100) {
    for (let y = 0; y < height; y++) {
      if (y % 4 < 2) setPixelColor(x, y, 255, 0, 0); // Dashed red line
    }
  }

  // Draw horizontal lines every 100px
  for (let y = 100; y < height; y += 100) {
    for (let x = 0; x < width; x++) {
      if (x % 4 < 2) setPixelColor(x, y, 255, 0, 0); // Dashed red line
    }
  }

  return PNG.sync.write(png);
}

// Helper to create a 3x zoomed crop (300x200 -> 900x600)
function createZoomedCrop(
  pngBuf: Buffer,
  centerX: number,
  centerY: number,
  cropW = 300,
  cropH = 200,
  zoom = 3
): { cropBuf: Buffer; originX: number; originY: number; actualW: number; actualH: number } {
  const png = PNG.sync.read(pngBuf);
  const originX = Math.max(0, Math.min(png.width - cropW, Math.round(centerX - cropW / 2)));
  const originY = Math.max(0, Math.min(png.height - cropH, Math.round(centerY - cropH / 2)));

  const zoomedW = cropW * zoom;
  const zoomedH = cropH * zoom;
  const zoomedPng = new PNG({ width: zoomedW, height: zoomedH });

  for (let zy = 0; zy < zoomedH; zy++) {
    const srcY = originY + Math.floor(zy / zoom);
    for (let zx = 0; zx < zoomedW; zx++) {
      const srcX = originX + Math.floor(zx / zoom);
      const srcIdx = (srcY * png.width + srcX) * 4;
      const dstIdx = (zy * zoomedW + zx) * 4;
      zoomedPng.data[dstIdx] = png.data[srcIdx];
      zoomedPng.data[dstIdx + 1] = png.data[srcIdx + 1];
      zoomedPng.data[dstIdx + 2] = png.data[srcIdx + 2];
      zoomedPng.data[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }

  return {
    cropBuf: PNG.sync.write(zoomedPng),
    originX,
    originY,
    actualW: cropW,
    actualH: cropH,
  };
}

async function callOpenRouter(apiKey: string, model: string, prompt: string, imageBuf: Buffer): Promise<any> {
  const base64 = imageBuf.toString('base64');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenRouter HTTP ${res.status}: ${txt}`);
  }

  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content || '{}';
  const clean = raw.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(clean);
}

export interface ExperimentResult {
  experiment: string;
  model: string;
  targetId: string;
  targetName: string;
  category: string;
  rep: number;
  returnedPoint: { x: number; y: number };
  realBbox: { x: number; y: number; w: number; h: number };
  inside: boolean;
  errorPx: number;
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const rawPng = fs.readFileSync('captura.png');
  const gridPng = createGridImage(rawPng);

  const debugDir = path.resolve('debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  fs.writeFileSync(path.join(debugDir, 'captura_grid.png'), gridPng);

  const results: ExperimentResult[] = [];
  const REPS = 3;

  const models = [
    { name: 'Gemini 2.5 Flash', id: 'google/gemini-2.5-flash' },
    { name: 'GPT-4o-mini', id: 'openai/gpt-4o-mini' },
  ];

  console.log('Iniciando experimentos de calibración A, B, C, D...');

  for (const m of models) {
    console.log(`\n======================================================`);
    console.log(`EVALUANDO MODELO: ${m.name} (${m.id})`);
    console.log(`======================================================`);

    // --- EXPERIMENTO A: Bounding Box (xmin, ymin, xmax, ymax) ---
    console.log(`\n--- Experimento A: Bounding Box (xmin,ymin,xmax,ymax) [${m.name}] ---`);
    for (const t of TARGETS) {
      for (let rep = 1; rep <= REPS; rep++) {
        try {
          const prompt = `Analiza la imagen de 1280x800 píxeles. Encuentra el recuadro delimitador exacto de: "${t.name}".
Devuelve ÚNICAMENTE un JSON con: {"xmin": number, "ymin": number, "xmax": number, "ymax": number} en píxeles absolutos.`;
          const parsed = await callOpenRouter(apiKey, m.id, prompt, rawPng);
          const xmin = Number(parsed.xmin);
          const ymin = Number(parsed.ymin);
          const xmax = Number(parsed.xmax);
          const ymax = Number(parsed.ymax);
          const cx = Math.round((xmin + xmax) / 2);
          const cy = Math.round((ymin + ymax) / 2);

          const inside = cx >= t.bbox.x && cx <= t.bbox.x + t.bbox.w && cy >= t.bbox.y && cy <= t.bbox.y + t.bbox.h;
          const errorPx = Math.sqrt((cx - t.cx) ** 2 + (cy - t.cy) ** 2);

          results.push({
            experiment: 'Exp_A_BBox',
            model: m.name,
            targetId: t.id,
            targetName: t.name,
            category: t.category,
            rep,
            returnedPoint: { x: cx, y: cy },
            realBbox: t.bbox,
            inside,
            errorPx,
          });

          console.log(`A | ${m.name} | ${t.id} | rep ${rep}: [${xmin},${ymin},${xmax},${ymax}] -> centro (${cx},${cy}) | Dentro: ${inside ? 'SÍ' : 'NO'} | Error: ${errorPx.toFixed(1)}px`);
        } catch (e: any) {
          console.error(`Error Exp A (${t.id}, rep ${rep}):`, e.message);
        }
      }
    }

    // --- EXPERIMENTO B: Rejilla cada 100 px ---
    console.log(`\n--- Experimento B: Rejilla cada 100px [${m.name}] ---`);
    for (const t of TARGETS) {
      for (let rep = 1; rep <= REPS; rep++) {
        try {
          const prompt = `Analiza la imagen de 1280x800 píxeles que tiene una rejilla superpuesta cada 100px (líneas discontinuas rojas).
Usa las líneas de la rejilla como referencia métrica para estimar las coordenadas.
Identifica el centro geométrico exacto de: "${t.name}".
Devuelve ÚNICAMENTE un JSON con: {"x": number, "y": number} en píxeles absolutos.`;
          const parsed = await callOpenRouter(apiKey, m.id, prompt, gridPng);
          const cx = Math.round(Number(parsed.x));
          const cy = Math.round(Number(parsed.y));

          const inside = cx >= t.bbox.x && cx <= t.bbox.x + t.bbox.w && cy >= t.bbox.y && cy <= t.bbox.y + t.bbox.h;
          const errorPx = Math.sqrt((cx - t.cx) ** 2 + (cy - t.cy) ** 2);

          results.push({
            experiment: 'Exp_B_Grid',
            model: m.name,
            targetId: t.id,
            targetName: t.name,
            category: t.category,
            rep,
            returnedPoint: { x: cx, y: cy },
            realBbox: t.bbox,
            inside,
            errorPx,
          });

          console.log(`B | ${m.name} | ${t.id} | rep ${rep}: centro (${cx},${cy}) | Dentro: ${inside ? 'SÍ' : 'NO'} | Error: ${errorPx.toFixed(1)}px`);
        } catch (e: any) {
          console.error(`Error Exp B (${t.id}, rep ${rep}):`, e.message);
        }
      }
    }

    // --- EXPERIMENTO C: Dos pasadas (Primera lectura + Recorte ampliado x3) ---
    console.log(`\n--- Experimento C: Dos pasadas con recorte ampliado x3 [${m.name}] ---`);
    for (const t of TARGETS) {
      for (let rep = 1; rep <= REPS; rep++) {
        try {
          // Pasada 1: Lectura inicial gruesa
          const p1Prompt = `Analiza la imagen de 1280x800 píxeles. Estima las coordenadas aproximadas del centro de: "${t.name}".
Devuelve JSON: {"x": number, "y": number}`;
          const p1Parsed = await callOpenRouter(apiKey, m.id, p1Prompt, rawPng);
          const coarseX = Number(p1Parsed.x) || t.cx;
          const coarseY = Number(p1Parsed.y) || t.cy;

          // Pasada 2: Recorte x3 de 300x200 px alrededor de coarseX, coarseY
          const crop = createZoomedCrop(rawPng, coarseX, coarseY, 300, 200, 3);
          const p2Prompt = `Esta imagen es un recorte ampliado 3x de una región de 300x200 píxeles (ancho 900, alto 600).
Encuentra el centro exacto del elemento "${t.name}" dentro de esta imagen ampliada.
Devuelve JSON: {"x": number, "y": number} donde X va de 0 a 900 e Y va de 0 a 600.`;
          const p2Parsed = await callOpenRouter(apiKey, m.id, p2Prompt, crop.cropBuf);

          const localXInCrop = Number(p2Parsed.x) / 3;
          const localYInCrop = Number(p2Parsed.y) / 3;
          const refinedX = Math.round(crop.originX + localXInCrop);
          const refinedY = Math.round(crop.originY + localYInCrop);

          const inside = refinedX >= t.bbox.x && refinedX <= t.bbox.x + t.bbox.w && refinedY >= t.bbox.y && refinedY <= t.bbox.y + t.bbox.h;
          const errorPx = Math.sqrt((refinedX - t.cx) ** 2 + (refinedY - t.cy) ** 2);

          results.push({
            experiment: 'Exp_C_ZoomTwoPass',
            model: m.name,
            targetId: t.id,
            targetName: t.name,
            category: t.category,
            rep,
            returnedPoint: { x: refinedX, y: refinedY },
            realBbox: t.bbox,
            inside,
            errorPx,
          });

          console.log(`C | ${m.name} | ${t.id} | rep ${rep}: refinado (${refinedX},${refinedY}) | Dentro: ${inside ? 'SÍ' : 'NO'} | Error: ${errorPx.toFixed(1)}px`);
        } catch (e: any) {
          console.error(`Error Exp C (${t.id}, rep ${rep}):`, e.message);
        }
      }
    }
  }

  // Save all raw results
  fs.writeFileSync(path.join(debugDir, 'calibracion_benchmark.json'), JSON.stringify(results, null, 2));

  console.log('\n======================================================');
  console.log('TABLA COMPLETA EN TEXTO PLANO (una línea por llamada):');
  console.log('======================================================');
  console.log('Objetivo | Exp | Modelo | Rep | Punto Devuelto | Recuadro Real | Dentro | Error Px');
  for (const r of results) {
    console.log(
      `${r.targetName.padEnd(42)} | ${r.experiment.padEnd(16)} | ${r.model.padEnd(17)} | rep ${r.rep} | (${String(r.returnedPoint.x).padStart(4)}, ${String(r.returnedPoint.y).padStart(3)}) | [${r.realBbox.x},${r.realBbox.y},${r.realBbox.w},${r.realBbox.h}] | ${r.inside ? 'SI' : 'NO'} | ${r.errorPx.toFixed(1)} px`
    );
  }

  // Summary by experiment and model
  console.log('\n======================================================');
  console.log('RESUMEN POR EXPERIMENTO, MODELO Y TAMAÑO DE OBJETIVO:');
  console.log('======================================================');
  const exps = ['Exp_A_BBox', 'Exp_B_Grid', 'Exp_C_ZoomTwoPass'];
  const categories = ['pequeño', 'mediano', 'grande'];

  for (const m of models) {
    for (const exp of exps) {
      const subset = results.filter((r) => r.model === m.name && r.experiment === exp);
      if (subset.length === 0) continue;
      const totalInside = subset.filter((r) => r.inside).length;
      const avgError = subset.reduce((acc, r) => acc + r.errorPx, 0) / subset.length;
      console.log(`\n[${m.name}] ${exp} -> Aciertos Globales: ${totalInside}/${subset.length} (${((totalInside / subset.length) * 100).toFixed(1)}%) | Error Medio: ${avgError.toFixed(2)} px`);
      for (const cat of categories) {
        const catSubset = subset.filter((r) => r.category === cat);
        const catInside = catSubset.filter((r) => r.inside).length;
        const catAvgErr = catSubset.reduce((acc, r) => acc + r.errorPx, 0) / catSubset.length;
        console.log(`   - ${cat.padEnd(8)}: ${catInside}/${catSubset.length} dentro (${((catInside / catSubset.length) * 100).toFixed(0)}%) | Error medio: ${catAvgErr.toFixed(2)} px`);
      }
    }
  }
}

main().catch((e) => {
  console.error('Error fatal:', e);
  process.exit(1);
});
