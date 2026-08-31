import React from 'react';

/**
 * Visualises the worker_threads pool. Each cell is one worker slot; a lit
 * cell is currently reducing a chunk. Waiters (chunks queued for a free
 * worker) are shown as a trailing count.
 */
export default function WorkerRack({ workers }) {
  const size = workers?.size ?? 0;
  const busy = workers?.busy ?? 0;
  const alive = workers?.alive ?? 0;
  const cells = Array.from({ length: size }, (_, i) => {
    if (i < busy) return 'busy';
    if (i < alive) return 'idle';
    return 'cold';
  });

  return (
    <div className="worker-rack" aria-label="worker pool">
      <div className="worker-rack-head">
        <span>Web worker pool</span>
        <span className="muted">
          {busy}/{size} reducing{workers?.waiters ? ` · ${workers.waiters} chunk(s) waiting` : ''}
        </span>
      </div>
      <div className="worker-cells">
        {cells.map((kind, i) => (
          <span key={i} className={`worker-cell worker-cell-${kind}`} title={`worker ${i + 1}: ${kind}`} />
        ))}
      </div>
      <div className="worker-rack-foot muted">
        {workers?.mode === 'inline'
          ? 'inline chunked reducer (serverless fallback)'
          : `${workers?.completed ?? 0} chunks done · ${workers?.timedOut ?? 0} timed out · ${workers?.replaced ?? 0} replaced`}
      </div>
    </div>
  );
}
