import { EventEmitter } from 'node:events';
import { Client } from './Client.js';
import { NotFoundError } from '../util/errors.js';

/**
 * Hash-map registry of connected clients. Nothing exotic — but it is the
 * authority on "who is still here", which the deadlock guard uses to reap
 * tasks owned by vanished clients (a client that uploads then disappears
 * must not hold a queue slot forever).
 */
export class ClientRegistry extends EventEmitter {
  #clients = new Map();

  register(label) {
    const client = new Client({ label });
    this.#clients.set(client.id, client);
    this.emit('change');
    return client;
  }

  get(id) {
    return this.#clients.get(id);
  }

  require(id) {
    const c = this.#clients.get(id);
    if (!c) throw new NotFoundError(`Unknown client ${id}`);
    return c;
  }

  /**
   * Return the client for `id`, re-materialising it if it has been lost.
   * On serverless a follow-up request can land on a different (or cold)
   * instance that never saw the original `POST /api/clients`; rather than
   * 404 the upload, we trust the client's self-reported id and adopt it.
   */
  ensure(id, label) {
    let c = this.#clients.get(id);
    if (!c) {
      c = new Client({ label });
      c.id = id;
      this.#clients.set(id, c);
      this.emit('change');
    }
    return c;
  }

  heartbeat(id) {
    const c = this.#clients.get(id);
    if (c) c.heartbeat();
    return c;
  }

  remove(id) {
    const c = this.#clients.get(id);
    if (c) {
      this.#clients.delete(id);
      this.emit('change');
    }
    return c;
  }

  list() {
    return [...this.#clients.values()];
  }

  get size() {
    return this.#clients.size;
  }

  toJSON() {
    return this.list().map((c) => c.toJSON());
  }
}

export default ClientRegistry;
