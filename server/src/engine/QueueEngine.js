import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WorkerPool } from './WorkerPool.js';
import { InlineReducer } from './InlineReducer.js';
import { Scheduler } from './Scheduler.js';
import { DeadlockGuard } from './DeadlockGuard.js';
import { ClientRegistry } from './ClientRegistry.js';
import { RingBuffer } from './RingBuffer.js';
import { Task, Priority } from './Task.js';
import { TaskState } from './TaskState.js';
import { planCsv } from '../util/csv.js';
import { ValidationError, NotFoundError } from '../util/errors.js';
import { rootLogger } from '../util/Logger.js';

/**
 * QueueEngine is the single façade the transport layer talks to. It wires
 * together the registry, the reduce strategy, the scheduler and the guard,
 * owns the completed-result store, and emits a `change` event whenever the
 * world moves (the SSE hub listens and pushes snapshots).
 *
 * One instance == one queueing "server". `server/src/index.js` keeps it alive
 * on a timer; the Vercel function keeps a warm module-level singleton and
 * drives it via HTTP ticks.
 */
export class QueueEngine extends EventEmitter {
  #config;
  #log;
  #registry;
  #reducer;
  #scheduler;
  #guard;
  #tasks = new Map(); // taskId -> Task (every task ever, until GC)
  #results = new Map(); // taskId -> { summary, csv, expiresAt }
  #recent;
  #tickTimer = null;
  #totals = { submitted: 0, completed: 0, failed: 0, cancelled: 0, rejected: 0, valuesReduced: 0 };
  #startedAt = Date.now();

  constructor(config) {
    super();
    this.#config = config;
    this.#log = rootLogger.child('engine');
    this.#registry = new ClientRegistry();
    this.#recent = new RingBuffer(config.results.recentLimit);

    this.#reducer =
      config.workers.strategy === 'inline'
        ? new InlineReducer({ poolSize: config.workers.poolSize, demoDelayMs: config.workers.demoDelayMs })
        : new WorkerPool({
            poolSize: config.workers.poolSize,
            chunkTimeoutMs: config.workers.chunkTimeoutMs,
            idleShutdownMs: config.workers.idleShutdownMs,
          });

    this.#scheduler = new Scheduler({
      reducer: this.#reducer,
      config,
      onSettled: (task) => this.#onTaskSettled(task),
    });
    this.#scheduler.on('change', () => this.emit('change'));
    this.#registry.on('change', () => this.emit('change'));

    this.#guard = new DeadlockGuard({
      engine: this,
      scheduler: this.#scheduler,
      registry: this.#registry,
      config,
    });

    this.#log.info(
      `engine ready — reduce strategy: ${config.workers.strategy}, pool ${config.workers.poolSize}, ` +
        `queue cap ${config.queue.capacity}, aging ${config.queue.agingMs}ms`,
    );
  }

  // --- lifecycle -----------------------------------------------------

  start() {
    if (this.#tickTimer) return;
    this.#guard.start();
    this.#tickTimer = setInterval(() => this.#scheduler.tick(), this.#config.scheduler.tickMs);
    this.#tickTimer.unref?.();
    this.#log.info('scheduler tick loop started');
  }

  async stop() {
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    this.#tickTimer = null;
    this.#guard.stop();
    await this.#reducer.shutdown();
  }

  /** For serverless: advance the world without a background timer. */
  tick() {
    this.#guard.sweep();
    return this.#scheduler.tick();
  }

  // --- clients ------------------------------------------------------

  registerClient(label) {
    const client = this.#registry.register(label);
    this.#log.info(`client connected ${client.id} (${client.label})`);
    return client;
  }

  heartbeat(clientId) {
    return this.#registry.heartbeat(clientId);
  }

  disconnectClient(clientId) {
    const reaped = this.#scheduler.reapForClient(clientId, 'client disconnected');
    this.#registry.remove(clientId);
    return reaped;
  }

  // --- submission --------------------------------------------------

  /**
   * @param {{ clientId:string, fileName:string, buffer:Buffer, priority:string }} input
   * @returns {object} task summary
   */
  submit({ clientId, fileName, buffer, priority }) {
    const client = this.#registry.require(clientId);

    const ext = path.extname(fileName || '').toLowerCase();
    if (ext && !this.#config.upload.allowedExt.includes(ext)) {
      throw new ValidationError(`Unsupported file type "${ext}". Allowed: ${this.#config.upload.allowedExt.join(', ')}`);
    }
    if (!buffer || buffer.length === 0) {
      throw new ValidationError('Uploaded file is empty.');
    }
    if (buffer.length > this.#config.upload.maxBytes) {
      throw new ValidationError(`File exceeds ${(this.#config.upload.maxBytes / 1024 / 1024).toFixed(0)} MB limit.`);
    }

    const plan = planCsv(buffer, { chunkRows: this.#config.workers.chunkRows });

    const task = new Task({
      clientId,
      fileName,
      sizeBytes: buffer.length,
      priority: priority === Priority.HIGH ? Priority.HIGH : Priority.LOW,
    });
    task.on('change', () => this.emit('change'));

    this.#tasks.set(task.id, task);
    client.taskIds.add(task.id);
    client.stats.submitted += 1;
    this.#totals.submitted += 1;

    try {
      this.#scheduler.enqueue(task, plan);
    } catch (err) {
      // Bounded-queue rejection: undo bookkeeping, surface as retryable 503.
      this.#tasks.delete(task.id);
      client.taskIds.delete(task.id);
      client.stats.submitted -= 1;
      client.stats.rejected += 1;
      this.#totals.submitted -= 1;
      this.#totals.rejected += 1;
      throw err;
    }

    return task.toJSON();
  }

  cancelTask(taskId, clientId) {
    const task = this.#tasks.get(taskId);
    if (!task) throw new NotFoundError(`Unknown task ${taskId}`);
    if (clientId && task.clientId !== clientId) {
      throw new ValidationError('A task can only be cancelled by the client that submitted it.');
    }
    const ok = this.#scheduler.cancel(task, 'cancelled by client');
    if (!ok && !task.isTerminal) task.cancel('cancelled by client');
    return task.toJSON();
  }

  // --- results ----------------------------------------------------

  #onTaskSettled(task) {
    const client = this.#registry.get(task.clientId);
    if (client) client.taskIds.delete(task.id);

    if (task.state === TaskState.COMPLETED) {
      this.#totals.completed += 1;
      this.#totals.valuesReduced += task.valuesCounted;
      if (client) client.stats.completed += 1;

      const csv = this.#buildResultCsv(task);
      this.#results.set(task.id, {
        summary: task.toJSON(),
        csv,
        expiresAt: Date.now() + this.#config.results.ttlMs,
      });
      // Targeted notification so the owning client can pull its file back.
      this.emit('notify', {
        clientId: task.clientId,
        type: 'result',
        taskId: task.id,
        fileName: task.fileName,
        result: task.result,
      });
    } else if (task.state === TaskState.FAILED) {
      this.#totals.failed += 1;
      if (client) client.stats.failed += 1;
    } else if (task.state === TaskState.CANCELLED) {
      this.#totals.cancelled += 1;
      if (client) client.stats.cancelled += 1;
    }

    this.#recent.push({
      id: task.id,
      clientId: task.clientId,
      fileName: task.fileName,
      priority: task.priority,
      state: task.state,
      result: task.result,
      rank: task.rank,
      valuesCounted: task.valuesCounted,
      processId: task.processId,
      durationMs: task.finishedAt && task.startedAt ? task.finishedAt - task.startedAt : null,
      finishedAt: task.finishedAt,
    });
    this.emit('change');
  }

  #buildResultCsv(task) {
    const lines = [
      'metric,value',
      `source_file,${task.fileName}`,
      `client_id,${task.clientId}`,
      `process_id,${task.processId}`,
      `rank_rows,${task.rank.rows}`,
      `rank_cols,${task.rank.cols}`,
      `values_reduced,${task.valuesCounted}`,
      `chunks,${task.chunksTotal}`,
      `all_reduce_sum,${task.result}`,
      `completed_at,${new Date(task.finishedAt).toISOString()}`,
    ];
    return lines.join('\n') + '\n';
  }

  getTask(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task) throw new NotFoundError(`Unknown task ${taskId}`);
    return task.toJSON();
  }

  getResultFile(taskId) {
    const entry = this.#results.get(taskId);
    if (!entry) {
      throw new NotFoundError('Result not available (never completed, or it has expired).');
    }
    return { fileName: `result-${taskId}.csv`, csv: entry.csv, summary: entry.summary };
  }

  gcResults() {
    const now = Date.now();
    let expired = 0;
    for (const [id, entry] of this.#results) {
      if (entry.expiresAt <= now) {
        this.#results.delete(id);
        this.#tasks.delete(id);
        expired += 1;
      }
    }
    return expired;
  }

  // --- snapshot --------------------------------------------------

  snapshot() {
    const sched = this.#scheduler.snapshot();
    return {
      generatedAt: Date.now(),
      uptimeMs: Date.now() - this.#startedAt,
      mode: this.#config.isServerless ? 'serverless' : 'server',
      reduceStrategy: this.#config.workers.strategy,
      totals: { ...this.#totals },
      workers: this.#reducer.stats(),
      guard: this.#guard.counters(),
      clients: this.#registry.toJSON(),
      queue: sched,
      recent: this.#recent.toArray(),
      config: {
        queueCapacity: this.#config.queue.capacity,
        agingMs: this.#config.queue.agingMs,
        chunkRows: this.#config.workers.chunkRows,
        maxConcurrentProcesses: this.#config.queue.maxConcurrentProcesses,
      },
    };
  }
}

export default QueueEngine;
