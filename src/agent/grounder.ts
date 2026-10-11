/**
 * Localizador de elementos ("grounding").
 *
 * El planificador dice QUÉ elemento quiere ("botón 'Guardar' del formulario"); este módulo dice DÓNDE está.
 * Usa el formato nativo de detección de Gemini: box_2d = [ymin, xmin, ymax, xmax] normalizado a 0-1000.
 * Las coordenadas normalizadas no dependen de cómo el proveedor redimensione la imagen, que es la causa
 * probable de los errores de 80-280 px cuando se pedían píxeles directos.
 *
 * Pasada 1: pantalla completa. Pasada 2 (elementos pequeños): recorte ampliado x2 alrededor del resultado.
 */

import { Rect, cropAndScale, zoomRect } from './imageOps.js';

export interface VisionJsonCaller {
  callVisionJson(params: {
    model: string;
    text: string;
    imagePng: Buffer;
    maxTokens?: number;
    abortSignal?: AbortSignal;
  }): Promise<{ json: unknown; costUsd: number }>;
}

export interface GroundOutcome {
  point: { x: number; y: number } | null;
  box: Rect | null;
  via: 'zoom' | 'full' | 'none';
  costUsd: number;
}

export function groundingModel(): string {
  return (process.env.GROUNDING_MODEL_ID || 'google/gemini-2.5-flash').trim();
}

export function groundPrompt(objetivo: string, zoomed: boolean): string {
  return [
    'You are a precise GUI element locator for a desktop business application.',
    zoomed
      ? 'The image is a zoomed-in crop of the screen.'
      : 'The image is a full screenshot of the screen.',
    'Find the single UI element described below and return its bounding box.',
    `Element: ${objetivo}`,
    'If several elements match, choose the one that best matches the visible text and the described location.',
    'Return ONLY JSON: {"box_2d": [ymin, xmin, ymax, xmax]} with integers normalized to 0-1000 relative to this image (y first).',
    'If the element is not visible in this image, return {"box_2d": null}.',
  ].join('\n');
}

/**
 * Convierte la respuesta del modelo a un rectángulo en píxeles de la imagen enviada (imgW x imgH).
 * Acepta {box_2d}, {box}, {bbox}, listas de detecciones, [y,x] en {point}, y valores en píxeles (> 1000).
 */
export function parseBox(json: unknown, imgW: number, imgH: number): Rect | null {
  let raw: unknown = json;
  if (Array.isArray(raw)) {
    if (raw.length === 4 && raw.every((v) => typeof v === 'number')) {
      raw = { box_2d: raw };
    } else {
      raw = raw.find((d) => d && typeof d === 'object') ?? null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  let vals: number[] | null = null;
  const boxLike = obj.box_2d ?? obj.box ?? obj.bbox;
  if (Array.isArray(boxLike) && boxLike.length === 4 && boxLike.every((v) => typeof v === 'number' && isFinite(v))) {
    vals = boxLike as number[];
  } else if (Array.isArray(obj.point) && obj.point.length === 2 && obj.point.every((v) => typeof v === 'number')) {
    const [py, px] = obj.point as number[];
    vals = [py - 5, px - 5, py + 5, px + 5];
  }
  if (!vals) return null;

  let [y1, x1, y2, x2] = vals;
  const pixelMode = Math.max(y1, x1, y2, x2) > 1000;
  if (!pixelMode) {
    y1 = (y1 / 1000) * imgH;
    y2 = (y2 / 1000) * imgH;
    x1 = (x1 / 1000) * imgW;
    x2 = (x2 / 1000) * imgW;
  }
  const left = Math.max(0, Math.min(x1, x2));
  const right = Math.min(imgW, Math.max(x1, x2));
  const top = Math.max(0, Math.min(y1, y2));
  const bottom = Math.min(imgH, Math.max(y1, y2));
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export async function groundTarget(
  llm: VisionJsonCaller,
  screenshotPng: Buffer,
  objetivo: string,
  screenW: number,
  screenH: number,
  opts: { abortSignal?: AbortSignal; zoom?: boolean } = {}
): Promise<GroundOutcome> {
  const model = groundingModel();
  let costUsd = 0;

  // Pasada 1: pantalla completa.
  const first = await llm.callVisionJson({
    model,
    text: groundPrompt(objetivo, false),
    imagePng: screenshotPng,
    abortSignal: opts.abortSignal,
  });
  costUsd += first.costUsd;
  const box1 = parseBox(first.json, screenW, screenH);
  if (!box1) return { point: null, box: null, via: 'none', costUsd };

  // Elementos grandes (zonas, tablas) no necesitan zoom.
  const needsZoom = opts.zoom !== false && (box1.w < 260 || box1.h < 90);
  let finalBox = box1;
  let via: GroundOutcome['via'] = 'full';

  if (needsZoom) {
    const cx = box1.x + box1.w / 2;
    const cy = box1.y + box1.h / 2;
    const scale = 2;
    const { png, rect } = cropAndScale(screenshotPng, zoomRect(cx, cy, box1.w, box1.h, screenW, screenH), scale);
    try {
      const second = await llm.callVisionJson({
        model,
        text: groundPrompt(objetivo, true),
        imagePng: png,
        abortSignal: opts.abortSignal,
      });
      costUsd += second.costUsd;
      const b2 = parseBox(second.json, rect.w * scale, rect.h * scale);
      // Se descarta si ocupa casi todo el recorte (no es específico).
      if (b2 && b2.w < rect.w * scale * 0.95 && b2.h < rect.h * scale * 0.95) {
        finalBox = { x: rect.x + b2.x / scale, y: rect.y + b2.y / scale, w: b2.w / scale, h: b2.h / scale };
        via = 'zoom';
      }
    } catch {
      // Si falla la segunda pasada, se usa la primera.
    }
  }

  return {
    point: { x: Math.round(finalBox.x + finalBox.w / 2), y: Math.round(finalBox.y + finalBox.h / 2) },
    box: finalBox,
    via,
    costUsd,
  };
}
