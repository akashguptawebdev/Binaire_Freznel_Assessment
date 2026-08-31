import React, { useMemo } from 'react';
import Header from './components/Header.jsx';
import StatBar from './components/StatBar.jsx';
import WorkerRack from './components/WorkerRack.jsx';
import QueueBoard from './components/QueueBoard.jsx';
import DeadlockPanel from './components/DeadlockPanel.jsx';
import ClientMachines from './components/ClientMachines.jsx';
import useEngineStream from './hooks/useEngineStream.js';
import useClientMachines from './hooks/useClientMachines.js';

export default function App() {
  const { snapshot, status } = useEngineStream();
  const { machines, addMachine, removeMachine, renameMachine } = useClientMachines();

  // Flatten every task the server currently knows about into one lookup so a
  // client machine can resolve the live state of anything it submitted.
  const taskIndex = useMemo(() => {
    const map = new Map();
    const q = snapshot?.queue;
    q?.waiting?.forEach((t) => map.set(t.id, t));
    q?.active?.forEach((t) => map.set(t.id, t));
    snapshot?.recent?.forEach((r) => {
      if (!map.has(r.id)) {
        map.set(r.id, {
          ...r,
          progress: r.state === 'COMPLETED' ? 100 : 0,
          chunksDone: r.chunksTotal || 0,
          chunksTotal: r.chunksTotal || 0,
          history: [],
          startedAt: r.finishedAt && r.durationMs ? r.finishedAt - r.durationMs : null,
          finishedAt: r.finishedAt,
        });
      }
    });
    return map;
  }, [snapshot]);

  return (
    <div className="app-shell">
      <Header status={status} snapshot={snapshot} />

      <main className="app-main">
        <StatBar snapshot={snapshot} />

        <div className="split">
          <div className="split-left">
            <ClientMachines
              machines={machines}
              taskIndex={taskIndex}
              clients={snapshot?.clients}
              onAdd={addMachine}
              onRemove={removeMachine}
              onRename={renameMachine}
            />
          </div>
          <aside className="split-right">
            <WorkerRack workers={snapshot?.workers} />
            <DeadlockPanel snapshot={snapshot} />
            <ConnectedClients clients={snapshot?.clients} mine={machines.map((m) => m.clientId)} />
          </aside>
        </div>

        <QueueBoard snapshot={snapshot} />
      </main>

      <footer className="app-footer muted">
        Binaire · Freznel Assessment — multi-user queueing system. all-reduce = Σ of every numeric cell, computed by a
        pool of Node web workers.
      </footer>
    </div>
  );
}

function ConnectedClients({ clients = [], mine = [] }) {
  if (!clients.length) return null;
  return (
    <div className="conn-clients">
      <div className="cc-head">Connected clients <span className="count">{clients.length}</span></div>
      <ul>
        {clients.map((c) => (
          <li key={c.id} className={mine.includes(c.id) ? 'is-mine' : ''}>
            <span className="cc-label">{c.label}</span>
            <span className="muted">
              {c.openTasks} open · {c.stats.completed} done
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
