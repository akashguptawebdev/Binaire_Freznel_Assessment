import { Router } from 'express';
import multer from 'multer';
import config from '../config.js';
import { AppError, ValidationError } from '../util/errors.js';

/**
 * All REST routes. The engine does the real work; these handlers only
 * validate shape, translate errors to HTTP, and (for `/tick`) let a
 * serverless caller advance the scheduler.
 */
export function createRouter({ engine, sseHub }) {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.upload.maxBytes, files: 1 },
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // In serverless mode every request nudges the scheduler forward, since
  // there is no background timer. Harmless (idempotent) in server mode.
  router.use((req, _res, next) => {
    if (config.isServerless) engine.tick();
    next();
  });

  router.get('/health', (_req, res) => {
    res.json({ ok: true, mode: config.isServerless ? 'serverless' : 'server', uptimeMs: process.uptime() * 1000 });
  });

  // --- clients ------------------------------------------------------
  router.post(
    '/clients',
    wrap((req, res) => {
      const label = String(req.body?.label || '').slice(0, 60) || undefined;
      const client = engine.registerClient(label);
      res.status(201).json({ client: client.toJSON() });
    }),
  );

  router.post(
    '/clients/:id/heartbeat',
    wrap((req, res) => {
      const client = engine.heartbeat(req.params.id);
      res.json({ ok: Boolean(client) });
    }),
  );

  router.delete(
    '/clients/:id',
    wrap((req, res) => {
      const reaped = engine.disconnectClient(req.params.id);
      res.json({ ok: true, reapedTasks: reaped });
    }),
  );

  // --- realtime ----------------------------------------------------
  router.get('/state', (_req, res) => res.json(engine.snapshot()));
  router.get('/stream', sseHub.handler);
  router.post('/tick', (_req, res) => {
    engine.tick();
    res.json(engine.snapshot());
  });

  // --- uploads / tasks -------------------------------------------
  router.post(
    '/uploads',
    upload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) throw new ValidationError('Missing "file" field (multipart/form-data).');
      const clientId = String(req.body?.clientId || '').trim();
      if (!clientId) throw new ValidationError('Missing "clientId".');
      const priority = String(req.body?.priority || 'low').toLowerCase();
      const input = { clientId, fileName: req.file.originalname, buffer: req.file.buffer, priority };

      // Serverless: settle within this request (no background scheduler, and
      // the next request may land on another instance). Server mode: enqueue
      // and let the tick loop + SSE take it from here.
      const task = config.isServerless ? await engine.submitAndSettle(input) : engine.submit(input);
      res.status(201).json({ task });
    }),
  );

  router.get(
    '/tasks/:id',
    wrap((req, res) => res.json({ task: engine.getTask(req.params.id) })),
  );

  router.post(
    '/tasks/:id/cancel',
    wrap((req, res) => {
      const clientId = String(req.body?.clientId || '').trim() || null;
      res.json({ task: engine.cancelTask(req.params.id, clientId) });
    }),
  );

  router.get(
    '/tasks/:id/result',
    wrap((req, res) => {
      const { summary } = engine.getResultFile(req.params.id);
      res.json({ result: summary });
    }),
  );

  // "Post processing completion, server sends the file back to the client."
  router.get(
    '/tasks/:id/result/file',
    wrap((req, res) => {
      const { fileName, csv } = engine.getResultFile(req.params.id);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.send(csv);
    }),
  );

  // multer + domain error translation
  router.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      return res.status(413).json({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, retryable: Boolean(err.retryable) } });
    }
    // eslint-disable-next-line no-console
    console.error('unhandled route error', err);
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });

  return router;
}

export default createRouter;
