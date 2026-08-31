/**
 * Domain error types. Each carries an HTTP status so the transport layer
 * can stay dumb and just forward `err.status` / `err.code`.
 */
export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL' } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, { status: 400, code: 'VALIDATION' });
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super(message, { status: 404, code: 'NOT_FOUND' });
  }
}

/**
 * Thrown when the bounded queue is full. The client is expected to back off
 * and retry — this is a deliberate deadlock-avoidance choice (we reject
 * instead of blocking the producer). See docs/DEADLOCKS.md.
 */
export class QueueFullError extends AppError {
  constructor(capacity) {
    super(`Queue is at capacity (${capacity}). Retry shortly.`, {
      status: 503,
      code: 'QUEUE_FULL',
    });
    this.retryable = true;
  }
}

export class ForbiddenError extends AppError {
  constructor(message) {
    super(message, { status: 403, code: 'FORBIDDEN' });
  }
}
