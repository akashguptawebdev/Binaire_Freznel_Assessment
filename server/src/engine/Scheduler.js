import { EventEmitter } from 'node:events';
import { PriorityQueue } from './PriorityQueue.js';
import { TaskState } from './TaskState.js';
import { nextProcessId } from '../util/ids.js';
import { QueueFullError } from '../util/errors.js';
import { rootLogger } from '../util/Logger.js';

/**
 * Ordering for the waiting queue:
 *   1. effective priority   (high before low; aging can promote low -> high)
 *   2. FIFO by enqueue time  (fairness within a priority band)
 *   3. task id               (total order, keeps the heap deterministic)
 */
function compareTasks(a, b) {
  if (a.effectivePriorityRank !== b.effectivePriorityRank) {
    return a.effectivePriorityRank - b.effectivePriorityRank;
  }
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  return a.id < b.id ? -1 : 1;
}

/**
 * The Scheduler owns the waiting queue and the set of in-flight "processes".
 *
 * A "process" == one admitted Task with a process id. Its CSV is split into
 * chunks; chunks from ALL active processes compete for the shared worker pool,
 * ordered by priority. Because scheduling happens at chunk granularity:
 *   - a small high-priority file is never stuck behind a huge low-priority one
 *   - no task holds a worker for longer than a single chunk (no hold-and-wait)
 *
 * All mutation happens synchronously on the Node event loop between `await`
 * points, so the scheduler's own state never needs a lock.
 */
export class Scheduler extends EventEmitter {
  #queue = new PriorityQueue(compareTasks);
  #active = new Map(); // processId -> record
  #plans = new Map(); // taskId -> { lines, chunks, rank }
  #reducer;
  #config;
  #log;
  #admitSeq = 0;
  #onSettled;
  #agingPromotions = 0;

  constructor({ reducer, config, onSettled }) {
    super();
    this.#reducer = reducer;
    this.#config = config;
    this.#onSettled = onSettled || (() => {});
    this.#log = rootLogger.child('scheduler');
  }

  get queueDepth() {
    return this.#queue.size;
  }

  get activeCount() {
    return this.#active.size;
  }

  // --- submission ------------------------------------------------------

  enqueue(task, plan) {
    if (this.#queue.size >= this.#config.queue.capacity) {
      throw new QueueFullError(this.#config.queue.capacity);
    }
    this.#plans.set(task.id, plan);
    task.setRankAndChunks(plan.rank, plan.chunks);
    task.transition(TaskState.QUEUED);
    this.#queue.push(task);
    this.#log.info(`queued ${task.id} (${task.priority}) rank ${plan.rank.rows}x${plan.rank.cols}, ${plan.chunks.length} chunks`);
    this.emit('change');
    this.pump();
  }

  cancel(task, reason) {
    // Case 1: still waiting in the queue — pull it straight out.
    if (this.#queue.has(task)) {
      this.#queue.remove((t) => t === task);
      this.#plans.delete(task.id);
      task.cancel(reason);
      this.emit('change');
      this.#onSettled(task);
      return true;
    }
    // Case 2: already an active process — flag it; in-flight chunks are
    // allowed to drain, then the record is cleaned up.
    for (const [pid, record] of this.#active) {
      if (record.task === task) {
        record.cancelled = true;
        record.cancelReason = reason;
        record.pending.length = 0;
        if (record.inFlight === 0) this.#retireProcess(pid, () => task.cancel(reason));
        this.emit('change');
        return true;
      }
    }
    return false;
  }

  // --- aging (anti-starvation) ----------------------------------------

  promoteAging() {
    const agingMs = this.#config.queue.agingMs;
    let promoted = 0;
    for (const task of this.#queue.toArray()) {
      if (task.priority === 'low' && !task.promoted && task.waitedMs > agingMs) {
        task.promoted = true;
        promoted += 1;
      }
    }
    if (promoted > 0) {
      this.#agingPromotions += promoted;
      this.#queue.reheapify();
      this.#log.warn(`aged ${promoted} low-priority task(s) up to high to avoid starvation`);
      this.emit('change');
    }
    return promoted;
  }

  get agingPromotions() {
    return this.#agingPromotions;
  }

  // --- the pump -------------------------------------------------------

  /**
   * Idempotent. Admits as many processes as allowed, then feeds as many
   * chunks to the pool as there is capacity for. Safe to call from a timer,
   * from an HTTP handler (serverless), or recursively after a chunk settles.
   */
  pump() {
    this.#admitProcesses();
    this.#dispatchChunks();
  }

  tick() {
    // Aging is handled by the DeadlockGuard sweep (coarser cadence is fine);
    // the tick loop only needs to keep the pump turning.
    this.pump();
    return this.#active.size > 0 || this.#queue.size > 0;
  }

  #admitProcesses() {
    const max = this.#config.queue.maxConcurrentProcesses;
    while (this.#active.size < max && !this.#queue.isEmpty) {
      const task = this.#queue.pop();
      if (!task || task.isTerminal) continue;
      const plan = this.#plans.get(task.id);
      if (!plan) {
        task.fail(new Error('lost processing plan'));
        this.#onSettled(task);
        continue;
      }
      const processId = nextProcessId();
      this.#admitSeq += 1;
      const record = {
        task,
        plan,
        processId,
        admitSeq: this.#admitSeq,
        pending: plan.chunks.map((c) => c.index),
        inFlight: 0,
        retries: new Map(),
        cancelled: false,
      };
      this.#active.set(processId, record);
      task.transition(TaskState.WAITING, { processId });
      this.#log.info(`admitted ${task.id} as ${processId} (${record.pending.length} chunks)`);
    }
  }

  #orderedActive() {
    return [...this.#active.values()].sort((a, b) => {
      const pa = a.task.effectivePriorityRank;
      const pb = b.task.effectivePriorityRank;
      if (pa !== pb) return pa - pb;
      return a.admitSeq - b.admitSeq;
    });
  }

  #dispatchChunks() {
    while (this.#reducer.freeCount > 0) {
      let dispatched = false;
      for (const record of this.#orderedActive()) {
        if (record.cancelled || record.pending.length === 0) continue;
        const chunkIndex = record.pending.shift();
        this.#dispatchChunk(record, chunkIndex);
        dispatched = true;
        break; // re-evaluate priority order after every single dispatch
      }
      if (!dispatched) break;
    }
  }

  #linesFor(record, chunkIndex) {
    const chunk = record.plan.chunks[chunkIndex];
    return record.plan.lines.slice(chunk.startRow, chunk.endRow);
  }

  #dispatchChunk(record, chunkIndex) {
    record.inFlight += 1;
    const { task } = record;
    const lines = this.#linesFor(record, chunkIndex);

    this.#reducer
      .runChunk({ chunkIndex, lines, demoDelayMs: this.#config.workers.demoDelayMs })
      .then((res) => {
        record.inFlight -= 1;
        if (record.cancelled) {
          if (record.inFlight === 0) this.#retireProcess(record.processId, () => task.cancel(record.cancelReason || "cancelled"));
          return;
        }
        task.recordChunkResult({ sum: res.sum, count: res.count });
        if (task.chunksDone >= task.chunksTotal && record.inFlight === 0) {
          this.#completeProcess(record);
        }
      })
      .catch((err) => {
        record.inFlight -= 1;
        if (record.cancelled) {
          if (record.inFlight === 0) this.#retireProcess(record.processId, () => task.cancel(record.cancelReason || "cancelled"));
          return;
        }
        const attempts = (record.retries.get(chunkIndex) || 0) + 1;
        record.retries.set(chunkIndex, attempts);
        if (attempts <= this.#config.workers.maxChunkRetries) {
          this.#log.warn(`retry chunk ${chunkIndex} of ${task.id} (attempt ${attempts}): ${err.message}`);
          record.pending.push(chunkIndex); // back of its own queue
        } else {
          this.#log.error(`chunk ${chunkIndex} of ${task.id} failed permanently: ${err.message}`);
          this.#retireProcess(record.processId, () => task.fail(err));
        }
      })
      .finally(() => {
        this.emit('change');
        // Something freed up (a worker, a process slot) — keep the wheel turning.
        this.pump();
      });

    this.emit('change');
  }

  #completeProcess(record) {
    const { task } = record;
    const value = task.finalizeReduce();
    this.#log.info(`completed ${task.id} (${record.processId}) all-reduce = ${value}`);
    this.#active.delete(record.processId);
    this.#plans.delete(task.id);
    this.emit('change');
    this.#onSettled(task);
  }

  #retireProcess(processId, finalize) {
    const record = this.#active.get(processId);
    if (!record) return;
    this.#active.delete(processId);
    this.#plans.delete(record.task.id);
    if (finalize) finalize();
    this.emit('change');
    this.#onSettled(record.task);
  }

  // --- introspection -------------------------------------------------

  reapForClient(clientId, reason) {
    const victims = [];
    for (const task of this.#queue.toArray()) {
      if (task.clientId === clientId) victims.push(task);
    }
    for (const record of this.#active.values()) {
      if (record.task.clientId === clientId) victims.push(record.task);
    }
    for (const task of victims) this.cancel(task, reason);
    return victims.length;
  }

  diagnostics() {
    const stalled = [...this.#active.values()].filter((r) => {
      const t = r.task;
      const since = t.history[t.history.length - 1]?.at || t.createdAt;
      return r.inFlight === 0 && r.pending.length > 0 && Date.now() - since > this.#config.guard.stallMs;
    });
    return {
      queueDepth: this.#queue.size,
      activeProcesses: this.#active.size,
      stalledProcesses: stalled.length,
    };
  }

  snapshot() {
    return {
      waiting: this.#queue.toArray().map((t) => t.toJSON()),
      active: this.#orderedActive().map((r) => ({
        ...r.task.toJSON(),
        pendingChunks: r.pending.length,
        inFlightChunks: r.inFlight,
      })),
      queueDepth: this.#queue.size,
      queueCapacity: this.#config.queue.capacity,
      activeProcesses: this.#active.size,
      maxConcurrentProcesses: this.#config.queue.maxConcurrentProcesses,
    };
  }
}

export default Scheduler;
