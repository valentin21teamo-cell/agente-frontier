import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockRfbServer } from './helpers/mockRfb.js';
import { globalTaskStore } from '../src/tasks/store.js';
import { runAgentTask } from '../src/agent/loop.js';

test('Agente E2E - planificador + localizador sobre escritorio RFB simulado', { timeout: 60000 }, async () => {
  const mock = await startMockRfbServer('vncpass1');
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  process.env.MODEL_ID = 'test/planner';
  process.env.GROUNDING_MODEL_ID = 'test/grounder';
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
  process.env.MAX_COST_USD_PER_TASK = '1';

  let plannerCalls = 0;
  let grounderCalls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    if (!String(url).includes('openrouter.ai')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    let content: string;
    if (body.model === 'test/grounder') {
      grounderCalls++;
      const zoomed = JSON.stringify(body.messages).includes('zoomed');
      // Pantalla 640x480: caja normalizada centrada en (320, 240)
      content = zoomed ? '{"box_2d":[400,400,600,600]}' : '```json\n{"box_2d":[475,450,525,550]}\n```';
    } else {
      plannerCalls++;
      content =
        plannerCalls === 1
          ? JSON.stringify({
              pensamiento: 'Cerrar aviso y llenar campo',
              acciones: [
                { action: 'click', objetivo: "botón 'Entendido'" },
                { action: 'type_text', objetivo: "campo 'Nombre'", text: 'Ab1', clear_first: false },
                { action: 'press_key', key: 'esc' },
              ],
            })
          : JSON.stringify({ acciones: [{ action: 'finish', resultado: 'respuesta: 45', resumen: 'Se contaron 45 facturas.' }] });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.001 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  globalTaskStore.setWorkerRunner((t) => runAgentTask(t));
  try {
    const rec = globalTaskStore.createTask({ tarea: 'Prueba E2E', escritorio: { url: mock.wsUrl, password: 'vncpass1' } });
    const t0 = Date.now();
    let pub = globalTaskStore.getTaskPublic(rec.id)!;
    while (pub.estado === 'en_curso' && Date.now() - t0 < 50000) {
      await new Promise((r) => setTimeout(r, 200));
      pub = globalTaskStore.getTaskPublic(rec.id)!;
    }
    assert.equal(pub.estado, 'terminada', pub.resumen);
    assert.ok(pub.resumen.startsWith('respuesta: 45'), pub.resumen);
    assert.ok(!pub.resumen.includes('respuesta: respuesta'), pub.resumen);
    assert.equal(plannerCalls, 2);
    assert.ok(grounderCalls >= 2);
    // El clic llegó al centro localizado (320,240) con botón presionado.
    assert.ok(mock.receivedPointerEvents.some((e) => e.mask === 1 && Math.abs(e.x - 320) <= 2 && Math.abs(e.y - 240) <= 2));
    // Se escribió el texto y se envió Escape (alias "esc").
    assert.ok(mock.receivedKeyEvents.some((k) => k.down && k.keysym === 0xff1b));
    assert.ok(mock.receivedKeyEvents.some((k) => k.down && k.keysym === 'A'.charCodeAt(0)));
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
    globalTaskStore.clearForTesting();
    await mock.close();
  }
});
