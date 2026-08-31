import React, { useCallback, useEffect, useState } from 'react';
import UploadZone from './UploadZone.jsx';
import PriorityToggle from './PriorityToggle.jsx';
import FileStatusCard from './FileStatusCard.jsx';
import { api } from '../api/client.js';

let localSeq = 0;

/**
 * One client machine: its own server-side client id, its own uploads, its own
 * view of what it has submitted. Multiple of these on screen == multiple
 * independent clients hitting the server.
 */
export default function ClientMachineCard({ machine, taskIndex, clientStat, onRemove, onRename }) {
  const [priority, setPriority] = useState('low');
  const [entries, setEntries] = useState([]); // newest first
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(machine.label);

  // Merge live server state into local entries as snapshots arrive.
  useEffect(() => {
    setEntries((prev) =>
      prev.map((e) => (e.taskId && taskIndex.has(e.taskId) ? { ...e, task: taskIndex.get(e.taskId) } : e)),
    );
  }, [taskIndex]);

  const patchEntry = useCallback((localId, patch) => {
    setEntries((prev) => prev.map((e) => (e.localId === localId ? { ...e, ...patch } : e)));
  }, []);

  const submitFile = useCallback(
    async (file, chosenPriority) => {
      localSeq += 1;
      const localId = `l${localSeq}`;
      const entry = {
        localId,
        fileName: file.name,
        sizeBytes: file.size,
        priority: chosenPriority,
        uploadPct: 0,
        task: null,
        taskId: null,
        error: null,
      };
      setEntries((prev) => [entry, ...prev]);

      try {
        const task = await api.upload({
          clientId: machine.clientId,
          priority: chosenPriority,
          file,
          onUploadProgress: (evt) => {
            const pct = evt.total ? Math.round((evt.loaded / evt.total) * 100) : 100;
            patchEntry(localId, { uploadPct: Math.min(99, pct) });
          },
        });
        patchEntry(localId, { uploadPct: 100, task, taskId: task.id });
      } catch (err) {
        const data = err?.response?.data?.error;
        patchEntry(localId, {
          uploadPct: 100,
          error: data?.message || err.message || 'upload failed',
          retryable: data?.retryable || data?.code === 'QUEUE_FULL',
          file: data?.retryable ? file : undefined,
        });
      }
    },
    [machine.clientId, patchEntry],
  );

  const onFiles = useCallback(
    (files) => files.forEach((f) => submitFile(f, priority)),
    [priority, submitFile],
  );

  const retry = useCallback(
    (entry) => {
      setEntries((prev) => prev.filter((e) => e.localId !== entry.localId));
      if (entry.file) submitFile(entry.file, entry.priority);
    },
    [submitFile],
  );

  const clearFinished = () =>
    setEntries((prev) => prev.filter((e) => !e.task || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(e.task.state)));

  const s = clientStat?.stats;

  return (
    <div className="machine-card">
      <div className="mc-head">
        <div className="mc-id">
          <span className="mc-dot" />
          {editing ? (
            <input
              className="mc-rename"
              value={labelDraft}
              autoFocus
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={() => {
                setEditing(false);
                onRename(machine.key, labelDraft.trim() || machine.label);
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          ) : (
            <button className="mc-label" onClick={() => setEditing(true)} title="rename">
              {machine.label}
            </button>
          )}
          <code className="mc-cid">{machine.clientId || '…'}</code>
        </div>
        <button className="btn-ghost" onClick={() => onRemove(machine.key)} title="disconnect this machine">
          ✕
        </button>
      </div>

      <div className="mc-controls">
        <PriorityToggle value={priority} onChange={setPriority} />
        {s && (
          <span className="mc-stats muted">
            {s.submitted} sent · {s.completed} done{s.rejected ? ` · ${s.rejected} rejected` : ''}
          </span>
        )}
      </div>

      <UploadZone onFiles={onFiles} />

      <div className="mc-files">
        {entries.length === 0 && <p className="mc-empty muted">no files submitted from this machine yet</p>}
        {entries.map((e) =>
          e.error ? (
            <div key={e.localId} className="file-card tone-failed">
              <div className="fc-top">
                <span className="fc-file">{e.fileName}</span>
              </div>
              <p className="fc-line fc-err">{e.error}</p>
              {e.retryable && (
                <button className="btn-solid" onClick={() => retry(e)}>
                  retry
                </button>
              )}
            </div>
          ) : (
            <FileStatusCard key={e.localId} entry={e} clientId={machine.clientId} />
          ),
        )}
      </div>

      {entries.some((e) => e.task && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(e.task.state)) && (
        <button className="link-btn mc-clear" onClick={clearFinished}>
          clear finished
        </button>
      )}
    </div>
  );
}
