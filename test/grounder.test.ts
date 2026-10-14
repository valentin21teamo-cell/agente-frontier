import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { parseBox, groundTarget, VisionJsonCaller } from '../src/agent/grounder.js';
import { cropAndScale, zoomRect, pngSize } from '../src/agent/imageOps.js';
import { parsePlan } from '../src/agent/openrouter.js';
import { parseKeyCombo, SPECIAL_KEYSYMS } from '../src/rfb/keys.js';

function blankPng(w: number, h: number): Buffer {
  const p = new PNG({ width: w, height: h });
  p.data.fill(200);
  return PNG.sync.write(p);
}

test('parseBox - box_2d normalizado [ymin,xmin,ymax,xmax] a píxeles', () => {
  // Botón "Entendido" medido en [760,450]-[911,511] sobre 1280x800.
  const b = parseBox({ box_2d: [562.5, 593.75, 638.75, 711.72] }, 1280, 800)!;
  assert.ok(Math.abs(b.x - 760) < 1 && Math.abs(b.y - 450) < 1);
  assert.ok(Math.abs(b.x + b.w - 911) < 1 && Math.abs(b.y + b.h - 511) < 1);
});

test('parseBox - listas, point [y,x], píxeles y null', () => {
  assert.ok(parseBox([{ box_2d: [100, 100, 200, 200], label: 'x' }], 1000, 1000));
  const p = parseBox({ point: [500, 250] }, 1000, 1000)!;
  assert.ok(Math.abs(p.x + p.w / 2 - 250) < 1 && Math.abs(p.y + p.h / 2 - 500) < 1);
  const px = parseBox({ box_2d: [450, 760, 511, 1100] }, 1280, 800)!; // >1000 => píxeles
  assert.equal(Math.round(px.x), 760);
  assert.equal(parseBox({ box_2d: null }, 1280, 800), null);
  assert.equal(parseBox('nada', 1280, 800), null);
});

test('imageOps - zoomRect no se sale de la pantalla y cropAndScale amplía', () => {
  const r = zoomRect(1270, 790, 40, 20, 1280, 800);
  assert.ok(r.x + r.w <= 1280 && r.y + r.h <= 800 && r.x >= 0 && r.y >= 0);
  const { png, rect } = cropAndScale(blankPng(1280, 800), { x: 100, y: 50, w: 360, h: 220 }, 2);
  assert.deepEqual(pngSize(png), { width: 720, height: 440 });
  assert.deepEqual(rect, { x: 100, y: 50, w: 360, h: 220 });
});

test('groundTarget - dos pasadas: el zoom refina y se mapea a coordenadas de pantalla', async () => {
  const calls: string[] = [];
  const llm: VisionJsonCaller = {
    async callVisionJson({ text }) {
      calls.push(text.includes('zoomed') ? 'zoom' : 'full');
      if (!text.includes('zoomed')) {
        // Primera pasada algo desviada: centro en (800, 480)
        return { json: { box_2d: [562.5, 593.75, 637.5, 656.25] }, costUsd: 0.001 };
      }
      // Segunda pasada: el elemento está al 35% del ancho del recorte (refina hacia la izquierda)
      return { json: { box_2d: [450, 300, 550, 400] }, costUsd: 0.001 };
    },
  };
  const out = await groundTarget(llm, blankPng(1280, 800), "botón 'Entendido'", 1280, 800);
  assert.deepEqual(calls, ['full', 'zoom']);
  assert.equal(out.via, 'zoom');
  assert.ok(out.point);
  // Recorte de 360x240 centrado en (800,480): x0=620 -> 620 + 0.35*360 = 746; y0=360 -> 360 + 0.5*240 = 480.
  assert.ok(Math.abs(out.point!.x - 746) < 2, `x=${out.point!.x}`);
  assert.ok(Math.abs(out.point!.y - 480) < 3, `y=${out.point!.y}`);
  assert.ok(Math.abs(out.costUsd - 0.002) < 1e-9);
});

test('groundTarget - si el zoom devuelve todo el recorte, usa la primera pasada; si no lo ve, null', async () => {
  const llm: VisionJsonCaller = {
    async callVisionJson({ text }) {
      if (!text.includes('zoomed')) return { json: { box_2d: [100, 100, 150, 200] }, costUsd: 0 };
      return { json: { box_2d: [0, 0, 1000, 1000] }, costUsd: 0 };
    },
  };
  const out = await groundTarget(llm, blankPng(1280, 800), 'algo', 1280, 800);
  assert.equal(out.via, 'full');
  const none: VisionJsonCaller = { async callVisionJson() { return { json: { box_2d: null }, costUsd: 0 }; } };
  const out2 = await groundTarget(none, blankPng(1280, 800), 'nada', 1280, 800);
  assert.equal(out2.point, null);
});

test('parsePlan - lote, acción suelta, lista y texto con ```json', () => {
  const a = parsePlan('{"pensamiento":"p","acciones":[{"action":"click","objetivo":"Guardar"},{"action":"press_key","key":"Enter"}]}');
  assert.equal(a.acciones.length, 2);
  assert.equal(a.pensamiento, 'p');
  const b = parsePlan('```json\n{"action":"FINISH","resultado":"45"}\n```');
  assert.equal(b.acciones[0].action, 'finish');
  const c = parsePlan('[{"action":"wait","ms":500}]');
  assert.equal(c.acciones[0].action, 'wait');
  assert.throws(() => parsePlan('{"hola":1}'));
});

test('Teclas - alias comunes del modelo', () => {
  assert.equal(parseKeyCombo('esc').keysym, SPECIAL_KEYSYMS.Escape);
  assert.equal(parseKeyCombo('ArrowDown').keysym, SPECIAL_KEYSYMS.Down);
  assert.equal(parseKeyCombo('pagedown').keysym, SPECIAL_KEYSYMS.Page_Down);
  assert.equal(parseKeyCombo('Enter').keysym, SPECIAL_KEYSYMS.Enter);
});

test('Grounder - modelos Claude: piden píxeles y devuelven el punto tal cual (sin escala 0-1000)', async () => {
  const { groundTarget, parsePoint } = await import('../src/agent/grounder.js');
  const { isAnthropicModel } = await import('../src/agent/openrouter.js');
  assert.ok(isAnthropicModel('anthropic/claude-sonnet-5.5'));
  assert.ok(!isAnthropicModel('google/gemini-2.5-flash'));
  assert.deepEqual(parsePoint({ x: 818, y: 435 }, 1280, 800), { x: 818, y: 435 });
  assert.equal(parsePoint({ x: null, y: null }, 1280, 800), null);
  assert.equal(parsePoint({ x: 1500, y: 10 }, 1280, 800), null, 'fuera de la imagen');
  const prompts: string[] = [];
  const llm = {
    async callVisionJson(p: { model: string; text: string }) {
      prompts.push(p.text);
      return { json: { x: 818, y: 435 }, costUsd: 0.001 };
    },
  };
  const png = (await import('pngjs')).PNG;
  const img = new png({ width: 1280, height: 800 });
  const g = await groundTarget(llm as any, png.sync.write(img), "botón 'Entendido'", 1280, 800, {
    model: 'anthropic/claude-sonnet-5.5',
    zoom: false,
  });
  assert.deepEqual(g.point, { x: 818, y: 435 }, 'un valor < 1000 NO se interpreta como normalizado');
  assert.ok(prompts[0].includes('1280x800 pixels'));
});

test('OpenRouter - a Claude no se le envía modo de razonamiento ni response_format; a Gemini sí', async () => {
  const { OpenRouterClient } = await import('../src/agent/openrouter.js');
  const realFetch = globalThis.fetch;
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const bodies: any[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"x":1,"y":2}' } }], usage: { cost: 0 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const c = new OpenRouterClient();
    await c.callVisionJson({ model: 'anthropic/claude-sonnet-5.5', text: 't', imagePng: Buffer.from('x') });
    await c.callVisionJson({ model: 'google/gemini-2.5-flash', text: 't', imagePng: Buffer.from('x') });
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
  }
  assert.ok(!('reasoning' in bodies[0]) && !('response_format' in bodies[0]), JSON.stringify(bodies[0]));
  assert.ok('reasoning' in bodies[1] && 'response_format' in bodies[1]);
});

test('OpenRouter - planificador con Claude: reglas+formato en el sistema con caché; historial recortado', async () => {
  const { OpenRouterClient } = await import('../src/agent/openrouter.js');
  const realFetch = globalThis.fetch;
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const bodies: any[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const content = JSON.stringify({ pensamiento: 'ok', acciones: [{ action: 'wait', ms: 100 }] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const c = new OpenRouterClient();
    const params = {
      systemPrompt: 'REGLAS',
      taskInstruction: 'tarea',
      screenshotPng: Buffer.from('x'),
      actionHistory: Array.from({ length: 35 }, (_, i) => `acción ${i} ` + 'x'.repeat(400)),
      resolution: { width: 1280, height: 800 },
    };
    await c.decideAction({ ...params, model: 'anthropic/claude-sonnet-5.5' });
    await c.decideAction({ ...params, model: 'google/gemini-2.5-flash' });
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
  }
  const sysClaude = bodies[0].messages[0];
  assert.equal(sysClaude.role, 'system');
  assert.ok(Array.isArray(sysClaude.content) && sysClaude.content[0].cache_control?.type === 'ephemeral');
  assert.ok(sysClaude.content[0].text.startsWith('REGLAS') && sysClaude.content[0].text.includes('"acciones"'), 'formato dentro del sistema');
  const userText = bodies[0].messages[1].content[0].text as string;
  assert.ok(!userText.includes('Acciones disponibles'), 'el formato ya no se repite en cada mensaje');
  assert.ok(!userText.includes('acción 14 '), 'solo las últimas 20 entradas');
  assert.ok(userText.includes('acción 34 ') && !userText.includes('x'.repeat(300)), 'entradas recortadas');
  assert.equal(typeof bodies[1].messages[0].content, 'string', 'Gemini recibe el sistema como texto');
});
