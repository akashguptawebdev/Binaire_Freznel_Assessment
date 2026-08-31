import test from 'node:test';
import assert from 'node:assert/strict';
import { PriorityQueue } from '../src/engine/PriorityQueue.js';
import { RingBuffer } from '../src/engine/RingBuffer.js';
import { planCsv, reduceLines } from '../src/util/csv.js';
import { QueueEngine } from '../src/engine/QueueEngine.js';
import config from '../src/config.js';

const csvOf = (rows) => Buffer.from(rows.map((r) => r.join(',')).join('\n'), 'utf8');

function makeEngine(overrides = {}) {
  const cfg = structuredClone(config);
  cfg.workers.strategy = 'inline';
  cfg.workers.demoDelayMs = overrides.demoDelayMs ?? 0;
  cfg.workers.poolSize = overrides.poolSize ?? 4;
  cfg.workers.chunkRows = 3;
  cfg.scheduler.tickMs = 20;
  cfg.guard.sweepMs = 40;
  cfg.queue.agingMs = overrides.agingMs ?? 120;
  Object.assign(cfg.queue, overrides.queue || {});
  return new QueueEngine(cfg);
}

const settle = (engine, taskId, timeoutMs = 4000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      const t = engine.getTask(taskId);
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state)) {
        clearInterval(iv);
        resolve(t);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`task ${taskId} did not settle (state ${t.state})`));
      }
    }, 15);
  });

test('PriorityQueue orders by comparator and supports removal + reheapify', () => {
  const pq = new PriorityQueue((a, b) => a.key - b.key);
  const items = [{ key: 5 }, { key: 1 }, { key: 3 }, { key: 4 }, { key: 2 }];
  items.forEach((i) => pq.push(i));
  assert.equal(pq.size, 5);
  assert.equal(pq.peek().key, 1);
  pq.remove((i) => i.key === 1);
  assert.equal(pq.peek().key, 2);
  const moved = items.find((i) => i.key === 4);
  moved.key = 0;
  pq.reheapify();
  assert.equal(pq.peek().key, 0);
  const out = [];
  while (!pq.isEmpty) out.push(pq.pop().key);
  assert.deepEqual(out, [0, 2, 3, 5]);
});

test('RingBuffer keeps only the newest N, newest-first', () => {
  const rb = new RingBuffer(3);
  [1, 2, 3, 4, 5].forEach((n) => rb.push(n));
  assert.deepEqual(rb.toArray(), [5, 4, 3]);
});

test('reduceLines / planCsv sum integers and floats, ignore junk', () => {
  assert.deepEqual(reduceLines(['1,2,3', '4 5', 'x,6']), { sum: 21, count: 6 });
  const plan = planCsv(csvOf([[1, 2], [3, 4], [5, 6], [7, 8]]), { chunkRows: 2 });
  assert.equal(plan.rank.rows, 4);
  assert.equal(plan.rank.cols, 2);
  assert.equal(plan.chunks.length, 2);
});

test('all-reduce over a multi-chunk CSV produces the correct scalar', async () => {
  const engine = makeEngine();
  const client = engine.registerClient('tester');
  const rows = Array.from({ length: 20 }, (_, i) => [i, i + 0.5]);
  const expected = rows.flat().reduce((a, b) => a + b, 0);
  const { id } = engine.submit({
    clientId: client.id,
    fileName: 'nums.csv',
    buffer: csvOf(rows),
    priority: 'high',
  });
  const done = await settle(engine, id);
  assert.equal(done.state, 'COMPLETED');
  assert.ok(Math.abs(done.result - expected) < 1e-6);
  assert.equal(done.valuesCounted, 40);
  assert.ok(done.processId);
  await engine.stop();
});

test('bounded queue rejects with QUEUE_FULL instead of blocking', async () => {
  const engine = makeEngine({ queue: { capacity: 2, maxConcurrentProcesses: 0 } });
  const client = engine.registerClient('flooder');
  const submitOne = () =>
    engine.submit({ clientId: client.id, fileName: 'a.csv', buffer: csvOf([[1]]), priority: 'low' });
  submitOne();
  submitOne();
  assert.throws(submitOne, /capacity/i);
  await engine.stop();
});

test('aging promotes a starved low-priority task', async () => {
  const engine = makeEngine({ queue: { maxConcurrentProcesses: 1 }, demoDelayMs: 30, poolSize: 2 });
  const client = engine.registerClient('mix');
  const big = Array.from({ length: 60 }, (_, i) => [i]);
  // Slow the chunks right down so the single process slot stays occupied.
  const low = engine.submit({ clientId: client.id, fileName: 'lo.csv', buffer: csvOf([[1], [2], [3]]), priority: 'low' });
  engine.submit({ clientId: client.id, fileName: 'hi1.csv', buffer: csvOf(big), priority: 'high' });
  engine.submit({ clientId: client.id, fileName: 'hi2.csv', buffer: csvOf(big), priority: 'high' });

  // Wait past the aging window; the guard sweep should promote `low`.
  let promoted = false;
  for (let i = 0; i < 40 && !promoted; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
    const t = engine.getTask(low.id);
    if (t.promoted || ['WAITING', 'PROCESSING', 'COMPLETED'].includes(t.state)) promoted = true;
  }
  assert.ok(promoted, 'starved low-priority task must be promoted or admitted via aging');
  await engine.stop();
});
