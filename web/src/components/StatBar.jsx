import React from 'react';
import { formatNumber } from '../lib/format.js';

function Stat({ label, value, sub, tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export default function StatBar({ snapshot }) {
  const q = snapshot?.queue || {};
  const w = snapshot?.workers || {};
  const t = snapshot?.totals || {};
  const g = snapshot?.guard || {};

  return (
    <section className="stat-bar" aria-label="system metrics">
      <Stat
        label="Queue depth"
        value={q.queueDepth ?? 0}
        sub={`cap ${q.queueCapacity ?? '—'}`}
        tone={q.queueDepth > (q.queueCapacity || 1) * 0.8 ? 'warn' : undefined}
      />
      <Stat label="Active processes" value={q.activeProcesses ?? 0} sub={`max ${q.maxConcurrentProcesses ?? '—'}`} />
      <Stat
        label="Workers busy"
        value={`${w.busy ?? 0}/${w.size ?? 0}`}
        sub={w.waiters ? `${w.waiters} waiting` : 'pool free'}
        tone={w.busy && w.busy === w.size ? 'warn' : undefined}
      />
      <Stat label="Completed" value={formatNumber(t.completed ?? 0)} sub={`${formatNumber(t.valuesReduced ?? 0)} values`} tone="ok" />
      <Stat label="Rejected (queue full)" value={t.rejected ?? 0} tone={t.rejected ? 'warn' : undefined} />
      <Stat label="Aging promotions" value={g.agingPromotions ?? 0} sub={`${g.watchdogKicks ?? 0} watchdog`} tone="accent" />
    </section>
  );
}
