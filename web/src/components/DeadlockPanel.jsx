import React, { useState } from 'react';

const RISKS = [
  {
    name: 'Worker-pool resource deadlock',
    coffman: 'mutual exclusion · hold-and-wait · no pre-emption · circular wait',
    how: 'A task grabs a worker for chunk A, then waits for a second worker for chunk B while another task does the mirror — nobody releases, nobody proceeds.',
    fix: 'Workers are held for exactly one chunk and released immediately (no hold-and-wait). Workers never wait on each other (no circular wait). A stuck chunk is killed by the watchdog and retried (pre-emption).',
  },
  {
    name: 'Producer / consumer (bounded queue) deadlock',
    coffman: 'hold-and-wait on queue space',
    how: 'If the queue blocked producers when full while consumers blocked on something else, both sides sleep forever.',
    fix: 'The queue is bounded but never blocks: a full queue returns HTTP 503 QUEUE_FULL and the client backs off and retries. Producers are never suspended holding anything.',
  },
  {
    name: 'Priority inversion & starvation (livelock)',
    coffman: 'indefinite postponement',
    how: 'A continuous stream of high-priority uploads means low-priority files are never scheduled — effectively deadlocked from the user’s point of view.',
    fix: 'Aging: a low-priority task waiting longer than QUEUE_AGING_MS is promoted to high. The guard sweep re-heapifies the queue so it always drains.',
  },
  {
    name: 'Client ↔ server response deadlock',
    coffman: 'circular wait across the network',
    how: 'Server keeps a job "open" waiting for the client to acknowledge; client waits for the server to finish before acknowledging.',
    fix: 'The server never waits on a client. Results are written to a TTL store and pushed via SSE; the client pulls its file whenever it likes. A client that vanishes is GC’d and its queue slots freed.',
  },
  {
    name: 'Orphaned-process / cleanup deadlock',
    coffman: 'lost resource holder',
    how: 'A client disconnects mid-processing; its process record keeps a queue slot and workers busy on output nobody will collect.',
    fix: 'Stale-client sweep cancels queued tasks and drains in-flight chunks for gone clients, then retires the process and frees the slot.',
  },
];

const IMPACT = [
  'Uploads that never leave "Waiting for processing" — users assume the app is broken and re-upload, amplifying load.',
  'Throughput collapses to zero while workers sit idle behind a circular wait.',
  'Low-priority teams get no results at all during busy periods (starvation).',
  'Wasted compute: workers pinned on jobs whose owner has left.',
  'Operator time lost restarting the server to clear a wedged queue.',
];

export default function DeadlockPanel({ snapshot }) {
  const [open, setOpen] = useState(false);
  const g = snapshot?.guard || {};
  return (
    <section className="deadlock-panel">
      <div className="dp-head" onClick={() => setOpen((o) => !o)} role="button" tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}>
        <h3>Deadlock prevention</h3>
        <div className="dp-live">
          <span title="low-priority tasks promoted by aging">aging&nbsp;{g.agingPromotions ?? 0}</span>
          <span title="scheduler nudges after a detected stall">watchdog&nbsp;{g.watchdogKicks ?? 0}</span>
          <span title="tasks reclaimed from vanished clients">reaped&nbsp;{g.tasksReaped ?? 0}</span>
          <span title="guard sweeps run">sweeps&nbsp;{g.sweeps ?? 0}</span>
          <span className="dp-toggle">{open ? '▾' : '▸'}</span>
        </div>
      </div>

      {open && (
        <div className="dp-body">
          <div className="dp-risks">
            {RISKS.map((r) => (
              <article key={r.name} className="dp-risk">
                <h4>{r.name}</h4>
                <p className="dp-coffman">{r.coffman}</p>
                <p><span className="dp-tag dp-tag-bad">risk</span>{r.how}</p>
                <p><span className="dp-tag dp-tag-good">handled</span>{r.fix}</p>
              </article>
            ))}
          </div>
          <div className="dp-impact">
            <h4>How deadlocks hurt user productivity</h4>
            <ul>
              {IMPACT.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
