# Deadlock analysis

The brief asks two questions directly:

1. **Which types of deadlocks are possible?**
2. **How can the deadlocks affect productivity of the users?**

This document answers both and then maps every mitigation to the code.

---

## 0. The four Coffman conditions

A deadlock needs all four of these at once:

| Condition | Meaning |
|---|---|
| Mutual exclusion | a resource can be held by only one party |
| Hold and wait | a party holds one resource while blocking for another |
| No pre-emption | a resource can't be forcibly taken back |
| Circular wait | a cycle of parties each waiting on the next |

Break **any one** and deadlock is impossible. This system breaks at least two on
every resource it manages.

---

## 1. Types of deadlock possible in this system

### 1.1 Worker-pool resource deadlock
**Scenario.** Files are processed in chunks by a pool of `worker_threads`. A naive
design lets a task grab worker #1 for chunk A and then block waiting for worker
#2 for chunk B. Two large files doing this in mirror image hold one worker each
and wait forever for a second — classic hold-and-wait + circular wait.

**How it's prevented here**
- A worker is acquired for **exactly one chunk** and released the instant that
  chunk resolves (`WorkerPool.#release`). A task never holds a worker across its
  whole file → **no hold-and-wait**.
- Partial sums are accumulated in the scheduler, not inside a worker, so workers
  never wait on each other → **no circular wait**.
- `runChunk()` returns a **promise** and never blocks the event loop; the
  scheduler, HTTP layer and guard keep running while chunks are in flight.
- A chunk exceeding `WORKER_CHUNK_TIMEOUT_MS` is force-terminated and retried on
  a fresh worker (`WorkerPool.#timeoutJob`) → **pre-emption exists**.

### 1.2 Producer / consumer (bounded-queue) deadlock
**Scenario.** The queue must be bounded (unbounded = OOM). If a full queue
*blocks* the uploading client while the consumer is itself blocked on something
else, both sides sleep forever.

**How it's prevented here**
- The queue is bounded (`QUEUE_CAPACITY`) but **never blocks a producer**. A full
  queue throws `QueueFullError` → HTTP `503` with `code: "QUEUE_FULL"` and
  `retryable: true` (`Scheduler.enqueue`).
- The client backs off and retries (`ClientMachineCard` retry button;
  `scripts/simulate-clients.mjs` exponential backoff). The producer is never
  suspended while holding a resource.

### 1.3 Priority inversion & starvation (livelock)
**Scenario.** A continuous stream of **high**-priority uploads means **low**-priority
files are never scheduled. No classic deadlock, but from the user's chair it is
indistinguishable from one — the file sits at "Waiting for processing" forever.

**How it's prevented here**
- **Aging.** `Scheduler.promoteAging()` promotes any low-priority task that has
  waited longer than `QUEUE_AGING_MS` to high priority, then `reheapify()`s the
  queue. Run every guard sweep (`DeadlockGuard.sweep`, default 2 s).
- Because promotion is monotonic and the queue always drains highest-priority
  first, every task is guaranteed to run in bounded time.
- The live counter `guard.agingPromotions` in the UI shows this happening.

### 1.4 Client ↔ server response deadlock
**Scenario.** Server holds a job "open" waiting for the client to acknowledge
receipt; client waits for the server to finish before it acknowledges. Circular
wait across the network.

**How it's prevented here**
- The server **never waits on a client**. On completion the result is written to
  a TTL store (`QueueEngine.#results`) and an SSE `notify` is pushed. The client
  pulls `GET /api/tasks/:id/result/file` whenever it wants.
- If the client never comes back, the result simply expires
  (`RESULT_TTL_MS`, `QueueEngine.gcResults`).

### 1.5 Orphaned-process / cleanup deadlock
**Scenario.** A client disconnects mid-processing. Its process record keeps a
concurrency slot; workers burn cycles on output nobody will collect; the slot is
never freed so healthy clients queue behind a ghost.

**How it's prevented here**
- Heartbeats: each client machine pings `POST /api/clients/:id/heartbeat` every
  12 s.
- The guard's stale-client sweep (`CLIENT_STALE_MS`) cancels the client's queued
  tasks, drains in-flight chunks, retires the process and frees the slot
  (`Scheduler.reapForClient`).

### 1.6 Lock-ordering deadlock (why it can't happen here)
There are **no locks**. All scheduler state is mutated synchronously on the Node
event loop between `await` points, so there is no shared-memory race and no lock
hierarchy to get wrong. The only concurrency is inside worker threads, which are
share-nothing (they receive an array of strings, return a scalar).

---

## 2. How deadlocks affect user productivity

| Effect | Consequence for users |
|---|---|
| Files stuck forever at "Waiting for processing" | Users assume the app is broken, re-upload the same file repeatedly, which **amplifies load** and makes recovery harder. |
| Throughput drops to zero while workers sit idle | A circular wait can wedge the whole pipeline even though CPU is free — every client is blocked, not just one. |
| Low-priority work never completes | During busy periods an entire class of users (batch jobs, back-office teams) gets **no results at all** — effectively an outage for them. |
| Wasted compute on abandoned jobs | Workers pinned to jobs whose owner has left → higher cost, slower results for everyone still waiting. |
| Operator toil | The only fix for a wedged in-memory queue is a **restart**, which drops every in-flight job for every client. |
| Loss of trust | Intermittent, unexplained stalls train users to distrust the system and route around it. |

The system is designed so that the **worst case is a retryable `503`**, never an
indefinite hang.

---

## 3. Where to see it in the code

| Concern | File |
|---|---|
| Bounded queue, priority order, aging, chunk-level fairness | `server/src/engine/Scheduler.js` |
| One-chunk-at-a-time worker holding, watchdog pre-emption, FIFO waiters | `server/src/engine/WorkerPool.js` |
| Aging / watchdog / stale-client / result-TTL sweep | `server/src/engine/DeadlockGuard.js` |
| Retryable `QUEUE_FULL` error | `server/src/util/errors.js` |
| State-machine that rejects illegal transitions | `server/src/engine/TaskState.js` |
| Load test proving no deadlock under contention | `scripts/simulate-clients.mjs` |
