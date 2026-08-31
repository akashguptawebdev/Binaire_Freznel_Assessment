import os from 'node:os';

/**
 * Central configuration. Everything is overridable via environment variables
 * so the same code runs as a long-lived server (Render/Docker/local) or as a
 * Vercel serverless function with different tuning.
 */
const int = (v, d) => (v === undefined ? d : Number.parseInt(v, 10));
const bool = (v, d) => (v === undefined ? d : v === '1' || v === 'true');

const isServerless = bool(process.env.VERCEL, false) || bool(process.env.SERVERLESS, false);
const cpuCount = Math.max(1, os.cpus?.().length || 4);

export const config = {
  env: process.env.NODE_ENV || 'development',
  isServerless,

  http: {
    host: process.env.HOST || '0.0.0.0',
    port: int(process.env.PORT, 4000),
    corsOrigin: process.env.CORS_ORIGIN || '*',
    bodyLimit: '256kb',
  },

  upload: {
    // Hard ceiling on a single CSV. Keeps memory bounded per request.
    maxBytes: int(process.env.UPLOAD_MAX_BYTES, 20 * 1024 * 1024),
    allowedExt: ['.csv', '.txt', '.tsv'],
  },

  queue: {
    // Bounded capacity -> producers get a 503 instead of blocking forever.
    capacity: int(process.env.QUEUE_CAPACITY, 250),
    // A low-priority task waiting longer than this is promoted to high
    // (aging) so it can never be starved indefinitely by a stream of
    // high-priority work.
    agingMs: int(process.env.QUEUE_AGING_MS, 12_000),
    // How many files may be in-flight (WAITING/PROCESSING) at once. Kept
    // >= worker pool size so small files are never blocked behind a big one.
    maxConcurrentProcesses: int(process.env.MAX_CONCURRENT_PROCESSES, Math.max(3, cpuCount)),
  },

  workers: {
    // Real web workers (worker_threads) power the all-reduce in server mode.
    poolSize: int(process.env.WORKER_POOL_SIZE, isServerless ? 2 : Math.max(2, cpuCount - 1)),
    // Rows of the CSV handed to a single worker call. Small enough that
    // progress animates and no single chunk hogs a worker for long
    // (breaks "no pre-emption" — a stuck chunk is cheap to kill and retry).
    chunkRows: int(process.env.WORKER_CHUNK_ROWS, 1_500),
    // Watchdog: a chunk that runs longer than this is force-terminated and
    // retried on a fresh worker.
    chunkTimeoutMs: int(process.env.WORKER_CHUNK_TIMEOUT_MS, 15_000),
    maxChunkRetries: int(process.env.WORKER_MAX_CHUNK_RETRIES, 2),
    // Artificial per-chunk delay so the processing animation is visible in a
    // demo. Set to 0 for raw throughput.
    demoDelayMs: int(process.env.WORKER_DEMO_DELAY_MS, 220),
    // Idle workers are shut down after this long (matters on serverless).
    idleShutdownMs: int(process.env.WORKER_IDLE_SHUTDOWN_MS, 60_000),
    // In serverless we cannot rely on background threads surviving between
    // invocations, so fall back to an inline chunked reducer.
    strategy: process.env.REDUCE_STRATEGY || (isServerless ? 'inline' : 'worker-pool'),
  },

  scheduler: {
    // Persistent tick cadence. In serverless the frontend drives ticks over
    // HTTP instead (see http/routes.js `/api/tick`).
    tickMs: int(process.env.SCHEDULER_TICK_MS, 90),
  },

  guard: {
    sweepMs: int(process.env.GUARD_SWEEP_MS, 2_000),
    // A process that shows no progress for this long while workers are idle
    // is nudged (should never happen, but self-heals if it does).
    stallMs: int(process.env.GUARD_STALL_MS, 20_000),
  },

  results: {
    // Completed results are kept addressable for this long so a client that
    // reconnects can still download its file. Then they are GC'd.
    ttlMs: int(process.env.RESULT_TTL_MS, 15 * 60 * 1000),
    recentLimit: int(process.env.RECENT_LIMIT, 30),
  },

  clients: {
    // A client with no heartbeat for this long is considered gone; its
    // still-queued tasks are cancelled so they don't occupy the queue.
    staleMs: int(process.env.CLIENT_STALE_MS, 45_000),
  },
};

export default config;
