import { rootLogger } from '../util/Logger.js';

/**
 * The DeadlockGuard is a periodic sweep that actively keeps the system in a
 * live state. It does not "detect a deadlock and recover" so much as it
 * continuously removes the pre-conditions for one:
 *
 *   - AGING      promote low-priority tasks that have waited too long, so a
 *                flood of high-priority work can never starve them.
 *   - WATCHDOG   if a process has pending chunks, no chunk in flight, and
 *                free workers exist, something dropped a `pump()` — kick it.
 *   - CLIENT GC  a client that uploaded then vanished must not keep queue
 *                slots or an active process; reap its tasks.
 *   - RESULT GC  drop finished results past their TTL so memory stays bounded.
 *
 * In server mode it runs on a timer. In serverless mode `sweep()` is called
 * opportunistically from HTTP handlers.
 */
export class DeadlockGuard {
  #engine;
  #scheduler;
  #registry;
  #config;
  #log;
  #timer = null;
  #counters = { watchdogKicks: 0, clientsReaped: 0, tasksReaped: 0, resultsExpired: 0, sweeps: 0 };
  #lastSweep = 0;

  constructor({ engine, scheduler, registry, config }) {
    this.#engine = engine;
    this.#scheduler = scheduler;
    this.#registry = registry;
    this.#config = config;
    this.#log = rootLogger.child('guard');
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.sweep(), this.#config.guard.sweepMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  counters() {
    return {
      ...this.#counters,
      agingPromotions: this.#scheduler.agingPromotions,
      lastSweep: this.#lastSweep,
    };
  }

  sweep() {
    this.#lastSweep = Date.now();
    this.#counters.sweeps += 1;

    // 1. Aging.
    this.#scheduler.promoteAging();

    // 2. Watchdog.
    const diag = this.#scheduler.diagnostics();
    if (diag.stalledProcesses > 0) {
      this.#counters.watchdogKicks += 1;
      this.#log.warn(`watchdog: ${diag.stalledProcesses} stalled process(es), forcing pump`);
      this.#scheduler.pump();
    }

    // 3. Stale-client GC.
    for (const client of this.#registry.list()) {
      if (client.idleMs > this.#config.clients.staleMs) {
        const reaped = this.#scheduler.reapForClient(client.id, 'client went away');
        this.#registry.remove(client.id);
        this.#counters.clientsReaped += 1;
        this.#counters.tasksReaped += reaped;
        if (reaped) this.#log.warn(`reaped ${reaped} task(s) from stale client ${client.id}`);
      }
    }

    // 4. Result TTL GC.
    this.#counters.resultsExpired += this.#engine.gcResults();

    // Always end a sweep by giving the scheduler a chance to progress.
    this.#scheduler.pump();
  }
}

export default DeadlockGuard;
