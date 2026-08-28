import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { JOB_QUEUES, type QueueName } from '@varuna/shared';
import { connectMongo, disconnectMongo } from '@varuna/api/src/db/connection.js';
import { bootstrapDatabase } from '@varuna/api/src/db/bootstrap.js';
import { processIngest, type IngestJobData } from './processors/ingest.js';

/**
 * BullMQ consumers. The worker runs from the same image as the API with a different
 * entrypoint (03_ARCHITECTURE §3.3), so it shares the models, provenance service and geo
 * helpers rather than duplicating them — there is exactly one definition of how a
 * `SatelliteScene` is written.
 *
 * Queues whose processors have not been built yet are deliberately NOT registered: a
 * registered queue with a stub processor would mark work complete without doing it, which
 * is worse than leaving the job queued.
 */
const logger = pino({ name: 'varuna-worker' });

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const workers: Worker[] = [];

function register<T>(name: QueueName, processor: (job: never) => Promise<T>) {
  const cfg = JOB_QUEUES[name];
  const w = new Worker(name, processor as never, { connection, concurrency: cfg.concurrency });
  w.on('completed', (job) => logger.info({ queue: name, jobId: job.id }, 'job completed'));
  w.on('failed', (job, err) =>
    // The verbatim reason travels to the UI via the QueueEvents bridge — an analyst must
    // see the real cause, not a sanitised one (08_APP_FLOW §8.7).
    logger.error({ queue: name, jobId: job?.id, err: err.message }, 'job failed'),
  );
  workers.push(w);
  return w;
}

async function main() {
  await connectMongo();
  await bootstrapDatabase();

  register<Awaited<ReturnType<typeof processIngest>>>('ingest', (job) =>
    processIngest(job as unknown as Parameters<typeof processIngest>[0]),
  );

  logger.info(
    { registered: ['ingest'], pending: ['inference', 'drift', 'ais-import', 'scoring', 'report'] },
    'varuna-worker ready',
  );
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await connection.quit();
  await disconnectMongo();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});

export type { IngestJobData };
