/**
 * Tiny leveled logger. No dependency, structured-ish output so the queue
 * lifecycle is easy to follow in a terminal or in Vercel's function logs.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export class Logger {
  constructor(scope = 'app', level = process.env.LOG_LEVEL || 'info') {
    this.scope = scope;
    this.threshold = LEVELS[level] ?? LEVELS.info;
  }

  child(scope) {
    const l = new Logger(`${this.scope}:${scope}`);
    l.threshold = this.threshold;
    return l;
  }

  #emit(level, msg, extra) {
    if (LEVELS[level] < this.threshold) return;
    const ts = new Date().toISOString();
    const head = `${ts} ${level.toUpperCase().padEnd(5)} [${this.scope}]`;
    if (extra !== undefined) {
      console[level === 'debug' ? 'log' : level](head, msg, extra);
    } else {
      console[level === 'debug' ? 'log' : level](head, msg);
    }
  }

  debug(msg, extra) { this.#emit('debug', msg, extra); }
  info(msg, extra) { this.#emit('info', msg, extra); }
  warn(msg, extra) { this.#emit('warn', msg, extra); }
  error(msg, extra) { this.#emit('error', msg, extra); }
}

export const rootLogger = new Logger('queue');
