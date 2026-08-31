import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

const STORAGE_KEY = 'freznel.machines.v1';

function loadStored() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
    return null;
  } catch {
    return null;
  }
}

const DEFAULT_LABELS = ['Workstation A', 'Workstation B'];

/**
 * Manages the local set of "client machines". Each one is a real, separately
 * registered client on the server (its own client id + heartbeat), so the
 * server genuinely sees N independent clients — exactly as it would if you
 * opened the app on N different computers.
 *
 * The label list is persisted to localStorage; server ids are re-minted on
 * every load (they are ephemeral and the server GCs stale ones anyway).
 */
export function useClientMachines() {
  const [machines, setMachines] = useState([]); // { key, label, clientId }
  const bootRef = useRef(false);

  const persist = useCallback((list) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.map((m) => ({ key: m.key, label: m.label }))));
  }, []);

  const register = useCallback(async (key, label) => {
    const client = await api.createClient(label);
    return { key, label: client.label, clientId: client.id };
  }, []);

  const addMachine = useCallback(
    async (label) => {
      const key = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const finalLabel = label?.trim() || `Machine ${machines.length + 1}`;
      const machine = await register(key, finalLabel);
      setMachines((prev) => {
        const next = [...prev, machine];
        persist(next);
        return next;
      });
      return machine;
    },
    [machines.length, persist, register],
  );

  const removeMachine = useCallback(
    (key) => {
      setMachines((prev) => {
        const target = prev.find((m) => m.key === key);
        if (target?.clientId) api.disconnect(target.clientId);
        const next = prev.filter((m) => m.key !== key);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const renameMachine = useCallback(
    (key, label) => {
      setMachines((prev) => {
        const next = prev.map((m) => (m.key === key ? { ...m, label } : m));
        persist(next);
        return next;
      });
    },
    [persist],
  );

  // Bootstrap once.
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const stored = loadStored() || DEFAULT_LABELS.map((label, i) => ({ key: `seed_${i}`, label }));
    Promise.all(stored.map((s) => register(s.key, s.label)))
      .then((list) => {
        setMachines(list);
        persist(list);
      })
      .catch((err) => console.error('client bootstrap failed', err));
  }, [persist, register]);

  // Heartbeats so the deadlock guard does not reap us.
  useEffect(() => {
    if (!machines.length) return undefined;
    const iv = setInterval(() => {
      machines.forEach((m) => m.clientId && api.heartbeat(m.clientId));
    }, 12_000);
    return () => clearInterval(iv);
  }, [machines]);

  return { machines, addMachine, removeMachine, renameMachine };
}

export default useClientMachines;
