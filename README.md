# Binaire · Freznel Assessment — Multi-user Queueing System

A multi-purpose **server queueing system** that accepts CSV files from any number
of client machines, schedules them by priority, reduces every number in each file
to a single scalar (**all-reduce**) using a pool of Node **web workers**, and
streams the complete queue status back to every client in real time — while
structurally preventing every class of deadlock.

Built with **JavaScript (ESM)**, **Node.js** (Express + `worker_threads`) on the
server and **React (Vite)** on the client. Functional logic is implemented with
**classes and OOP** throughout.

---

## Table of contents
- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [The file lifecycle (what each client sees)](#the-file-lifecycle)
- [How the all-reduce works](#how-the-all-reduce-works)
- [Deadlocks: the two questions](#deadlocks-the-two-questions)
- [Architecture & data structures](#architecture--data-structures)
- [Project layout](#project-layout)
- [Testing & load simulation](#testing--load-simulation)
- [Deployment](#deployment)

---

## What it does

- **N clients, M files, any time.** Every client machine registers itself and can
  send any number of CSVs whenever it likes, each tagged **high** or **low**
  priority.
- **CSV → single number.** Files hold integers and floats in any number of rows ×
  columns ("rank"). The server sums every value into one scalar.
- **Priority scheduling with fairness.** A binary-heap priority queue orders work
  high-before-low, FIFO within a band. **Aging** promotes any low-priority file
  that has waited too long, so nothing is ever starved.
- **Real web workers.** The reduce runs on a `worker_threads` pool. Files are
  split into row-chunks; chunks from all active files share the pool, highest
  priority first, re-evaluated after every chunk.
- **The server sends the file back.** On completion the reduced value is pushed
  over SSE and is downloadable as a result CSV.
- **Live queue board for everyone.** Every client sees the full queue — waiting
  list, active processes with completion %, worker pool utilisation, recently
  completed results, and the live deadlock-guard counters.
- **Deadlock-safe by construction.** See [below](#deadlocks-the-two-questions).

---

## Quick start

```bash
# 1. install
npm install            # server deps (express, multer, cors, axios)
npm run build          # installs + builds the React app into web/dist

# 2. run everything on one port
npm start              # http://localhost:4000
```

Then open <http://localhost:4000>, add a couple of client machines, drop a CSV
(or hit **generate random CSV**), and watch the queue.

**Dev mode with hot reload** (server on `:4000`, Vite on `:5173`):
```bash
npm run dev:all
```

**Make sample CSVs of varying rank:**
```bash
npm run gen:samples    # writes ./samples/*.csv
```

---

## The file lifecycle

Each file card walks through the exact states from the brief:

| # | State | Shown as | Detail shown |
|---|---|---|---|
| 1 | `UPLOADING`  | *File uploading*          | upload progress % |
| 2 | `UPLOADED`   | *File uploaded*          | rank (rows × cols), size |
| 3 | `QUEUED`     | *File added to queue*    | priority, queue position |
| 4 | `WAITING`    | *Waiting for processing* | **process ID** (`PID-0007`) |
| 5 | `PROCESSING` | *Processing…*            | **completion %**, chunk x/y, in-flight chunks |
| 6 | `COMPLETED`  | *Completed*              | all-reduce Σ, values counted, duration, **download** |

Plus `FAILED` / `CANCELLED` off-ramps. The transition history is available as a
per-file timeline.

---

## How the all-reduce works

```
upload ──► planCsv(): split rows into chunks of WORKER_CHUNK_ROWS
                        │
        ┌───────────────┼───────────────┐        (chunks from every active
        ▼               ▼               ▼         file compete for the pool,
   worker #1        worker #2       worker #3      highest priority first)
   local reduce     local reduce    local reduce
   {sum,count}      {sum,count}     {sum,count}
        └───────────────┼───────────────┘
                        ▼
       Task.finalizeReduce(): Σ partial sums ──► single scalar
                        │
        ┌───────────────┴───────────────────────────────┐
        ▼                                               ▼
   pushed to owning client (SSE)               broadcast to ALL clients
   + downloadable result CSV                   in the queue snapshot
```

The number matrix is never fully materialised — workers parse their own row
slice, so memory stays ≈ file size regardless of column count.

---

## Deadlocks: the two questions

> Full analysis with code references: **[docs/DEADLOCKS.md](docs/DEADLOCKS.md)**

### 1. Which types of deadlocks are possible?

| Deadlock | Root cause | Prevented by |
|---|---|---|
| **Worker-pool resource deadlock** | tasks holding a worker while waiting for another (hold-and-wait + circular wait) | one worker held per **single chunk** then released; workers never wait on workers; stuck chunk is killed + retried (pre-emption) |
| **Producer/consumer (bounded queue) deadlock** | full queue blocking the uploader | queue never blocks — returns retryable `503 QUEUE_FULL`; client backs off |
| **Priority inversion / starvation (livelock)** | endless high-priority stream buries low-priority files | **aging** promotes long-waiting low-priority tasks; queue re-heapified every guard sweep |
| **Client ↔ server response deadlock** | server waits for client ack, client waits for server result | server never waits on a client; results go to a TTL store + SSE push |
| **Orphaned-process / cleanup deadlock** | disconnected client keeps a concurrency slot and busy workers | heartbeat + stale-client sweep cancels tasks, drains chunks, frees the slot |
| **Lock-ordering deadlock** | inconsistent lock acquisition order | **there are no locks** — engine state mutates synchronously on the event loop; workers are share-nothing |

### 2. How can the deadlocks affect productivity of the users?

- Files stuck forever at *Waiting for processing* → users think it's broken and
  **re-upload**, amplifying load.
- Throughput collapses to zero **while workers sit idle** behind a circular wait
  — every client blocked, not just one.
- Low-priority teams get **no results at all** during busy periods (starvation).
- Compute wasted on abandoned jobs → slower results and higher cost for everyone.
- The only fix for a wedged in-memory queue is a **restart**, dropping every
  in-flight job for every client.
- Repeated unexplained stalls erode trust and push users to work around the
  system.

The design guarantees the **worst case is a retryable `503`, never a hang.**

---

## Architecture & data structures

> Diagrams and the full class table: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

**Classes (OOP, one responsibility each):** `QueueEngine` (façade) · `Scheduler`
· `PriorityQueue` (binary heap) · `WorkerPool` / `InlineReducer` (interchangeable
reduce strategies) · `DeadlockGuard` · `Task` (state machine) · `Client` ·
`ClientRegistry` · `RingBuffer` · `SseHub` · `Logger`.

**Data structures:** binary min-heap priority queue (with `remove` + `reheapify`)
· hash maps for all id lookups · ring buffer for recent results · finite state
machine with a transition table · FIFO waiter queue in the worker pool.

**Race-free execution:** single Node event loop, no locks; the only parallelism
is inside share-nothing worker threads.

---

## Project layout

```
Binaire_Freznel_Assessment/
├── server/
│   ├── src/
│   │   ├── index.js              long-lived entrypoint (npm start)
│   │   ├── app.js                builds the Express app (shared)
│   │   ├── config.js             env-driven config
│   │   ├── engine/
│   │   │   ├── QueueEngine.js     façade
│   │   │   ├── Scheduler.js       priority queue + chunk dispatch + aging
│   │   │   ├── PriorityQueue.js   binary heap
│   │   │   ├── WorkerPool.js      worker_threads pool + watchdog
│   │   │   ├── InlineReducer.js   serverless fallback (same interface)
│   │   │   ├── DeadlockGuard.js   aging · watchdog · GC sweep
│   │   │   ├── Task.js            state machine + history
│   │   │   ├── TaskState.js       transition table
│   │   │   ├── Client.js / ClientRegistry.js
│   │   │   └── RingBuffer.js
│   │   ├── workers/reduceWorker.js   the web worker
│   │   ├── http/  routes.js · SseHub.js
│   │   └── util/  csv.js · Logger.js · errors.js · ids.js
│   └── tests/engine.test.js      node --test
├── api/index.js                  Vercel serverless entrypoint
├── web/                          React + Vite dashboard
│   └── src/
│       ├── App.jsx
│       ├── hooks/  useEngineStream.js · useClientMachines.js
│       ├── components/  ClientMachineCard · FileStatusCard · QueueBoard · WorkerRack · DeadlockPanel · …
│       └── api/client.js         axios + SSE
├── scripts/  generate-samples.mjs · simulate-clients.mjs · dev.mjs
├── docs/     ARCHITECTURE.md · DEADLOCKS.md · DEPLOYMENT.md
├── vercel.json · render.yaml · Dockerfile
```

---

## Testing & load simulation

```bash
npm test        # unit tests: heap, ring buffer, CSV reduce, all-reduce correctness,
                # bounded-queue rejection, aging

# multi-client load test — proves no deadlock under contention and that every
# all-reduce result is numerically correct
npm start &                                   # or point --base at a deployed URL
npm run simulate -- --clients 10 --files 8
```

The simulator spins up virtual clients that each send files at random times with
random priority, retries `QUEUE_FULL` with backoff, then verifies every returned
scalar against a locally computed sum.

---

## Deployment

> Full guide: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

- **Vercel** (single platform): `vercel.json` builds `web/` static + runs the API
  as a serverless function (`api/index.js`). Serverless mode swaps the worker
  pool for an inline chunked reducer and drives the scheduler via HTTP ticks.
- **Render / Docker / any Node host** (recommended for a true stateful queue):
  one process, real `worker_threads`, background scheduler + guard, serves the
  dashboard. `render.yaml` and `Dockerfile` included.

---

## Links

- **GitHub:** <https://github.com/akashguptawebdev/Binaire_Freznel_Assessment>
- **Live demo:** _deploy via Vercel (import the repo — `vercel.json` is preconfigured) or Render (`render.yaml`), then paste the URL here_

## Submission

- **Repo name:** `Binaire_Freznel_Assessment`
- **Email subject:** `Javascript Developer - Multi-user queueing system Assessment`
- **Send to:** hr@binaire.app
