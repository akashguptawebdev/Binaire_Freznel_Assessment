# Architecture

## 1. High-level flow

```
 ┌───────────────┐   multipart POST /api/uploads (clientId, priority, file)
 │ Client machine│ ─────────────────────────────────────────────►┐
 │  (React card) │                                               │
 │               │ ◄───────── SSE /api/stream (queue snapshots) ──┤
 └───────────────┘                                               │
        ▲                                                        ▼
        │ GET /api/tasks/:id/result/file            ┌────────────────────────┐
        │ (server sends the file back)              │      QueueEngine       │  façade
        └──────────────────────────────────────────►│  ┌──────────────────┐  │
                                                    │  │ ClientRegistry   │  │  hash map
                                                    │  ├──────────────────┤  │
                                                    │  │ Scheduler        │  │  binary-heap priority queue
                                                    │  │   ├ PriorityQueue │  │  + chunk-level dispatch
                                                    │  │   └ active procs  │  │
                                                    │  ├──────────────────┤  │
                                                    │  │ WorkerPool  ─────┼──┼──► worker_threads
                                                    │  │  (InlineReducer  │  │    reduceWorker.js  × N
                                                    │  │   on serverless) │  │    (local reduce → partial sum)
                                                    │  ├──────────────────┤  │
                                                    │  │ DeadlockGuard    │  │  aging · watchdog · GC
                                                    │  ├──────────────────┤  │
                                                    │  │ results (TTL)    │  │  map + RingBuffer(recent)
                                                    │  └──────────────────┘  │
                                                    └────────────────────────┘
```

## 2. The all-reduce

"Add all numbers present in the file into a single number (all-reduce)."

1. `planCsv()` (`server/src/util/csv.js`) splits the upload into **row-range
   chunks** of `WORKER_CHUNK_ROWS` lines each. It never materialises the number
   matrix — peak memory ≈ file size.
2. Each chunk is sent to a **web worker** (`reduceWorker.js`), which computes a
   **local reduce** `{ sum, count }` over its slice (comma / tab / semicolon /
   whitespace separated; non-numeric tokens ignored).
3. The scheduler accumulates every chunk's partial sum on the `Task`
   (`Task.recordChunkResult`).
4. When the last chunk lands, `Task.finalizeReduce()` folds all partial sums into
   the **single output scalar** — this is the reduced value.
5. The scalar is (a) returned in every queue snapshot, (b) pushed to the owning
   client via SSE `notify`, and (c) downloadable as a result CSV
   (`GET /api/tasks/:id/result/file`) — "server sends the file back to the
   client". Broadcasting the same scalar to *all* clients via the snapshot is the
   "all" in all-reduce.

Chunks from **all** active files share the worker pool, always dispatched
highest-priority-first and re-evaluated after every single chunk
(`Scheduler.#dispatchChunks`). A 5-row high-priority file is never stuck behind a
200 000-row low-priority one.

## 3. Data structures

| Structure | File | Role |
|---|---|---|
| **Binary min-heap** (`PriorityQueue`) | `engine/PriorityQueue.js` | the waiting queue; `push`/`pop` O(log n), plus `remove(predicate)` for cancellation and `reheapify()` after aging mutates keys |
| **Hash maps** (`Map`) | `ClientRegistry`, `Scheduler.#active`, `Scheduler.#plans`, `QueueEngine.#tasks/#results` | O(1) lookup by id everywhere |
| **Ring buffer** (`RingBuffer`) | `engine/RingBuffer.js` | fixed-size "recently completed" strip without unbounded growth |
| **Finite state machine** | `engine/TaskState.js` | `TRANSITIONS` table; illegal transitions throw — guards against the scheduler and guard racing a task into an impossible state |
| **FIFO waiter queue** | `WorkerPool.#waiters` | fair hand-off of the next free worker; no waiter can be starved |

## 4. OOP class breakdown

Every unit of behaviour is a class with a single responsibility:

| Class | Responsibility |
|---|---|
| `QueueEngine` | façade: wires everything, owns result store + totals, emits `change` / `notify` |
| `Scheduler` | waiting queue, admission control, chunk-level dispatch, aging, cancellation |
| `PriorityQueue` | generic binary heap (comparator injected) |
| `WorkerPool` | fixed pool of `worker_threads`, non-blocking `runChunk`, watchdog, idle shutdown |
| `InlineReducer` | drop-in replacement for `WorkerPool` on serverless (same interface) |
| `DeadlockGuard` | periodic sweep: aging, watchdog, stale-client GC, result GC |
| `Task` (`extends EventEmitter`) | one file's identity, rank, chunk plan, partial sums, state machine, history |
| `Client` | one client machine: id, heartbeat, per-client stats |
| `ClientRegistry` | hash-map registry + change events |
| `RingBuffer` | fixed-capacity circular buffer |
| `Logger` | leveled structured logging, zero deps |
| `SseHub` | SSE fan-out with coalesced snapshots |

Polymorphism in practice: `Scheduler` depends only on the **shape** `{ runChunk,
freeCount, stats, shutdown }`, so `WorkerPool` and `InlineReducer` are
interchangeable and selected by `REDUCE_STRATEGY` at construction time.

## 5. Execution model (why it's race-free)

Node runs one thread. All engine state changes happen **synchronously between
`await` points**, so there are no locks and no shared-memory races. The only
parallelism is inside worker threads, which are share-nothing: in they get an
array of line strings, out comes `{ sum, count }`.

Two ways the wheel turns:
- **server mode** — `setInterval` tick (`SCHEDULER_TICK_MS`) + guard sweep
  (`GUARD_SWEEP_MS`) run in the background.
- **serverless mode** — no reliable background timer, so every HTTP request calls
  `engine.tick()` and the frontend also polls `POST /api/tick`.

## 6. Transport

- `POST /api/clients` — register a client machine → `{ client }`
- `POST /api/clients/:id/heartbeat` — keep-alive
- `DELETE /api/clients/:id` — disconnect (reaps that client's tasks)
- `POST /api/uploads` — `multipart/form-data` (`file`, `clientId`, `priority`) → `{ task }` or `503 QUEUE_FULL`
- `GET  /api/tasks/:id` — one task's full state + history
- `POST /api/tasks/:id/cancel` — cancel (owner only)
- `GET  /api/tasks/:id/result` — result summary JSON
- `GET  /api/tasks/:id/result/file` — **download the reduced result as CSV**
- `GET  /api/state` — full queue snapshot (polling fallback)
- `GET  /api/stream` — Server-Sent Events: `snapshot` + `notify`
- `POST /api/tick` — advance the scheduler (serverless)
- `GET  /api/health` — liveness
