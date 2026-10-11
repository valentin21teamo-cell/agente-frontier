/**
 * Cliente de OpenRouter para el agente.
 * - Planificador (MODEL_ID): mira la pantalla y devuelve un lote de acciones que nombran su OBJETIVO.
 * - Localizador (GROUNDING_MODEL_ID): devuelve la caja del objetivo (ver grounder.ts).
 * - Reintentos con espera exponencial ante 429/5xx, costo por llamada y la clave nunca en logs.
 */

import { safeLogger } from '../security/sanitize.js';
import { VisionJsonCaller } from './grounder.js';

export type AgentActionType =
  | 'click'
  | 'double_click'
  | 'move'
  | 'type_text'
  | 'press_key'
  | 'key_combo'
  | 'scroll'
  | 'wait'
  | 'finish'
  | 'fail';

export interface AgentAction {
  action: AgentActionType;
  objetivo?: string;
  texto?: string;
  x?: number;
  y?: number;
  text?: string;
  clear_first?: boolean;
  key?: string;
  combo?: string;
  direction?: 'up' | 'down';
  amount?: number;
  ms?: number;
  resultado?: string;
  resumen?: string;
  razon?: string;
  pensamiento?: string;
}

export interface PlannerPlan {
  pensamiento?: string;
  acciones: AgentAction[];
}

export interface PlannerStepResult {
  plan: PlannerPlan;
  costUsd: number;
  rawResponse?: string;
}

/** Extrae JSON de una respuesta que puede venir con ```json ... ``` o texto alrededor. */
export function parseLooseJson(content: string): unknown {
  let clean = content.trim();
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    return JSON.parse(clean);
  } catch {
    const obj = clean.match(/\{[\s\S]*\}/);
    if (obj) {
      try {
        return JSON.parse(obj[0]);
      } catch {
        /* sigue */
      }
    }
    const arr = clean.match(/\[[\s\S]*\]/);
    if (arr) return JSON.parse(arr[0]);
    throw new Error(`No se pudo parsear JSON de la respuesta: ${clean.substring(0, 100)}`);
  }
}

/** Normaliza la respuesta del planificador: lote {acciones:[...]}, acción suelta {action} o lista. */
export function parsePlan(content: string): PlannerPlan {
  const parsed = parseLooseJson(content);
  let pensamiento: string | undefined;
  let list: unknown[] = [];

  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    pensamiento = typeof obj.pensamiento === 'string' ? obj.pensamiento : undefined;
    if (Array.isArray(obj.acciones)) list = obj.acciones;
    else if (Array.isArray(obj.actions)) list = obj.actions;
    else if (typeof obj.action === 'string') list = [obj];
  }

  const acciones = list
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as any).action === 'string')
    .map((a) => ({ ...a, action: String(a.action).toLowerCase().trim() }) as AgentAction);

  if (acciones.length === 0) {
    throw new Error('La respuesta del modelo no contiene acciones válidas');
  }
  return { pensamiento: pensamiento ?? acciones[0].pensamiento, acciones };
}

const ACTION_FORMATS = [
  'Devuelve EXACTAMENTE un objeto JSON con esta forma:',
  '{"pensamiento": "<qué ves y qué harás>", "acciones": [<de 1 a 6 acciones>]}',
  '',
  'Acciones disponibles. En "objetivo" describe QUÉ elemento (tipo y zona) y en "texto" copia EXACTAMENTE el texto visible',
  'del elemento tal como aparece en pantalla (para campos: el texto de su etiqueta). El sistema lo encuentra con OCR',
  'con precisión de píxel: NO calcules coordenadas. Para iconos sin texto, omite "texto" y describe bien el objetivo.',
  '- {"action":"click","objetivo":"botón del diálogo <título>","texto":"<texto del botón>"}',
  '- {"action":"double_click","objetivo":"fila de la tabla <nombre>","texto":"<dato visible en la fila>"}',
  '- {"action":"move","objetivo":"opción del menú <nombre>","texto":"<texto de la opción>"}   (pasa el ratón para abrir submenús)',
  '- {"action":"type_text","objetivo":"campo del formulario <nombre>","texto":"<etiqueta del campo>","text":"<lo que se escribe>","clear_first":true}   (hace clic en el campo, lo limpia y escribe)',
  '- {"action":"type_text","text":"<texto>"}   (escribe en el campo que ya tiene el foco)',
  '- {"action":"press_key","key":"Enter"}   (también Tab, Escape, Down, Up, Page_Down)',
  '- {"action":"key_combo","combo":"ctrl+f"}',
  '- {"action":"scroll","objetivo":"<zona o tabla>","texto":"<algún texto visible de esa zona>","direction":"down","amount":3}',
  '- {"action":"wait","ms":1000}',
  '- {"action":"finish","resultado":"<solo el dato pedido, si la tarea pedía un dato>","resumen":"<qué hiciste y qué verificaste en pantalla>"}',
  '- {"action":"fail","razon":"<motivo exacto>; claves: <identificadores que causan el problema>"}',
  'Opcional: "x" y "y" en píxeles aproximados como pista; el sistema usa primero el objetivo.',
  '',
  'Reglas del lote:',
  '- Agrupa acciones cuando sepas lo que habrá en pantalla (por ejemplo, llenar varios campos de un formulario visible). Máximo 6.',
  '- Si una acción abre un menú, diálogo o pantalla cuyo contenido aún no ves, termina el lote ahí.',
  '- "finish" y "fail" van SOLOS en el lote y solo después de verificar en la captura actual.',
  '- Si un objetivo no se encuentra, el sistema detiene el lote y te lo informa en el historial.',
  '',
  'Responde ÚNICAMENTE el objeto JSON.',
].join('\n');

export class OpenRouterClient implements VisionJsonCaller {
  private get apiKey(): string {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key || key.trim().length === 0) {
      throw new Error('OPENROUTER_API_KEY no está configurada');
    }
    return key.trim();
  }

  public get modelId(): string {
    return (process.env.MODEL_ID || 'google/gemini-2.5-flash').trim();
  }

  /** Llamada genérica con imagen que devuelve el texto y su costo. Reintenta ante 429/5xx y errores de red. */
  private async callVision(params: {
    model: string;
    systemPrompt?: string;
    text: string;
    imagePng: Buffer;
    maxTokens?: number;
    abortSignal?: AbortSignal;
  }): Promise<{ content: string; costUsd: number }> {
    const imageUrl = `data:image/png;base64,${params.imagePng.toString('base64')}`;
    const messages: unknown[] = [];
    if (params.systemPrompt) messages.push({ role: 'system', content: params.systemPrompt });
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: params.text },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    });

    let attempts = 0;
    const maxAttempts = 3;
    let lastError: Error | null = null;

    while (attempts < maxAttempts) {
      if (params.abortSignal?.aborted) throw new Error('Operación abortada por señal de tarea');
      attempts++;
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://vnc-autonomous-agent.local',
            'X-Title': 'VNC Autonomous Agent',
          },
          body: JSON.stringify({
            model: params.model,
            messages,
            temperature: 0.1,
            // Los modelos con razonamiento gastan parte de este tope pensando: si es bajo, el JSON sale cortado.
            max_tokens: params.maxTokens ?? 4096,
            reasoning: { effort: 'low' },
            response_format: { type: 'json_object' },
          }),
          signal: params.abortSignal,
        });

        if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
          const waitTime = Math.pow(2, attempts) * 1000;
          safeLogger.warn(`[OpenRouter] HTTP ${response.status}. Reintentando en ${waitTime}ms (intento ${attempts}/${maxAttempts})...`);
          await new Promise((r) => setTimeout(r, waitTime));
          continue;
        }
        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`OpenRouter HTTP ${response.status}: ${errBody.substring(0, 300)}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('Respuesta vacía recibida del modelo OpenRouter');

        let costUsd = 0;
        if (data.usage?.cost) {
          costUsd = Number(data.usage.cost);
        } else if (data.usage?.prompt_tokens && data.usage?.completion_tokens) {
          costUsd = (data.usage.prompt_tokens * 0.3 + data.usage.completion_tokens * 2.5) / 1000000;
        }
        return { content, costUsd };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (params.abortSignal?.aborted) throw lastError;
        if (attempts >= maxAttempts) break;
        await new Promise((r) => setTimeout(r, Math.pow(2, attempts) * 1000));
      }
    }
    throw lastError || new Error('Fallo al llamar a OpenRouter tras 3 intentos');
  }

  /** Usado por el localizador: devuelve el JSON ya parseado. */
  public async callVisionJson(params: {
    model: string;
    text: string;
    imagePng: Buffer;
    maxTokens?: number;
    abortSignal?: AbortSignal;
  }): Promise<{ json: unknown; costUsd: number }> {
    const { content, costUsd } = await this.callVision({ ...params, maxTokens: params.maxTokens ?? 2048 });
    let json: unknown = null;
    try {
      json = parseLooseJson(content);
    } catch {
      json = null;
    }
    return { json, costUsd };
  }

  /** Planificador: decide el siguiente lote de acciones. */
  public async decideAction(params: {
    systemPrompt: string;
    taskInstruction: string;
    screenshotPng: Buffer;
    actionHistory: string[];
    loopWarning?: string;
    resolution: { width: number; height: number };
    remainingSeconds?: number;
    abortSignal?: AbortSignal;
  }): Promise<PlannerStepResult> {
    const history = params.actionHistory.slice(-30);
    const text = [
      `Resolución de pantalla: ${params.resolution.width}x${params.resolution.height} píxeles.`,
      `OBJETIVO DE LA TAREA: "${params.taskInstruction}"`,
      params.remainingSeconds !== undefined ? `Tiempo restante aproximado: ${params.remainingSeconds} s.` : '',
      '',
      'HISTORIAL DE ACCIONES PREVIAS (con su efecto en pantalla):',
      history.length > 0 ? history.map((a, i) => `${i + 1}. ${a}`).join('\n') : 'Ninguna (este es el primer paso).',
      params.loopWarning ? `\nALERTA: ${params.loopWarning}` : '',
      '',
      'Observa detenidamente la captura de pantalla adjunta (estado ACTUAL).',
      ACTION_FORMATS,
    ].join('\n');

    let lastErr: Error | null = null;
    let totalCost = 0;
    // Hasta 2 intentos si el JSON no se puede interpretar.
    for (let i = 0; i < 2; i++) {
      const { content, costUsd } = await this.callVision({
        model: this.modelId,
        systemPrompt: params.systemPrompt,
        text,
        imagePng: params.screenshotPng,
        abortSignal: params.abortSignal,
      });
      totalCost += costUsd;
      try {
        return { plan: parsePlan(content), costUsd: totalCost, rawResponse: content };
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        safeLogger.warn(`[OpenRouter] Respuesta del planificador no interpretable (intento ${i + 1}/2)`);
      }
    }
    throw lastErr || new Error('El planificador no devolvió acciones válidas');
  }
}
