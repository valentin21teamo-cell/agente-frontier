import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/tasks/store.js';

test('TaskStore - Creates task with initial state en_curso and isolated AbortController', () => {
  const store = new TaskStore();
  const task1 = store.createTask({
    tarea: 'Prueba tarea 1',
    escritorio: { url: 'wss://test-desktop/websockify', password: 'pass1' },
  });

  const task2 = store.createTask({
    tarea: 'Prueba tarea 2',
    escritorio: { url: 'wss://test-desktop-2/websockify', password: 'pass2' },
  });

  assert.notEqual(task1.id, task2.id);
  assert.equal(task1.estado, 'en_curso');
  assert.equal(task2.estado, 'en_curso');
  assert.notEqual(task1.abortController, task2.abortController);
  assert.equal(task1.abortController.signal.aborted, false);
  assert.equal(task2.abortController.signal.aborted, false);

  store.clearForTesting();
});

test('TaskStore - State machine transitions and terminal immutability', () => {
  const store = new TaskStore();
  const task = store.createTask({
    tarea: 'Editar cliente',
    escritorio: { url: 'wss://host/websockify', password: 'pass' },
  });

  // Successful transition to terminada
  const ok1 = store.finalizeTask(task.id, 'terminada', 'Cliente editado con éxito');
  assert.equal(ok1, true);

  const publicRecord = store.getTaskPublic(task.id);
  assert.equal(publicRecord?.estado, 'terminada');
  assert.equal(publicRecord?.resumen, 'Cliente editado con éxito');
  assert.equal(task.abortController.signal.aborted, true);

  // Late attempt to change terminada -> fallida must be discarded
  const ok2 = store.finalizeTask(task.id, 'fallida', 'Intento tardío de fallo');
  assert.equal(ok2, false);
  assert.equal(store.getTaskPublic(task.id)?.estado, 'terminada');
  assert.equal(store.getTaskPublic(task.id)?.resumen, 'Cliente editado con éxito');

  store.clearForTesting();
});

test('TaskStore - Discards late actions and triggers registered cleanups', () => {
  const store = new TaskStore();
  const task = store.createTask({
    tarea: 'Verificar facturas',
    escritorio: { url: 'wss://host/websockify', password: 'mypassword' },
  });

  let cleanupCalled = false;
  store.registerCleanup(task.id, () => {
    cleanupCalled = true;
  });

  store.finalizeTask(task.id, 'fallida', 'Contraseña incorrecta: mypassword');

  assert.equal(cleanupCalled, true);
  // Summary should be sanitized
  const publicRecord = store.getTaskPublic(task.id);
  assert.ok(!publicRecord?.resumen.includes('mypassword'));
  assert.ok(publicRecord?.resumen.includes('[REDACTADO]'));

  store.clearForTesting();
});

test('TaskStore - Enqueues excess tasks and drains in FIFO order without rejecting', async () => {
  process.env.MAX_CONCURRENT_TASKS = '2';
  const store = new TaskStore();

  const startedOrder: string[] = [];
  store.setWorkerRunner(async (t) => {
    startedOrder.push(t.id);
  });

  const t1 = store.createTask({ tarea: 'T1', escritorio: { url: 'wss://h/websockify', password: 'p' } });
  const t2 = store.createTask({ tarea: 'T2', escritorio: { url: 'wss://h/websockify', password: 'p' } });
  const t3 = store.createTask({ tarea: 'T3', escritorio: { url: 'wss://h/websockify', password: 'p' } });
  const t4 = store.createTask({ tarea: 'T4', escritorio: { url: 'wss://h/websockify', password: 'p' } });

  // 2 running, 2 queued
  assert.equal(store.getRunningCount(), 2);
  assert.equal(store.getQueueLength(), 2);
  assert.equal(store.getActiveCount(), 4);

  // Finalize t1 -> t3 should be dequeued and started
  store.finalizeTask(t1.id, 'terminada', 'T1 lista');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(store.getRunningCount(), 2);
  assert.equal(store.getQueueLength(), 1);
  assert.ok(startedOrder.includes(t3.id), 't3 debió arrancar al desocuparse t1');

  // Finalize t2 -> t4 should be dequeued and started
  store.finalizeTask(t2.id, 'terminada', 'T2 lista');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(store.getRunningCount(), 2);
  assert.equal(store.getQueueLength(), 0);
  assert.ok(startedOrder.includes(t4.id), 't4 debió arrancar al desocuparse t2');

  store.clearForTesting();
  delete process.env.MAX_CONCURRENT_TASKS;
});

test('TaskStore - Halts with fallida when max steps reached', () => {
  process.env.MAX_STEPS = '3';
  const store = new TaskStore();
  const task = store.createTask({
    tarea: 'Pocos pasos',
    escritorio: { url: 'wss://h/websockify', password: 'testpassword' },
  });

  store.incrementStep(task.id); // 1
  store.incrementStep(task.id); // 2
  assert.equal(store.getTaskPublic(task.id)?.estado, 'en_curso');

  store.incrementStep(task.id); // 3 (alcanza el límite)
  assert.equal(store.getTaskPublic(task.id)?.estado, 'fallida');
  assert.ok(store.getTaskPublic(task.id)?.resumen.includes('Límite máximo de pasos'));

  store.clearForTesting();
  delete process.env.MAX_STEPS;
});
