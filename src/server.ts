/**
 * VNC Autonomous Agent HTTP Server
 * Implements strict HTTP contract:
 * - GET /health -> 200 {"ok":true} (no auth required)
 * - POST /tasks -> 200 {"task_id":"<uuid>"} (Bearer TEAM_TOKEN required)
 * - GET /tasks/:task_id -> 200 {"estado":"...","resumen":"..."} (Bearer TEAM_TOKEN required)
 */

import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'node:crypto';
import { globalTaskStore, TaskRecord } from './tasks/store.js';
import { sanitize, safeLogger } from './security/sanitize.js';

dotenv.config();

// Default to calibrated model and coordinate mode if not explicitly overridden
if (!process.env.MODEL_ID && process.env.REQUIRE_EXPLICIT_MODEL !== '1') {
  process.env.MODEL_ID = 'google/gemini-2.5-flash';
}
if (!process.env.COORD_MODE) {
  process.env.COORD_MODE = 'pixels';
}

export const app = express();
app.use(express.json());

import { runAgentTask } from './agent/loop.js';

// Background task runner type
export type TaskRunner = (task: TaskRecord) => Promise<void>;

let activeTaskRunner: TaskRunner = async (task: TaskRecord) => {
  await runAgentTask(task);
};

// Hook store worker runner
globalTaskStore.setWorkerRunner((task) => activeTaskRunner(task));

export function setTaskRunner(runner: TaskRunner): void {
  activeTaskRunner = runner;
  globalTaskStore.setWorkerRunner((task) => activeTaskRunner(task));
}

/**
 * Authentication middleware for /tasks routes.
 * Checks for exact "Authorization: Bearer <TEAM_TOKEN>" match.
 */
export function requireTeamAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const expectedToken = process.env.TEAM_TOKEN?.trim();

  if (!authHeader) {
    res.status(401).json({ error: 'Falta cabecera de autorización' });
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    res.status(401).json({ error: 'Formato de autorización inválido' });
    return;
  }

  const token = parts[1].trim();

  // If TEAM_TOKEN is defined, verify strictly using constant-time comparison
  if (expectedToken) {
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);

    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      res.status(401).json({ error: 'Token inválido' });
      return;
    }
  } else {
    // If no TEAM_TOKEN configured, reject to prevent open server in production
    safeLogger.warn('[Auth] TEAM_TOKEN no está configurado en las variables de entorno');
    res.status(401).json({ error: 'TEAM_TOKEN no configurado en el servidor' });
    return;
  }

  next();
}

/**
 * GET /health
 * Returns 200 {"ok":true} without requiring auth.
 */
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

/**
 * Minimal server status endpoint
 */
app.get('/status', (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    active_tasks: globalTaskStore.getActiveCount(),
    total_tasks: globalTaskStore.getTotalCount(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

/**
 * POST /tasks
 * Creates and launches an autonomous desktop task in the background.
 * Responds in < 2 seconds with {"task_id":"..."}.
 */
app.post('/tasks', requireTeamAuth, (req: Request, res: Response) => {
  const { tarea, instruccion, escritorio } = req.body || {};
  const taskText = tarea || instruccion;

  // Validation: taskText and escritorio.url are mandatory
  if (!taskText || typeof taskText !== 'string' || taskText.trim().length === 0) {
    res.status(400).json({ error: 'Campo "tarea" requerido y no vacío' });
    return;
  }

  if (
    !escritorio ||
    typeof escritorio !== 'object' ||
    typeof escritorio.url !== 'string' ||
    (!escritorio.url.startsWith('ws://') && !escritorio.url.startsWith('wss://'))
  ) {
    res.status(400).json({ error: 'Campo "escritorio.url" requerido y debe iniciar con ws:// o wss://' });
    return;
  }

  if (typeof escritorio.password !== 'string') {
    res.status(400).json({ error: 'Campo "escritorio.password" requerido como string' });
    return;
  }

  try {
    const record = globalTaskStore.createTask({
      tarea: taskText.trim(),
      escritorio: {
        url: escritorio.url.trim(),
        password: escritorio.password,
      },
      debug: Boolean(req.body.debug || process.env.DEBUG_SHOTS === '1'),
    });

    res.status(200).json({ task_id: record.id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: sanitize(msg) });
  }
});

/**
 * GET /tasks/:task_id
 * Returns current status and sanitized summary.
 */
app.get('/tasks/:task_id', requireTeamAuth, (req: Request, res: Response) => {
  const { task_id } = req.params;
  const result = globalTaskStore.getTaskPublic(task_id);

  if (!result) {
    res.status(404).json({ error: 'Tarea no encontrada' });
    return;
  }

  res.status(200).json(result);
});

// Root fallback (clean status)
app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    service: 'vnc-autonomous-agent-server',
    status: 'running',
    health_endpoint: '/health',
  });
});

// Error handling middleware to prevent stack trace leaks
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : 'Error interno';
  const status = (err as { type?: string })?.type === 'entity.parse.failed' ? 400 : 500;
  safeLogger.error(`[UnhandledError] ${msg}`);
  res.status(status).json({ error: sanitize(msg) });
});

// Start server function
export function startServer(port = Number(process.env.PORT) || 3000) {
  return app.listen(port, '0.0.0.0', () => {
    safeLogger.info(`[Server] Servidor iniciado en puerto ${port}`);
  });
}

// Start server only if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('server.ts') ||
  process.argv[1].endsWith('server.js')
);

if (isMain && process.env.NODE_ENV !== 'test') {
  startServer();
}
