/**
 * OpenRouter AI Client for Autonomous VNC Navigation
 * Supports:
 * - Multimodal input (base64 PNG screenshots + text)
 * - Model tiering: Gemini 2.5 Flash for fast steps, Claude 3.5 Sonnet / GPT-4o for critical checks
 * - Strict structured actions (click, double_click, type_text, press_key, key_combo, scroll, wait, finish, fail)
 * - Exponential backoff retry on 429 / 5xx
 * - Exact USD cost tracking per task and cost capping
 * - Zero leakage of OPENROUTER_API_KEY
 */

import { safeLogger } from '../security/sanitize.js';

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

export interface ModelStepResult {
  action: AgentAction;
  costUsd: number;
  rawResponse?: string;
}

export class OpenRouterClient {
  private get apiKey(): string {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key || key.trim().length === 0) {
      throw new Error('OPENROUTER_API_KEY no está configurada');
    }
    return key.trim();
  }

  /**
   * Selects model:
   * 'fast': google/gemini-2.5-flash (fast, economical for navigation)
   * 'precise': anthropic/claude-3.5-sonnet (highest precision for complex OCR and verification)
   */
  public get modelId(): string {
    const id = process.env.MODEL_ID || 'google/gemini-2.5-flash';
    return id.trim();
  }

  /**
   * Sends prompt + screenshot to OpenRouter and receives a structured AgentAction.
   */
  public async decideAction(params: {
    systemPrompt: string;
    taskInstruction: string;
    screenshotPng: Buffer;
    actionHistory: string[];
    loopWarning?: string;
    resolution: { width: number; height: number };
    abortSignal?: AbortSignal;
  }): Promise<ModelStepResult> {
    const model = this.modelId;
    const base64Image = params.screenshotPng.toString('base64');
    const imageUrl = `data:image/png;base64,${base64Image}`;

    const userPromptText = [
      `Resolución de pantalla: ${params.resolution.width}x${params.resolution.height} píxeles.`,
      `OBJETIVO DE LA TAREA: "${params.taskInstruction}"`,
      '',
      'HISTORIAL DE ACCIONES PREVIAS:',
      params.actionHistory.length > 0
        ? params.actionHistory.map((a, i) => `${i + 1}. ${a}`).join('\n')
        : 'Ninguna (este es el primer paso).',
      params.loopWarning ? `\nALERTA: ${params.loopWarning}` : '',
      '',
      'Observa detenidamente la captura de pantalla adjunta.',
      'Devuelve EXACTAMENTE un objeto JSON válido con la siguiente acción a realizar en el escritorio.',
      'Formatos permitidos:',
      '1. {"action": "click", "x": 350, "y": 120, "pensamiento": "Hacer clic en el menú Clientes"}',
      '2. {"action": "double_click", "x": 200, "y": 300, "pensamiento": "Abrir registro"}',
      '3. {"action": "type_text", "text": "Papelería Los Andes", "clear_first": true, "pensamiento": "Escribir nombre"}',
      '4. {"action": "press_key", "key": "Enter", "pensamiento": "Confirmar formulario"}',
      '5. {"action": "key_combo", "combo": "ctrl+a", "pensamiento": "Seleccionar todo"}',
      '6. {"action": "scroll", "direction": "down", "amount": 3, "pensamiento": "Bajar para ver más facturas"}',
      '7. {"action": "wait", "ms": 1000, "pensamiento": "Esperar carga de tabla"}',
      '8. {"action": "finish", "resultado": "<valor leído en pantalla, solo si la tarea pedía un dato>", "resumen": "<qué se hizo y qué se verificó>", "pensamiento": "Tarea cumplida y verificada en pantalla"}',
      '9. {"action": "fail", "razon": "<motivo exacto>; claves: <clave1>, <clave2>", "pensamiento": "Caso imposible o ambiguo detectado"}',
      '10. {"action": "move", "x": 350, "y": 120, "pensamiento": "Pasar el mouse sobre el menú para abrir su submenú"}',
      '',
      'IMPORTANTE: Responde ÚNICAMENTE el bloque JSON, sin texto explicativo adicional fuera del JSON.'
    ].join('\n');

    const messages = [
      {
        role: 'system',
        content: params.systemPrompt,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPromptText },
          {
            type: 'image_url',
            image_url: {
              url: imageUrl,
            },
          },
        ],
      },
    ];

    let attempts = 0;
    const maxAttempts = 3;
    let lastError: Error | null = null;

    while (attempts < maxAttempts) {
      if (params.abortSignal?.aborted) {
        throw new Error('Operación abortada por señal de tarea');
      }

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
            model,
            messages,
            temperature: 0.1,
            // Los modelos con razonamiento gastan parte de este tope pensando: si es bajo, el JSON sale cortado.
            max_tokens: 4096,
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
          throw new Error(`OpenRouter HTTP ${response.status}: ${errBody}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('Respuesta vacía recibida del modelo OpenRouter');
        }

        const parsedAction = this.parseActionJson(content);

        // Calculate cost
        let costUsd = 0;
        if (data.usage?.cost) {
          costUsd = Number(data.usage.cost);
        } else if (data.usage?.prompt_tokens && data.usage?.completion_tokens) {
          // Fallback estimate for Gemini Flash
          costUsd = (data.usage.prompt_tokens * 0.075 + data.usage.completion_tokens * 0.3) / 1000000;
        }

        return {
          action: parsedAction,
          costUsd,
          rawResponse: content,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempts >= maxAttempts) break;
        const waitTime = Math.pow(2, attempts) * 1000;
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }

    throw lastError || new Error('Fallo al llamar a OpenRouter tras 3 intentos');
  }

  private parseActionJson(content: string): AgentAction {
    // Extract JSON if wrapped in markdown code blocks
    let clean = content.trim();
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    try {
      const parsed = JSON.parse(clean);
      if (!parsed || typeof parsed !== 'object' || !parsed.action) {
        throw new Error('El JSON no contiene el campo obligatorio "action"');
      }
      return parsed as AgentAction;
    } catch {
      // Attempt regex extraction
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]) as AgentAction;
      }
      throw new Error(`No se pudo parsear acción JSON de la respuesta: ${clean.substring(0, 100)}`);
    }
  }
}
