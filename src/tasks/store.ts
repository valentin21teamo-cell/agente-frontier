/**
 * Task In-Memory Store & State Machine
 * Guarantees task isolation, FIFO queueing, strict state transitions, timeouts, and resource cleanup.
 */

import { randomUUID } from 'node:crypto';
import { sanitize, safeLogger } from '../security/sanitize.js';

export type TaskStatus = 'en_curso' | 'terminada' | 'fallida';

export interface DesktopConfig {
  url: string;
  password?: string;
}

export interface TaskRecord {
  id: string;
  tarea: string;
  desktop: DesktopConfig;
  estado: TaskStatus;
  resumen: string;
  createdAt: number;
  finishedAt?: number;
  abortController: AbortController;
  stepCount: number;
  costUsd: number;
  deadlineTimer?: NodeJS.Timeout;
  debug?: boolean;
  cleanupCallbacks: Array<() => Promise<void> | void>;
  /** Bitácora de pasos con tiempos (para diagnóstico; se sanitiza al exponerla). */
  trace?: string[];
}

export type TaskWorkerRunner = (task: TaskRecord) => Promise<void>;

export class TaskStore {
  private tasks = new Map<string, TaskRecord>();
  private activeWorkers = new Set<string>();
  private queue: string[] = [];
  private workerRunner?: TaskWorkerRunner;

  public setWorkerRunner(runner: TaskWorkerRunner): void {
    this.workerRunner = runner;
  }

  private get maxDeadlineMs(): number {
    const envVal = Number(process.env.TASK_DEADLINE_MS);
    return !isNaN(envVal) && envVal > 0 ? envVal : 285000; // 4 min 45 s (el evaluador da 5 min)
  }

  private get maxSteps(): number {
    const envVal = Number(process.env.MAX_STEPS);
    return !isNaN(envVal) && envVal > 0 ? envVal : 40;
  }

  private get maxConcurrentTasks(): number {
    const envVal = Number(process.env.MAX_CONCURRENT_TASKS);
    return !isNaN(envVal) && envVal > 0 ? envVal : 10; // Default 10 per requirement
  }

  /**
   * Returns count of tasks currently in 'en_curso' state (executing or queued).
   */
  public getActiveCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.estado === 'en_curso') {
        count++;
      }
    }
    return count;
  }

  /**
   * Returns count of tasks actively running (not queued).
   */
  public getRunningCount(): number {
    return this.activeWorkers.size;
  }

  /**
   * Returns length of waiting queue.
   */
  public getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Total number of tasks recorded.
   */
  public getTotalCount(): number {
    return this.tasks.size;
  }

  /**
   * Creates and registers a new task.
   * If running tasks < maxConcurrentTasks, execution starts immediately.
   * Otherwise, task is enqueued in FIFO order.
   * Internal deadline is counted from the exact moment of creation (POST /tasks).
   */
  public createTask(params: { tarea: string; escritorio: DesktopConfig; debug?: boolean }): TaskRecord {
    const id = randomUUID();
    const abortController = new AbortController();

    const record: TaskRecord = {
      id,
      tarea: params.tarea,
      desktop: {
        url: params.escritorio.url,
        password: params.escritorio.password,
      },
      estado: 'en_curso',
      resumen: 'Tarea en ejecución...',
      createdAt: Date.now(),
      abortController,
      stepCount: 0,
      costUsd: 0,
      debug: params.debug,
      cleanupCallbacks: [],
    };

    // Schedule internal task deadline counting from arrival time
    const deadlineMs = this.maxDeadlineMs;
    record.deadlineTimer = setTimeout(() => {
      this.handleDeadlineExpiry(id);
    }, deadlineMs);

    this.tasks.set(id, record);

    // Dispatch or enqueue
    this.dispatchOrEnqueue(record);

    return record;
  }

  private dispatchOrEnqueue(record: TaskRecord): void {
    if (this.activeWorkers.size < this.maxConcurrentTasks) {
      this.activeWorkers.add(record.id);
      record.resumen = 'Tarea en ejecución...';
      if (this.workerRunner) {
        setImmediate(() => {
          this.workerRunner!(record).catch((err: unknown) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            safeLogger.error(`[TaskStore] Error en tarea ${record.id}: ${errorMsg}`, record.desktop.password);
            this.finalizeTask(record.id, 'fallida', `Error en ejecución: ${errorMsg}`);
          });
        });
      }
    } else {
      record.resumen = 'En cola de espera de ejecución...';
      this.queue.push(record.id);
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.activeWorkers.size < this.maxConcurrentTasks) {
      const nextId = this.queue.shift()!;
      const nextTask = this.tasks.get(nextId);
      if (!nextTask || nextTask.estado !== 'en_curso') {
        continue;
      }

      // Check if deadline already passed while waiting in queue
      const elapsed = Date.now() - nextTask.createdAt;
      if (elapsed >= this.maxDeadlineMs) {
        this.finalizeTask(
          nextId,
          'fallida',
          `Plazo máximo (${Math.round(this.maxDeadlineMs / 1000)}s) vencido mientras esperaba en cola sin alcanzar a iniciar.`
        );
        continue;
      }

      this.activeWorkers.add(nextId);
      nextTask.resumen = 'Tarea en ejecución...';
      if (this.workerRunner) {
        setImmediate(() => {
          this.workerRunner!(nextTask).catch((err: unknown) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            safeLogger.error(`[TaskStore] Error en tarea ${nextId}: ${errorMsg}`, nextTask.desktop.password);
            this.finalizeTask(nextId, 'fallida', `Error en ejecución: ${errorMsg}`);
          });
        });
      }
    }
  }

  /**
   * Transitions task from 'en_curso' to a terminal state ('terminada' | 'fallida').
   * If task is already finished, this is an immutable no-op and returns false.
   */
  public finalizeTask(
    id: string,
    terminalStatus: 'terminada' | 'fallida',
    summary: string
  ): boolean {
    const task = this.tasks.get(id);
    if (!task) {
      return false;
    }

    // State machine rule: terminal states are immutable. Late results are discarded.
    if (task.estado !== 'en_curso') {
      safeLogger.warn(
        `[TaskStore] Intento tardío de modificar tarea ${id} en estado ${task.estado} ignorado.`
      );
      return false;
    }

    // Clear deadline timer
    if (task.deadlineTimer) {
      clearTimeout(task.deadlineTimer);
      task.deadlineTimer = undefined;
    }

    // Remove from active workers and remove from queue if present
    this.activeWorkers.delete(id);
    const qIndex = this.queue.indexOf(id);
    if (qIndex !== -1) {
      this.queue.splice(qIndex, 1);
    }

    // Set state & timestamp
    task.estado = terminalStatus;
    task.finishedAt = Date.now();
    task.resumen = sanitize(summary, task.desktop.password);

    // Cancel ongoing work immediately
    task.abortController.abort();

    // Run registered cleanup callbacks (e.g. disconnect RFB socket, release resources)
    const cleanups = [...task.cleanupCallbacks];
    task.cleanupCallbacks = [];
    for (const cleanup of cleanups) {
      try {
        const res = cleanup();
        if (res instanceof Promise) {
          res.catch((err) => safeLogger.error(`Error en cleanup de tarea ${id}: ${err}`));
        }
      } catch (err) {
        safeLogger.error(`Error síncrono en cleanup de tarea ${id}: ${err}`);
      }
    }

    // Process next queued task if capacity opened up
    this.drainQueue();

    return true;
  }

  /**
   * Handles internal deadline expiration.
   */
  private handleDeadlineExpiry(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.estado !== 'en_curso') {
      return;
    }

    const wasQueued = this.queue.includes(id);
    const reason = wasQueued
      ? `Plazo máximo (${Math.round(this.maxDeadlineMs / 1000)}s) vencido mientras esperaba en cola sin alcanzar a iniciar.`
      : `Plazo máximo de ejecución vencido (${Math.round(this.maxDeadlineMs / 1000)}s) tras ${task.stepCount} pasos.`;

    safeLogger.warn(`[TaskStore] Plazo de tarea ${id} vencido (${this.maxDeadlineMs}ms). Finalizando como fallida.`);
    this.finalizeTask(id, 'fallida', reason);
  }

  /**
   * Increments step count and checks against MAX_STEPS.
   * Returns updated step count. If max steps exceeded, task is finalized as 'fallida'.
   */
  public incrementStep(id: string): number {
    const task = this.tasks.get(id);
    if (!task || task.estado !== 'en_curso') {
      return -1;
    }

    task.stepCount++;
    if (task.stepCount >= this.maxSteps) {
      safeLogger.warn(`[TaskStore] Tarea ${id} alcanzó el límite de pasos (${this.maxSteps}).`);
      this.finalizeTask(
        id,
        'fallida',
        `Límite máximo de pasos (${this.maxSteps}) alcanzado sin confirmación final.`
      );
    }

    return task.stepCount;
  }

  /**
   * Registers a cleanup handler to run when the task reaches terminal state.
   */
  public registerCleanup(id: string, fn: () => Promise<void> | void): void {
    const task = this.tasks.get(id);
    if (!task) return;

    if (task.estado !== 'en_curso') {
      // Already finished: invoke immediately
      try {
        const res = fn();
        if (res instanceof Promise) {
          res.catch((err) => safeLogger.error(`Error en cleanup inmediato: ${err}`));
        }
      } catch (err) {
        safeLogger.error(`Error síncrono en cleanup inmediato: ${err}`);
      }
      return;
    }

    task.cleanupCallbacks.push(fn);
  }

  /**
   * Adds cost in USD to the task record.
   */
  public addCost(id: string, usd: number): number {
    const task = this.tasks.get(id);
    if (!task) return 0;
    task.costUsd += usd;
    return task.costUsd;
  }

  /** Bitácora sanitizada de una tarea (diagnóstico). */
  public getTaskTrace(id: string): string[] | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    return (task.trace ?? []).map((l) => sanitize(l, task.desktop.password));
  }

  /**
   * Retrieves public sanitized representation for GET /tasks/:id.
   */
  public getTaskPublic(id: string): { estado: TaskStatus; resumen: string; pasos?: number; costo_usd?: number } | null {
    const task = this.tasks.get(id);
    if (!task) {
      return null;
    }
    return {
      estado: task.estado,
      resumen: sanitize(task.resumen, task.desktop.password),
      pasos: task.stepCount,
      costo_usd: task.costUsd,
    };
  }

  /**
   * Internal lookup for worker loop.
   */
  public getTaskInternal(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  /**
   * Clear all tasks (for unit tests only).
   */
  public clearForTesting(): void {
    for (const task of this.tasks.values()) {
      if (task.deadlineTimer) {
        clearTimeout(task.deadlineTimer);
      }
      task.abortController.abort();
    }
    this.tasks.clear();
    this.activeWorkers.clear();
    this.queue = [];
  }
}

// Global singleton instance for the server runtime
export const globalTaskStore = new TaskStore();
