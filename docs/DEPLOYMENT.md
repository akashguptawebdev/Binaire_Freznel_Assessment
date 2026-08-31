# Deployment

There are two supported topologies. Both are in the repo.

## A. Vercel (single platform — what the brief asks for)

Vercel hosts:
- the **React dashboard** as a static build (`web/dist`)
- the **API** as a serverless function (`api/index.js`) that mounts the exact
  same Express app + `QueueEngine`

### Steps
1. Push this repo to GitHub as `Binaire_Freznel_Assessment`.
2. On Vercel: **New Project → import the repo**. The included `vercel.json` sets:
   - build: `cd web && npm install && npm run build`
   - output: `web/dist`
   - function: `api/index.js` (`/api/*` rewritten to it)
3. Deploy. No environment variables are required.

### What changes in serverless mode
`api/index.js` sets nothing itself — Vercel exposes `process.env.VERCEL`, which
flips `config.isServerless`:

| | server mode | serverless (Vercel) |
|---|---|---|
| Reduce strategy | `worker_threads` pool | inline chunked reducer (`InlineReducer`) — a frozen lambda can't be trusted to keep background threads alive between invocations |
| Scheduler advance | background `setInterval` | every HTTP request calls `engine.tick()`, and the dashboard polls `POST /api/tick` ~1×/s |
| Realtime | SSE stream | SSE if the platform holds the connection; the client auto-falls-back to polling `GET /api/state` |
| Queue persistence | process lifetime | warm-lambda lifetime — a cold start begins with an empty queue |

This is a genuine, working demo. For a production multi-user queue you'd want the
long-lived server (topology B), because a serverless queue can't guarantee a job
survives a cold start.

## B. Long-lived Node server (Render / Railway / Fly / Docker / local)

One process runs the queue engine (real `worker_threads` + background scheduler +
deadlock guard) **and** serves the built dashboard from `web/dist`.

### Render (config included: `render.yaml`)
- New → Blueprint → point at the repo. `render.yaml` does the rest
  (`npm install && npm run build`, then `npm start`).

### Docker (config included: `Dockerfile`)
```bash
docker build -t freznel-queue .
docker run -p 4000:4000 freznel-queue
# open http://localhost:4000
```

### Bare Node
```bash
npm install
npm run build          # builds web/dist
npm start              # http://localhost:4000
```

## Pointing a separately-hosted frontend at a backend

If you host the frontend and backend apart, open the dashboard with
`?api=https://your-backend` once — it's stored in `localStorage` and reused.
Or set `VITE_API_BASE` at build time.

## Environment variables (all optional)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `WORKER_POOL_SIZE` | `cpus-1` (server) / `2` (serverless) | worker threads |
| `WORKER_CHUNK_ROWS` | `1500` | CSV rows per chunk |
| `WORKER_CHUNK_TIMEOUT_MS` | `15000` | watchdog: kill + retry a stuck chunk |
| `WORKER_DEMO_DELAY_MS` | `220` | artificial per-chunk delay so progress animates; set `0` for raw speed |
| `QUEUE_CAPACITY` | `250` | bounded queue size → `503 QUEUE_FULL` past this |
| `QUEUE_AGING_MS` | `12000` | low-priority task older than this is promoted |
| `MAX_CONCURRENT_PROCESSES` | `max(3, cpus)` | files processed concurrently |
| `RESULT_TTL_MS` | `900000` | how long a finished result stays downloadable |
| `CLIENT_STALE_MS` | `45000` | no heartbeat past this → client + tasks reaped |
| `REDUCE_STRATEGY` | `worker-pool` / `inline` | override the reduce strategy |
