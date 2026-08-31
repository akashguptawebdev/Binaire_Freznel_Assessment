/**
 * The lifecycle of one CSV file inside the system. The string values are the
 * exact labels the UI renders (see the assessment brief):
 *
 *   1. File uploading           -> UPLOADING   (reported by the client)
 *   2. File uploaded            -> UPLOADED
 *   3. File added to queue      -> QUEUED
 *   4. Waiting for processing   -> WAITING     (process id assigned)
 *   5. Processing…              -> PROCESSING  (completion %)
 *   6. Completed                -> COMPLETED
 *
 * Plus two terminal off-ramps: FAILED and CANCELLED.
 */
export const TaskState = Object.freeze({
  UPLOADING: 'UPLOADING',
  UPLOADED: 'UPLOADED',
  QUEUED: 'QUEUED',
  WAITING: 'WAITING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

export const TERMINAL_STATES = new Set([
  TaskState.COMPLETED,
  TaskState.FAILED,
  TaskState.CANCELLED,
]);

/**
 * Allowed transitions. Any transition not listed here is a bug and throws —
 * this is the main guard against the scheduler and the guard thread racing
 * a task into an impossible state.
 */
export const TRANSITIONS = Object.freeze({
  [TaskState.UPLOADING]: [TaskState.UPLOADED, TaskState.FAILED, TaskState.CANCELLED],
  [TaskState.UPLOADED]: [TaskState.QUEUED, TaskState.FAILED, TaskState.CANCELLED],
  [TaskState.QUEUED]: [TaskState.WAITING, TaskState.CANCELLED, TaskState.FAILED],
  [TaskState.WAITING]: [TaskState.PROCESSING, TaskState.CANCELLED, TaskState.FAILED],
  [TaskState.PROCESSING]: [TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED],
  [TaskState.COMPLETED]: [],
  [TaskState.FAILED]: [],
  [TaskState.CANCELLED]: [],
});

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
