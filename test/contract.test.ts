import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app, setTaskRunner } from '../src/server.js';
import { globalTaskStore } from '../src/tasks/store.js';
import { runAgentTask } from '../src/agent/loop.js';

const TEST_TOKEN = 'test-secret-token-12345';
process.env.TEAM_TOKEN = TEST_TOKEN;

function startTestServer(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function stopTestServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    server.close(() => resolve());
  });
}

test('HTTP Contract - GET /health responds 200 without Authorization header', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
  } finally {
    await stopTestServer(server);
  }
});

test('HTTP Contract - /tasks routes enforce Authorization: Bearer <TEAM_TOKEN>', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    // 1. Missing Authorization header
    const res1 = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tarea: 'Test task',
        escritorio: { url: 'wss://desktop/websockify', password: 'p' },
      }),
    });
    assert.equal(res1.status, 401);

    // 2. Wrong Bearer token
    const res2 = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-token',
      },
      body: JSON.stringify({
        tarea: 'Test task',
        escritorio: { url: 'wss://desktop/websockify', password: 'p' },
      }),
    });
    assert.equal(res2.status, 401);

    // 3. GET /tasks/any-id without token
    const res3 = await fetch(`${baseUrl}/tasks/some-uuid`);
    assert.equal(res3.status, 401);
  } finally {
    await stopTestServer(server);
  }
});

test('HTTP Contract - POST /tasks validates required fields and protocols (400 if invalid)', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    // 1. Missing tarea
    const res1 = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        escritorio: { url: 'wss://desktop/websockify', password: 'p' },
      }),
    });
    assert.equal(res1.status, 400);

    // 2. Missing escritorio.url
    const res2 = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        tarea: 'Editar cliente',
        escritorio: { password: 'p' },
      }),
    });
    assert.equal(res2.status, 400);

    // 3. Invalid URL protocol (not ws:// or wss://)
    const res3 = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        tarea: 'Editar cliente',
        escritorio: { url: 'http://desktop/websockify', password: 'p' },
      }),
    });
    assert.equal(res3.status, 400);

    // 4. Missing or invalid escritorio.password (must be string)
    const res4 = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        tarea: 'Editar cliente',
        escritorio: { url: 'wss://desktop/websockify' }, // missing password
      }),
    });
    assert.equal(res4.status, 400);
  } finally {
    await stopTestServer(server);
  }
});

test('HTTP Contract - "/" and "/status" do not leak tasks, summaries, or secrets', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const resRoot = await fetch(`${baseUrl}/`);
    assert.equal(resRoot.status, 200);
    const bodyRoot = await resRoot.json();
    assert.deepEqual(Object.keys(bodyRoot).sort(), ['health_endpoint', 'service', 'status']);
    assert.ok(!('tasks' in bodyRoot));
    assert.ok(!('env' in bodyRoot));

    const resStatus = await fetch(`${baseUrl}/status`);
    assert.equal(resStatus.status, 200);
    const bodyStatus = await resStatus.json();
    assert.deepEqual(Object.keys(bodyStatus).sort(), ['active_tasks', 'ok', 'total_tasks', 'uptime_seconds']);
    assert.ok(!('tasks' in bodyStatus));
    assert.ok(!('resumen' in bodyStatus));
  } finally {
    await stopTestServer(server);
  }
});

test('HTTP Contract - POST /tasks creates task in < 2s and GET /tasks/:id reflects lifecycle', async () => {
  globalTaskStore.clearForTesting();
  const { server, baseUrl } = await startTestServer();

  try {
    const desktopSecret = 'SecretVncPass99!';
    let resolveWorker: () => void;
    const workerPromise = new Promise<void>((resolve) => {
      resolveWorker = resolve;
    });

    setTaskRunner(async (task) => {
      await workerPromise;
      globalTaskStore.finalizeTask(
        task.id,
        'terminada',
        `Operación completada con password ${desktopSecret}. Total facturas: 45.`
      );
    });

    const startTime = Date.now();
    const resCreate = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        tarea: 'Verificar facturas vencidas',
        escritorio: {
          url: 'wss://desktop.test/websockify',
          password: desktopSecret,
        },
      }),
    });

    const elapsed = Date.now() - startTime;
    assert.ok(elapsed < 2000, `POST /tasks tardó ${elapsed}ms, debe responder en < 2000ms`);
    assert.equal(resCreate.status, 200);

    const bodyCreate = (await resCreate.json()) as { task_id: string };
    assert.ok(bodyCreate.task_id);
    const taskId = bodyCreate.task_id;

    // Verify GET /tasks/:task_id returns en_curso initially
    const resGet1 = await fetch(`${baseUrl}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(resGet1.status, 200);
    const bodyGet1 = await resGet1.json();
    assert.equal(bodyGet1.estado, 'en_curso');

    // Release worker
    resolveWorker!();
    await new Promise((r) => setTimeout(r, 60));

    // Verify GET /tasks/:task_id returns terminada with sanitized summary
    const resGet2 = await fetch(`${baseUrl}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(resGet2.status, 200);
    const bodyGet2 = await resGet2.json();
    assert.equal(bodyGet2.estado, 'terminada');
    assert.ok(!bodyGet2.resumen.includes(desktopSecret), 'El resumen no debe contener la contraseña del escritorio');
    assert.ok(bodyGet2.resumen.includes('[REDACTADO]'));
    assert.ok(bodyGet2.resumen.includes('Total facturas: 45.'));
  } finally {
    await stopTestServer(server);
    globalTaskStore.clearForTesting();
  }
});

test('HTTP Contract - 20 concurrent POST /tasks with simulated RFB/model isolate states without mixing', async () => {
  globalTaskStore.clearForTesting();
  const { server, baseUrl } = await startTestServer();

  try {
    // Simulated worker: each task takes 30-80ms, producing a unique deterministic result
    setTaskRunner(async (task) => {
      // Simulate RFB frame interaction and model inference latency
      await new Promise((r) => setTimeout(r, 40));
      globalTaskStore.finalizeTask(
        task.id,
        'terminada',
        `Resultado específico para tarea [${task.id}] con instruccion: ${task.tarea}`
      );
    });

    const NUM_TASKS = 20;

    // Launch 20 POST /tasks almost simultaneously
    const postPromises = Array.from({ length: NUM_TASKS }).map(async (_, idx) => {
      const res = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({
          tarea: `Instrucción única número ${idx + 1}`,
          escritorio: {
            url: `wss://desktop-${idx}.test/websockify`,
            password: `pass-${idx}`,
          },
        }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as { task_id: string };
      return { idx, taskId: data.task_id };
    });

    const created = await Promise.all(postPromises);
    assert.equal(created.length, NUM_TASKS);

    // Verify unique IDs
    const idSet = new Set(created.map((c) => c.taskId));
    assert.equal(idSet.size, NUM_TASKS, 'Todos los 20 task_ids deben ser únicos');

    // Poll each task until finished (max 5 seconds)
    const startTime = Date.now();
    while (Date.now() - startTime < 5000) {
      let pending = 0;
      for (const item of created) {
        const res = await fetch(`${baseUrl}/tasks/${item.taskId}`, {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        if (data.estado === 'en_curso') {
          pending++;
        }
      }
      if (pending === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Assert that each task returned strictly ITS OWN result and no cross-mixing
    for (const item of created) {
      const res = await fetch(`${baseUrl}/tasks/${item.taskId}`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.estado, 'terminada', `Tarea ${item.taskId} debió terminar con éxito`);
      assert.ok(
        data.resumen.includes(`[${item.taskId}]`),
        `El resumen debe pertenecer exactamente a ${item.taskId}`
      );
      assert.ok(
        data.resumen.includes(`Instrucción única número ${item.idx + 1}`),
        `El resumen debe contener la instrucción específica de ${item.idx + 1}`
      );
    }
  } finally {
    setTaskRunner(async (task) => {
      await runAgentTask(task);
    });
    await stopTestServer(server);
    globalTaskStore.clearForTesting();
  }
});

test('HTTP Contract - GET /tasks/:task_id returns 404 if task does not exist', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/tasks/non-existent-uuid-1234`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await stopTestServer(server);
  }
});

test('HTTP Contract - When MODEL_ID is missing, server stays up with /health 200 and task ends fallida honestly', async () => {
  const { server, baseUrl } = await startTestServer();
  const originalModel = process.env.MODEL_ID;
  const originalRequire = process.env.REQUIRE_EXPLICIT_MODEL;

  try {
    process.env.REQUIRE_EXPLICIT_MODEL = '1';
    delete process.env.MODEL_ID;

    // Verify /health stays 200
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);

    // Create a task
    const postRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        tarea: 'Probar falta de modelo',
        escritorio: { url: 'ws://fake', password: 'p' },
      }),
    });
    assert.equal(postRes.status, 200);
    const { task_id } = await postRes.json();

    // Wait for task to process
    await new Promise((r) => setTimeout(r, 100));

    // Task must be fallida with honest message
    const pollRes = await fetch(`${baseUrl}/tasks/${task_id}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const pollData = await pollRes.json();
    assert.equal(pollData.estado, 'fallida');
    assert.ok(pollData.resumen.includes('MODEL_ID no configurada'));

    // Server must still be up and healthy
    const healthResAfter = await fetch(`${baseUrl}/health`);
    assert.equal(healthResAfter.status, 200);
  } finally {
    if (originalModel) process.env.MODEL_ID = originalModel;
    if (originalRequire) process.env.REQUIRE_EXPLICIT_MODEL = originalRequire;
    else delete process.env.REQUIRE_EXPLICIT_MODEL;
    await stopTestServer(server);
    globalTaskStore.clearForTesting();
  }
});
