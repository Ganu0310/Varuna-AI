import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env, assertProviderChains } from './env.js';
import { logger } from './lib/logger.js';

const app = createApp();
const server = createServer(app);

assertProviderChains(logger);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'varuna-api listening');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
    // TODO(phase-2): close Mongo, Redis, BullMQ, Socket.IO cleanly here.
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
