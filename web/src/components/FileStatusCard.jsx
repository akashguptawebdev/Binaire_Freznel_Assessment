import React, { useState } from 'react';
import { STEP_SEQUENCE, stateMeta, isTerminal } from '../lib/taskState.js';
import { formatBytes, formatNumber, formatDuration } from '../lib/format.js';
import { api } from '../api/client.js';

function Stepper({ state }) {
  const meta = stateMeta(state);
  const currentStep = meta.step;
  const failed = state === 'FAILED' || state === 'CANCELLED';
  return (
    <ol className="stepper">
      {STEP_SEQUENCE.map((s, idx) => {
        const stepNo = idx + 1;
        const done = stepNo < currentStep || (state === 'COMPLETED' && stepNo <= 6);
        const active = stepNo === currentStep && !isTerminal(state);
        return (
          <li
            key={s}
            className={`step ${done ? 'is-done' : ''} ${active ? 'is-active' : ''} ${
              failed && stepNo === currentStep ? 'is-failed' : ''
            }`}
          >
            <span className="step-dot">{done ? '✓' : stepNo}</span>
            <span className="step-label">{stateMeta(s).label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default function FileStatusCard({ entry, clientId }) {
  const [showTimeline, setShowTimeline] = useState(false);
  const task = entry.task;
  const state = task?.state || (entry.uploadPct < 100 ? 'UPLOADING' : 'UPLOADED');
  const meta = stateMeta(state);

  const canCancel = task && !isTerminal(task.state);
  const progress =
    state === 'UPLOADING' ? entry.uploadPct : state === 'PROCESSING' ? task.progress : state === 'COMPLETED' ? 100 : task?.progress ?? 0;

  return (
    <article className={`file-card tone-${meta.tone} ${state === 'PROCESSING' ? 'is-processing' : ''}`}>
      <div className="fc-top">
        <div className="fc-name">
          <span className="fc-file">{entry.fileName}</span>
          <span className={`prio prio-${entry.priority}`}>{entry.priority}</span>
        </div>
        <div className="fc-actions">
          {canCancel && (
            <button className="btn-ghost btn-danger" onClick={() => api.cancel(task.id, clientId)}>
              cancel
            </button>
          )}
          {state === 'COMPLETED' && (
            <a className="btn-solid" href={api.resultFileUrl(task.id)} download>
              ⬇ result CSV
            </a>
          )}
        </div>
      </div>

      <Stepper state={state} />

      {(state === 'UPLOADING' || state === 'PROCESSING' || state === 'COMPLETED') && (
        <div className="pbar">
          <div className={`pbar-fill pbar-${meta.tone}`} style={{ width: `${Math.max(3, progress)}%` }} />
          <span className="pbar-label">{Math.round(progress)}%</span>
        </div>
      )}

      <div className="fc-detail">
        {state === 'WAITING' && (
          <span className="fc-line">
            Waiting for processing · <span className="pidtag">{task.processId}</span>
          </span>
        )}
        {state === 'PROCESSING' && (
          <span className="fc-line">
            <span className="pidtag">{task.processId}</span> · chunk {task.chunksDone}/{task.chunksTotal}
            {task.inFlightChunks ? ` · ${task.inFlightChunks} in flight` : ''}
          </span>
        )}
        {state === 'COMPLETED' && (
          <span className="fc-line fc-result">
            all-reduce Σ = <strong>{formatNumber(task.result)}</strong>
            <span className="muted">
              {' '}
              · {formatNumber(task.valuesCounted)} values · {formatDuration(task.finishedAt - task.startedAt)}
            </span>
          </span>
        )}
        {state === 'FAILED' && <span className="fc-line fc-err">{task.error || 'processing failed'}</span>}
        {state === 'CANCELLED' && <span className="fc-line muted">cancelled</span>}
        {entry.error && <span className="fc-line fc-err">{entry.error}</span>}

        <span className="fc-line muted">
          {formatBytes(entry.sizeBytes)}
          {task?.rank ? ` · rank ${task.rank.rows}×${task.rank.cols}` : ''}
          {task?.chunksTotal ? ` · ${task.chunksTotal} chunks` : ''}
        </span>
      </div>

      {task?.history?.length > 1 && (
        <div className="fc-timeline-wrap">
          <button className="link-btn" onClick={() => setShowTimeline((s) => !s)}>
            {showTimeline ? 'hide' : 'show'} timeline
          </button>
          {showTimeline && (
            <ol className="fc-timeline">
              {task.history.map((h, i) => {
                const prev = task.history[i - 1];
                return (
                  <li key={i}>
                    <span>{stateMeta(h.state).label}</span>
                    <span className="muted">{prev ? `+${formatDuration(h.at - prev.at)}` : new Date(h.at).toLocaleTimeString()}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </article>
  );
}
