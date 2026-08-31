import React from 'react';
import { stateMeta } from '../lib/taskState.js';
import { formatNumber, formatDuration, timeAgo } from '../lib/format.js';

function PriorityBadge({ priority, promoted }) {
  if (promoted) return <span className="prio prio-promoted" title="aged up from low to avoid starvation">low ▲ high</span>;
  return <span className={`prio prio-${priority}`}>{priority}</span>;
}

function ProgressBar({ value, tone }) {
  return (
    <div className="pbar">
      <div className={`pbar-fill pbar-${tone}`} style={{ width: `${Math.max(2, value)}%` }} />
      <span className="pbar-label">{value}%</span>
    </div>
  );
}

function clientLabel(clients, id) {
  return clients?.find((c) => c.id === id)?.label || id?.slice(0, 12) || 'unknown';
}

export default function QueueBoard({ snapshot }) {
  const waiting = snapshot?.queue?.waiting || [];
  const active = snapshot?.queue?.active || [];
  const recent = snapshot?.recent || [];
  const clients = snapshot?.clients || [];

  return (
    <section className="queue-board">
      <div className="board-col">
        <h3>
          Waiting queue <span className="count">{waiting.length}</span>
        </h3>
        <p className="col-hint">ordered by priority, then first-in-first-out. Aged items jump the line.</p>
        <ol className="board-list">
          {waiting.map((t, i) => (
            <li key={t.id} className="board-row row-waiting" style={{ '--i': i }}>
              <span className="rank-no">{i + 1}</span>
              <div className="row-main">
                <div className="row-title">
                  <span className="fname">{t.fileName}</span>
                  <PriorityBadge priority={t.priority} promoted={t.promoted} />
                </div>
                <div className="row-meta muted">
                  {clientLabel(clients, t.clientId)} · {t.rank.rows}×{t.rank.cols} · {t.chunksTotal} chunks · waited{' '}
                  {formatDuration(t.waitedMs)}
                </div>
              </div>
            </li>
          ))}
          {waiting.length === 0 && <li className="board-empty">queue is empty</li>}
        </ol>
      </div>

      <div className="board-col">
        <h3>
          Processing <span className="count">{active.length}</span>
        </h3>
        <p className="col-hint">chunks from every active file share the worker pool, highest priority first.</p>
        <ol className="board-list">
          {active.map((t) => {
            const meta = stateMeta(t.state);
            return (
              <li key={t.id} className={`board-row row-active tone-${meta.tone}`}>
                <div className="row-main">
                  <div className="row-title">
                    <span className="fname">{t.fileName}</span>
                    <PriorityBadge priority={t.priority} promoted={t.promoted} />
                    <span className="pidtag">{t.processId}</span>
                  </div>
                  <ProgressBar value={t.progress} tone={meta.tone} />
                  <div className="row-meta muted">
                    {clientLabel(clients, t.clientId)} · {meta.label} · {t.chunksDone}/{t.chunksTotal} chunks
                    {t.inFlightChunks ? ` · ${t.inFlightChunks} in flight` : ''}
                  </div>
                </div>
              </li>
            );
          })}
          {active.length === 0 && <li className="board-empty">no active processes</li>}
        </ol>
      </div>

      <div className="board-col">
        <h3>
          Recently completed <span className="count">{recent.length}</span>
        </h3>
        <p className="col-hint">the all-reduced scalar returned to each client.</p>
        <ol className="board-list">
          {recent.map((r) => (
            <li key={r.id + r.finishedAt} className={`board-row row-recent recent-${(r.state || '').toLowerCase()}`}>
              <div className="row-main">
                <div className="row-title">
                  <span className="fname">{r.fileName}</span>
                  <span className={`chip chip-${(r.state || '').toLowerCase()}`}>{r.state}</span>
                </div>
                <div className="row-meta muted">
                  {clientLabel(clients, r.clientId)} ·{' '}
                  {r.state === 'COMPLETED' ? (
                    <>
                      Σ = <strong className="sum">{formatNumber(r.result)}</strong> · {formatNumber(r.valuesCounted)} values ·{' '}
                      {formatDuration(r.durationMs)}
                    </>
                  ) : (
                    <>{r.state.toLowerCase()}</>
                  )}{' '}
                  · {timeAgo(r.finishedAt)}
                </div>
              </div>
            </li>
          ))}
          {recent.length === 0 && <li className="board-empty">nothing finished yet</li>}
        </ol>
      </div>
    </section>
  );
}
