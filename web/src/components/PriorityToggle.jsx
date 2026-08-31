import React from 'react';

export default function PriorityToggle({ value, onChange }) {
  return (
    <div className="prio-toggle" role="radiogroup" aria-label="priority">
      {['high', 'low'].map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          className={`prio-opt prio-opt-${p} ${value === p ? 'is-on' : ''}`}
          onClick={() => onChange(p)}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
