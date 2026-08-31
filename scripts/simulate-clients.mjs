import axios from 'axios';

/**
 * Load generator: spins up N virtual clients that each send M CSV files at
 * random times with random priority, then verifies every all-reduce result
 * against a locally-computed expected sum.
 *
 *   node scripts/simulate-clients.mjs --base http://localhost:4000 --clients 5 --files 6
 *
 * Demonstrates the brief's "any count of users (N) ... any number of files
 * (M) at any time" and that the system never deadlocks under contention.
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const BASE = args.base || process.env.BASE || 'http://localhost:4000';
const N = Number(args.clients || 5);
const M = Number(args.files || 6);
const http = axios.create({ baseURL: `${BASE}/api`, timeout: 30_000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function makeCsv() {
  const rows = randInt(50, 9000);
  const cols = randInt(3, 12);
  let sum = 0;
  const lines = new Array(rows);
  for (let r = 0; r < rows; r += 1) {
    const cells = new Array(cols);
    for (let c = 0; c < cols; c += 1) {
      const v = Math.random() < 0.4 ? Number((Math.random() * 200 - 100).toFixed(3)) : randInt(-500, 500);
      sum += v;
      cells[c] = v;
    }
    lines[r] = cells.join(',');
  }
  return { text: lines.join('\n') + '\n', rows, cols, expected: Number(sum.toPrecision(12)) };
}

async function uploadOne(clientId, idx) {
  const { text, rows, cols, expected } = makeCsv();
  const priority = Math.random() < 0.4 ? 'high' : 'low';
  const form = new FormData();
  form.append('clientId', clientId);
  form.append('priority', priority);
  form.append('file', new Blob([text], { type: 'text/csv' }), `sim-${clientId}-${idx}.csv`);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const { data } = await http.post('/uploads', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      return { taskId: data.task.id, expected, rows, cols, priority };
    } catch (err) {
      const code = err?.response?.data?.error?.code;
      if (code === 'QUEUE_FULL' && attempt <= 20) {
        await sleep(400 + attempt * 150); // back off and retry — never blocks
        continue;
      }
      throw err;
    }
  }
}

async function waitForResult(taskId, expected) {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await http.get(`/tasks/${taskId}`);
    const t = data.task;
    if (t.state === 'COMPLETED') {
      const ok = Math.abs(t.result - expected) < Math.max(1e-3, Math.abs(expected) * 1e-9);
      return { ok, got: t.result, expected, processId: t.processId, ms: t.finishedAt - t.startedAt };
    }
    if (t.state === 'FAILED' || t.state === 'CANCELLED') return { ok: false, state: t.state, error: t.error };
    await sleep(150);
  }
  return { ok: false, error: 'timeout' };
}

async function runClient(n) {
  const { data } = await http.post('/clients', { label: `sim-client-${n}` });
  const clientId = data.client.id;
  const jobs = [];
  for (let i = 0; i < M; i += 1) {
    await sleep(randInt(0, 900)); // "at any time"
    const submitted = await uploadOne(clientId, i);
    jobs.push(waitForResult(submitted.taskId, submitted.expected).then((r) => ({ ...submitted, ...r })));
  }
  return Promise.all(jobs);
}

(async () => {
  console.log(`simulating ${N} clients x ${M} files against ${BASE}`);
  const started = Date.now();
  const results = (await Promise.all(Array.from({ length: N }, (_, i) => runClient(i + 1)))).flat();
  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);

  for (const r of fail) console.error('  FAIL', r);
  console.log(
    `\n${pass}/${results.length} all-reduce results correct in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  const { data: snap } = await http.get('/state');
  console.log('server totals:', snap.totals);
  console.log('deadlock guard:', snap.guard);
  process.exit(fail.length ? 1 : 0);
})();
