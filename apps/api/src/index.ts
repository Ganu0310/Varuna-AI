import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env, assertProviderChains } from './env.js';
import { logger } from './lib/logger.js';
import { connectMongo, disconnectMongo } from './db/connection.js';
import { bootstrapDatabase } from './db/bootstrap.js';
import { assertNoEviction, closeRedis } from './queue/connection.js';
import { closeQueues } from './queue/queues.js';
import { initRealtime, closeRealtime } from './realtime/io.js';
import { startQueueBridge } from './realtime/bridge.js';

async function main(): Promise<void> {
  assertProviderChains(logger);

  await connectMongo();
  await bootstrapDatabase();
  await assertNoEviction();

  const app = createApp();
  const server = createServer(app);

  initRealtime(server);
  startQueueBridge();

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'varuna-api listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    force.unref();

    server.close(async (err) => {
      if (err) logger.error({ err }, 'error closing http server');
      try {
        await closeRealtime();
        await closeQueues();
        await closeRedis();
        await disconnectMongo();
      } catch (e) {
        logger.error({ err: e }, 'error during resource shutdown');
      }
      process.exit(err ? 1 : 0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal: varuna-api failed to start');
  process.exit(1);
});
