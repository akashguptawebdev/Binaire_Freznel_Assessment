import { rootLogger } from '../util/Logger.js';

/**
 * Server-Sent Events fan-out.
 *
 * Why SSE and not WebSockets: the whole system also has to run as a Vercel
 * serverless function, where long-lived duplex sockets are not available.
 * SSE is plain HTTP, works through the same Express route table, and
 * degrades to ordinary polling (`GET /api/state`) if even streaming is
 * unavailable.
 *
 * `change` events from the engine are coalesced (at most one snapshot per
 * `minIntervalMs`) so a burst of task transitions doesn't flood every client.
 */
export class SseHub {
  #engine;
  #log;
  #connections = new Set(); // { id, clientId, res }
  #minIntervalMs;
  #pending = false;
  #timer = null;
  #lastFlush = 0;
  #heartbeat = null;
  #connSeq = 0;

  constructor(engine, { minIntervalMs = 120 } = {}) {
    this.#engine = engine;
    this.#minIntervalMs = minIntervalMs;
    this.#log = rootLogger.child('sse');

    engine.on('change', () => this.#scheduleFlush());
    engine.on('notify', (payload) => this.#notify(payload));

    this.#heartbeat = setInterval(() => this.#ping(), 15_000);
    this.#heartbeat.unref?.();
  }

  /** Express handler for `GET /api/stream?clientId=...` */
  handler = (req, res) => {
    const clientId = req.query.clientId || null;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const conn = { id: ++this.#connSeq, clientId, res };
    this.#connections.add(conn);
    this.#log.info(`stream open #${conn.id} (client ${clientId ?? 'anon'}), ${this.#connections.size} total`);

    // Prime the new subscriber immediately.
    this.#send(conn, 'snapshot', this.#engine.snapshot());

    req.on('close', () => {
      this.#connections.delete(conn);
      this.#log.info(`stream close #${conn.id}, ${this.#connections.size} left`);
    });
  };

  get connectionCount() {
    return this.#connections.size;
  }

  #scheduleFlush() {
    if (this.#pending) return;
    this.#pending = true;
    const wait = Math.max(0, this.#minIntervalMs - (Date.now() - this.#lastFlush));
    this.#timer = setTimeout(() => this.#flush(), wait);
    this.#timer.unref?.();
  }

  #flush() {
    this.#pending = false;
    this.#lastFlush = Date.now();
    if (this.#connections.size === 0) return;
    const snap = this.#engine.snapshot();
    for (const conn of this.#connections) this.#send(conn, 'snapshot', snap);
  }

  #notify(payload) {
    for (const conn of this.#connections) {
      if (!payload.clientId || conn.clientId === payload.clientId) {
        this.#send(conn, 'notify', payload);
      }
    }
  }

  #ping() {
    for (const conn of this.#connections) {
      try {
        conn.res.write(': ping\n\n');
      } catch {
        this.#connections.delete(conn);
      }
    }
  }

  #send(conn, event, data) {
    try {
      conn.res.write(`event: ${event}\n`);
      conn.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      this.#log.warn(`drop stream #${conn.id}: ${err.message}`);
      this.#connections.delete(conn);
    }
  }

  close() {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#timer) clearTimeout(this.#timer);
    for (const conn of this.#connections) {
      try {
        conn.res.end();
      } catch {
        /* ignore */
      }
    }
    this.#connections.clear();
  }
}

export default SseHub;
