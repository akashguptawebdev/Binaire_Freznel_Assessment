/**
 * Vercel serverless entrypoint.
 *
 * The whole queueing engine is instantiated once per warm lambda instance and
 * held at module scope, so a burst of requests hitting the same instance
 * shares one queue, one scheduler and one result store. Between invocations
 * the instance is frozen; there is no reliable background timer, so:
 *
 *   - `config.isServerless` is true (Vercel sets `process.env.VERCEL`)
 *   - the reduce strategy falls back to the inline chunked reducer
 *   - every incoming request calls `engine.tick()` (see http/routes.js), and
 *     the frontend also polls `POST /api/tick` to keep the wheel turning
 *
 * See docs/DEPLOYMENT.md for the trade-offs vs. the long-lived server.
 */
import { createApp } from '../server/src/app.js';

const { app, engine } = createApp();
engine.start(); // unref'd timers; a best-effort bonus when the instance stays warm

export default app;
