import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from './config.js';
import { QueueEngine } from './engine/QueueEngine.js';
import { SseHub } from './http/SseHub.js';
import { createRouter } from './http/routes.js';
import { rootLogger } from './util/Logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, '../../web/dist');

/**
 * Build the Express app around a single QueueEngine. Used by both
 * `server/src/index.js` (long-lived) and `api/index.js` (Vercel function).
 *
 * @param {{ engine?: QueueEngine }} [opts]
 */
export function createApp(opts = {}) {
  const engine = opts.engine || new QueueEngine(config);
  const sseHub = new SseHub(engine, { minIntervalMs: 120 });

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.http.corsOrigin }));
  app.use(express.json({ limit: config.http.bodyLimit }));

  app.use('/api', createRouter({ engine, sseHub }));

  // Single-service deploy (Render/Docker/local): serve the built frontend.
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      return res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
    rootLogger.info(`serving frontend from ${WEB_DIST}`);
  }

  app.locals.engine = engine;
  app.locals.sseHub = sseHub;
  return { app, engine, sseHub };
}

export default createApp;
