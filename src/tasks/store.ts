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
  /** Capturas de cada paso (diagnóstico, máx. 30; se liberan al rato de terminar). */
  shots?: Buffer[];
  /** Modelos para esta tarea (experimentos de comparación); por defecto MODEL_ID / GROUNDING_MODEL_ID. */
  modelo?: string;
  modeloLocalizador?: string;
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
  public createTask(params: {
    tarea: string;
    escritorio: DesktopConfig;
    debug?: boolean;
    modelo?: string;
    modeloLocalizador?: string;
  }): TaskRecord {
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
      modelo: params.modelo,
      modeloLocalizador: params.modeloLocalizador,
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

  /**
   * Con DESKTOP_LOCK=1, un escritorio solo ejecuta una tarea a la vez (dos tareas sobre la misma sesión VNC
   * se pisan el ratón y el teclado). Apagado por defecto para no cambiar el comportamiento del contrato
   * del evaluador; recomendado en producción (docs/EMPRESA.md, punto 3.2).
   */
  private get desktopLock(): boolean {
    return process.env.DESKTOP_LOCK === '1';
  }

  private desktopBusy(record: TaskRecord): boolean {
    if (!this.desktopLock) return false;
    for (const id of this.activeWorkers) {
      const t = this.tasks.get(id);
      if (t && t.id !== record.id && t.desktop.url === record.desktop.url) return true;
    }
    return false;
  }

  private dispatchOrEnqueue(record: TaskRecord): void {
    if (this.activeWorkers.size < this.maxConcurrentTasks && !this.desktopBusy(record)) {
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
      // Primera tarea de la fila (en orden de llegada) cuyo escritorio esté libre.
      const pos = this.queue.findIndex((qid) => {
        const t = this.tasks.get(qid);
        return !t || t.estado !== 'en_curso' || !this.desktopBusy(t);
      });
      if (pos === -1) break;
      const nextId = this.queue.splice(pos, 1)[0];
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

  /** Captura n (1..) de una tarea, para diagnóstico. */
  public getTaskShot(id: string, n: number): Buffer | null {
    const task = this.tasks.get(id);
    if (!task || !task.shots) return null;
    return task.shots[n - 1] ?? null;
  }

  public getTaskShotCount(id: string): number {
    return this.tasks.get(id)?.shots?.length ?? 0;
  }

  /** Libera capturas de tareas terminadas hace más de 20 minutos (memoria). */
  public pruneShots(): void {
    const limit = Date.now() - 20 * 60 * 1000;
    for (const t of this.tasks.values()) {
      if (t.shots && t.finishedAt && t.finishedAt < limit) t.shots = undefined;
    }
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

  /** Lista pública (sanitizada) de las tareas más recientes, para el panel. */
  public listTasksPublic(limit = 50): Array<{
    id: string;
    tarea: string;
    estado: TaskStatus;
    resumen: string;
    pasos: number;
    costo_usd: number;
    creada: string;
    segundos: number;
    capturas: number;
  }> {
    const now = Date.now();
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map((t) => ({
        id: t.id,
        tarea: sanitize(t.tarea, t.desktop.password),
        estado: t.estado,
        resumen: sanitize(t.resumen, t.desktop.password),
        pasos: t.stepCount,
        costo_usd: Number(t.costUsd.toFixed(5)),
        creada: new Date(t.createdAt).toISOString(),
        segundos: Math.round(((t.finishedAt ?? now) - t.createdAt) / 1000),
        capturas: t.shots?.length ?? 0,
      }));
  }

  /**
   * Métricas operativas desde que arrancó la instancia (en memoria: se reinician con cada despliegue).
   * "terminada" significa que el agente dio la tarea por cumplida, NO que esté verificada como correcta:
   * la exactitud solo la mide el banco de pruebas contra el escritorio real.
   */
  public metrics(): {
    total: number;
    en_curso: number;
    terminadas: number;
    fallidas: number;
    tasa_terminacion: number | null;
    segundos_promedio: number | null;
    segundos_p95: number | null;
    pasos_promedio: number | null;
    costo_total_usd: number;
    costo_promedio_usd: number | null;
    uptime_segundos: number;
  } {
    const all = [...this.tasks.values()];
    const done = all.filter((t) => t.estado !== 'en_curso' && t.finishedAt);
    const durs = done.map((t) => (t.finishedAt! - t.createdAt) / 1000).sort((a, b) => a - b);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const terminadas = done.filter((t) => t.estado === 'terminada').length;
    const costoTotal = all.reduce((a, t) => a + t.costUsd, 0);
    const round = (v: number | null, d = 1) => (v === null ? null : Number(v.toFixed(d)));
    return {
      total: all.length,
      en_curso: all.length - done.length,
      terminadas,
      fallidas: done.length - terminadas,
      tasa_terminacion: done.length ? round(terminadas / done.length, 3) : null,
      segundos_promedio: round(avg(durs)),
      segundos_p95: durs.length ? round(durs[Math.min(durs.length - 1, Math.floor(durs.length * 0.95))]) : null,
      pasos_promedio: round(avg(done.map((t) => t.stepCount))),
      costo_total_usd: Number(costoTotal.toFixed(5)),
      costo_promedio_usd: done.length ? Number((done.reduce((a, t) => a + t.costUsd, 0) / done.length).toFixed(5)) : null,
      uptime_segundos: Math.floor(process.uptime()),
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
