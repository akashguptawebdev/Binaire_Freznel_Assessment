import { nextClientId } from '../util/ids.js';

/**
 * One client machine. In the browser UI each "client machine" card is a
 * distinct Client with its own id; opening the app in another tab / on
 * another computer creates another one. The server does not care how many
 * there are (the brief's "any count of users N").
 */
export class Client {
  constructor({ label } = {}) {
    this.id = nextClientId();
    this.label = label || this.id;
    this.connectedAt = Date.now();
    this.lastSeen = Date.now();
    this.taskIds = new Set();
    this.stats = { submitted: 0, completed: 0, failed: 0, cancelled: 0, rejected: 0 };
  }

  heartbeat() {
    this.lastSeen = Date.now();
  }

  get idleMs() {
    return Date.now() - this.lastSeen;
  }

  toJSON() {
    return {
      id: this.id,
      label: this.label,
      connectedAt: this.connectedAt,
      lastSeen: this.lastSeen,
      idleMs: this.idleMs,
      openTasks: this.taskIds.size,
      stats: this.stats,
    };
  }
}

export default Client;
