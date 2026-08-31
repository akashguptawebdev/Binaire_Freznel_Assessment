import config from './config.js';
import { createApp } from './app.js';
import { rootLogger } from './util/Logger.js';

/**
 * Long-lived entrypoint. `npm start` / Docker / Render run this. The engine
 * keeps a background scheduler tick + deadlock-guard sweep running, and SSE
 * pushes live snapshots to every connected client.
 */
const { app, engine, sseHub } = createApp();
engine.start();

const server = app.listen(config.http.port, config.http.host, () => {
  rootLogger.info(`queue server listening on http://${config.http.host}:${config.http.port}`);
  rootLogger.info(`  mode=${config.isServerless ? 'serverless' : 'server'} reduce=${config.workers.strategy} pool=${config.workers.poolSize}`);
});

// keep long-poll / SSE connections from being cut at the default 2 min
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

async function shutdown(signal) {
  rootLogger.warn(`${signal} received — shutting down`);
  sseHub.close();
  server.close();
  await engine.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => rootLogger.error('unhandledRejection', err));
