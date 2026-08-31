// The 6 lifecycle labels from the assessment brief, plus terminal off-ramps.
export const STATE_META = {
  UPLOADING: { label: 'File uploading', step: 1, tone: 'uploading' },
  UPLOADED: { label: 'File uploaded', step: 2, tone: 'uploaded' },
  QUEUED: { label: 'File added to queue', step: 3, tone: 'queued' },
  WAITING: { label: 'Waiting for processing', step: 4, tone: 'waiting' },
  PROCESSING: { label: 'Processing…', step: 5, tone: 'processing' },
  COMPLETED: { label: 'Completed', step: 6, tone: 'completed' },
  FAILED: { label: 'Failed', step: 6, tone: 'failed' },
  CANCELLED: { label: 'Cancelled', step: 6, tone: 'cancelled' },
};

export const STEP_SEQUENCE = ['UPLOADING', 'UPLOADED', 'QUEUED', 'WAITING', 'PROCESSING', 'COMPLETED'];

export function stateMeta(state) {
  return STATE_META[state] || { label: state, step: 0, tone: 'unknown' };
}

export function isTerminal(state) {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED';
}
