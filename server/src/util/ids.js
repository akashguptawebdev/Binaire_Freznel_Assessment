import { randomUUID } from 'node:crypto';

/**
 * Small helpers for generating human-readable, sortable identifiers.
 * Sequence-based ids keep FIFO ordering obvious when debugging the queue.
 */

let taskSeq = 0;
let processSeq = 0;
let clientSeq = 0;

export function nextTaskId() {
  taskSeq += 1;
  return `task_${String(taskSeq).padStart(5, '0')}_${randomUUID().slice(0, 8)}`;
}

export function nextProcessId() {
  processSeq += 1;
  return `PID-${String(processSeq).padStart(4, '0')}`;
}

export function nextClientId() {
  clientSeq += 1;
  return `client_${String(clientSeq).padStart(3, '0')}_${randomUUID().slice(0, 6)}`;
}

export function currentTaskSeq() {
  return taskSeq;
}
