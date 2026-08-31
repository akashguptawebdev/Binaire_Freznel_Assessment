import React from 'react';
import ClientMachineCard from './ClientMachineCard.jsx';

export default function ClientMachines({ machines, taskIndex, clients, onAdd, onRemove, onRename }) {
  return (
    <section className="client-machines">
      <div className="cm-head">
        <h2>Client machines</h2>
        <button className="btn-solid" onClick={() => onAdd()}>
          + add client machine
        </button>
      </div>
      <p className="cm-hint muted">
        Each card is a separate registered client. Send any number of CSV files, at any time, at high or low priority.
        Open this page in another tab or on another computer to add more real clients.
      </p>
      <div className="cm-grid">
        {machines.map((m) => (
          <ClientMachineCard
            key={m.key}
            machine={m}
            taskIndex={taskIndex}
            clientStat={clients?.find((c) => c.id === m.clientId)}
            onRemove={onRemove}
            onRename={onRename}
          />
        ))}
        {machines.length === 0 && <p className="muted">registering client machines…</p>}
      </div>
    </section>
  );
}
