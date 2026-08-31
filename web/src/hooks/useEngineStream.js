import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api/client.js';

/**
 * Live connection to the queue engine.
 *
 * Primary transport: SSE (`EventSource`) on `/api/stream`.
 * Fallbacks, applied automatically:
 *   - if SSE errors, retry with capped backoff
 *   - while disconnected, poll `/api/state`
 *   - if the engine reports `mode: "serverless"`, also drive `/api/tick`
 *     on an interval so the scheduler keeps advancing without a background
 *     timer on the host.
 */
export function useEngineStream() {
  const [snapshot, setSnapshot] = useState(null);
  const [status, setStatus] = useState('connecting'); // connecting | live | polling | offline
  const esRef = useRef(null);
  const pollRef = useRef(null);
  const tickRef = useRef(null);
  const backoffRef = useRef(1000);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    const run = async () => {
      try {
        const data = await api.state();
        setSnapshot(data);
        setStatus((s) => (s === 'live' ? s : 'polling'));
      } catch {
        setStatus('offline');
      }
    };
    run();
    pollRef.current = setInterval(run, 1500);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const connect = useCallback(() => {
    if (typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    const es = new EventSource(api.streamUrl());
    esRef.current = es;

    es.addEventListener('snapshot', (evt) => {
      try {
        const data = JSON.parse(evt.data);
        setSnapshot(data);
        setStatus('live');
        backoffRef.current = 1000;
        stopPolling();
      } catch {
        /* ignore malformed frame */
      }
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setStatus('polling');
      startPolling();
      const wait = Math.min(backoffRef.current, 15_000);
      backoffRef.current = wait * 2;
      setTimeout(connect, wait);
    };
  }, [startPolling, stopPolling]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      stopPolling();
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [connect, stopPolling]);

  // Serverless: keep ticking the scheduler over HTTP.
  useEffect(() => {
    const serverless = snapshot?.mode === 'serverless';
    if (serverless && !tickRef.current) {
      tickRef.current = setInterval(() => {
        api.tick().then(setSnapshot).catch(() => {});
      }, 900);
    }
    if (!serverless && tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, [snapshot?.mode]);

  return { snapshot, status };
}

export default useEngineStream;
