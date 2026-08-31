import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { rootLogger } from '../util/Logger.js';

const WORKER_URL = new URL('../workers/reduceWorker.js', import.meta.url);

/**
 * A fixed-size pool of worker_threads that run chunk reductions.
 *
 * Deadlock-relevant design choices:
 *
 *  - `runChunk()` NEVER blocks. It returns a promise that settles when a
 *    worker becomes free and finishes the job. The Node event loop stays
 *    responsive, so the scheduler, the HTTP layer and the guard keep running.
 *
 *  - A worker only ever holds ONE chunk at a time and releases it the instant
 *    the chunk is done. Tasks therefore never "hold" a worker across their
 *    whole file — this removes hold-and-wait at the worker level.
 *
 *  - Workers do not talk to each other and never wait on another worker, so
 *    there is no circular wait among them.
 *
 *  - Watchdog: a chunk exceeding `chunkTimeoutMs` is force-terminated and the
 *    worker replaced. This gives us pre-emption of a stuck unit of work.
 */
export class WorkerPool extends EventEmitter {
  #size;
  #timeoutMs;
  #idleShutdownMs;
  #log;

  #workers = new Map(); // Worker -> { busy, job, timer }
  #idle = []; // free Worker instances
  #waiters = []; // FIFO of resolve fns waiting for a free worker
  #idleTimer = null;
  #jobSeq = 0;
  #stats = { started: 0, completed: 0, failed: 0, timedOut: 0, replaced: 0 };

  constructor({ poolSize, chunkTimeoutMs, idleShutdownMs }) {
    super();
    this.#size = Math.max(1, poolSize);
    this.#timeoutMs = chunkTimeoutMs;
    this.#idleShutdownMs = idleShutdownMs;
    this.#log = rootLogger.child('pool');
  }

  get size() {
    return this.#size;
  }

  get busyCount() {
    return [...this.#workers.values()].filter((m) => m.busy).length;
  }

  get freeCount() {
    return this.#idle.length + (this.#size - this.#workers.size);
  }

  get waiterCount() {
    return this.#waiters.length;
  }

  stats() {
    return {
      size: this.#size,
      alive: this.#workers.size,
      busy: this.busyCount,
      free: this.freeCount,
      waiters: this.#waiters.length,
      ...this.#stats,
    };
  }

  #spawn() {
    const worker = new Worker(fileURLToPath(WORKER_URL));
    const meta = { busy: false, job: null, timer: null };
    this.#workers.set(worker, meta);

    worker.on('message', (msg) => this.#onMessage(worker, msg));
    worker.on('error', (err) => this.#onWorkerError(worker, err));
    worker.on('exit', (code) => {
      if (code !== 0) this.#log.warn(`worker exited with code ${code}`);
      this.#workers.delete(worker);
    });
    return worker;
  }

  #acquire() {
    // Reuse an idle worker.
    const existing = this.#idle.pop();
    if (existing) return Promise.resolve(existing);
    // Grow up to the cap.
    if (this.#workers.size < this.#size) {
      const w = this.#spawn();
      return Promise.resolve(w);
    }
    // Otherwise wait our turn (FIFO, so no waiter is starved).
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #release(worker) {
    const meta = this.#workers.get(worker);
    if (!meta) return; // worker was terminated; nothing to release
    meta.busy = false;
    meta.job = null;
    if (meta.timer) {
      clearTimeout(meta.timer);
      meta.timer = null;
    }
    const nextWaiter = this.#waiters.shift();
    if (nextWaiter) {
      nextWaiter(worker);
    } else {
      this.#idle.push(worker);
      this.#scheduleIdleShutdown();
    }
  }

  #scheduleIdleShutdown() {
    if (this.#idleTimer || !this.#idleShutdownMs) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      // Only reap if truly quiet.
      if (this.busyCount === 0 && this.#waiters.length === 0) {
        for (const w of this.#idle.splice(0)) {
          w.terminate().catch(() => {});
        }
      }
    }, this.#idleShutdownMs);
    this.#idleTimer.unref?.();
  }

  #onMessage(worker, msg) {
    const meta = this.#workers.get(worker);
    if (!meta || !meta.job || meta.job.jobId !== msg.jobId) {
      // Late message from a job we already timed out. Ignore.
      return;
    }
    const { resolve, reject } = meta.job;
    if (msg.ok) {
      this.#stats.completed += 1;
      this.#release(worker);
      resolve({ chunkIndex: msg.chunkIndex, sum: msg.sum, count: msg.count });
    } else {
      this.#stats.failed += 1;
      this.#release(worker);
      reject(new Error(msg.error || 'worker reduce failed'));
    }
  }

  #onWorkerError(worker, err) {
    const meta = this.#workers.get(worker);
    this.#log.error('worker error', err);
    if (meta?.job) {
      const { reject } = meta.job;
      meta.job = null;
      reject(err);
    }
    this.#workers.delete(worker);
    worker.terminate().catch(() => {});
  }

  #timeoutJob(worker) {
    const meta = this.#workers.get(worker);
    if (!meta?.job) return;
    this.#stats.timedOut += 1;
    this.#stats.replaced += 1;
    const { reject, jobId } = meta.job;
    meta.job = null;
    this.#log.warn(`chunk ${jobId} timed out after ${this.#timeoutMs}ms — killing worker`);
    this.#workers.delete(worker);
    worker.terminate().catch(() => {});
    // Give any FIFO waiter a fresh worker.
    const waiter = this.#waiters.shift();
    if (waiter) waiter(this.#spawn());
    const err = new Error('chunk timed out');
    err.code = 'CHUNK_TIMEOUT';
    reject(err);
  }

  /**
   * Run one chunk. Resolves { chunkIndex, sum, count }.
   */
  async runChunk({ chunkIndex, lines, demoDelayMs }) {
    this.#jobSeq += 1;
    const jobId = `job-${this.#jobSeq}`;
    this.#stats.started += 1;

    const worker = await this.#acquire();
    const meta = this.#workers.get(worker);
    if (!meta) {
      // Extremely rare: worker died between acquire and use. Retry once.
      return this.runChunk({ chunkIndex, lines, demoDelayMs });
    }

    return new Promise((resolve, reject) => {
      meta.busy = true;
      meta.job = { jobId, chunkIndex, resolve, reject };
      meta.timer = setTimeout(() => this.#timeoutJob(worker), this.#timeoutMs);
      meta.timer.unref?.();
      worker.postMessage({ jobId, chunkIndex, lines, demoDelayMs });
    });
  }

  async shutdown() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    const all = [...this.#workers.keys()];
    this.#workers.clear();
    this.#idle.length = 0;
    await Promise.allSettled(all.map((w) => w.terminate()));
  }
}

export default WorkerPool;
