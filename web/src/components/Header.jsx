import React from 'react';

const STATUS_COPY = {
  connecting: 'connecting',
  live: 'live · SSE',
  polling: 'degraded · polling',
  offline: 'offline',
};

export default function Header({ status, snapshot }) {
  const mode = snapshot?.mode;
  const strategy = snapshot?.reduceStrategy;
  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand-mark" aria-hidden>
          ⇄
        </div>
        <div>
          <h1>Freznel Queue</h1>
          <p className="brand-sub">Multi-user CSV all-reduce · priority scheduling · deadlock-safe</p>
        </div>
      </div>
      <div className="header-badges">
        {mode && (
          <span className={`pill pill-mode pill-${mode}`}>
            {mode === 'serverless' ? 'serverless' : 'server'}
            {strategy ? ` · ${strategy}` : ''}
          </span>
        )}
        <span className={`pill pill-status pill-${status}`}>
          <span className="dot" />
          {STATUS_COPY[status] || status}
        </span>
      </div>
    </header>
  );
}
