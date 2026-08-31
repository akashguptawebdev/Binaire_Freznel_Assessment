import { parentPort } from 'node:worker_threads';
import { reduceLines } from '../util/csv.js';

/**
 * Web worker (worker_threads) that performs the local reduce for one chunk.
 *
 * Protocol:
 *   in : { jobId, chunkIndex, lines: string[], demoDelayMs }
 *   out: { jobId, chunkIndex, ok, sum, count }  | { jobId, ok:false, error }
 *
 * The worker is intentionally stateless between messages so the pool can
 * reuse it for any task's chunk without cross-talk.
 */
if (!parentPort) {
  throw new Error('reduceWorker must be run as a worker_threads Worker');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

parentPort.on('message', async (job) => {
  const { jobId, chunkIndex, lines, demoDelayMs = 0 } = job;
  try {
    if (demoDelayMs > 0) {
      // Makes the "Processing… %" animation legible in a live demo. This is
      // a real async wait, not a busy-loop, so the thread stays cheap.
      await sleep(demoDelayMs);
    }
    const { sum, count } = reduceLines(lines);
    parentPort.postMessage({ jobId, chunkIndex, ok: true, sum, count });
  } catch (err) {
    parentPort.postMessage({
      jobId,
      chunkIndex,
      ok: false,
      error: String(err?.stack || err),
    });
  }
});
