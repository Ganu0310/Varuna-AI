import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { JOB_QUEUES, type QueueName } from '@varuna/shared';
import { connectMongo, disconnectMongo } from '@varuna/api/src/db/connection.js';
import { bootstrapDatabase } from '@varuna/api/src/db/bootstrap.js';
import { getQueue } from '@varuna/api/src/queue/queues.js';
import { processIngest, type IngestJobData } from './processors/ingest.js';
import { processDrift, type DriftJobData } from './processors/drift.js';
import { processCorrelate, type CorrelateJobData } from './processors/correlate.js';
import { processAisImport, type AisImportJobData } from './processors/aisImport.js';
import { processReport, type ReportJobData } from './processors/report.js';
import { processSweep, type SweepTickJobData } from './processors/sweep.js';

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
  register<Awaited<ReturnType<typeof processDrift>>>('drift', (job) =>
    processDrift(job as unknown as Parameters<typeof processDrift>[0]),
  );
  register<Awaited<ReturnType<typeof processCorrelate>>>('scoring', (job) =>
    processCorrelate(job as unknown as Parameters<typeof processCorrelate>[0]),
  );
  register<Awaited<ReturnType<typeof processAisImport>>>('ais-import', (job) =>
    processAisImport(job as unknown as Parameters<typeof processAisImport>[0]),
  );
  register<Awaited<ReturnType<typeof processReport>>>('report', (job) =>
    processReport(job as unknown as Parameters<typeof processReport>[0]),
  );
  register<Awaited<ReturnType<typeof processSweep>>>('sweep', (job) =>
    processSweep(job as unknown as Parameters<typeof processSweep>[0]),
  );

  // The first BullMQ repeatable job in this codebase — see
  // `apps/api/src/modules/sweep/service.ts` for why Discover is a scheduled sweep and not a
  // live per-request search. `jobId` is the repeat key BullMQ dedupes on, so re-registering
  // this on every worker restart is safe: it either creates the schedule or confirms it
  // already matches, never duplicates it.
  await getQueue('sweep').add(
    'SWEEP_TICK',
    { triggeredBy: 'SCHEDULE' } satisfies SweepTickJobData,
    { repeat: { pattern: '0 6 * * *' }, jobId: 'sweep-scheduler' },
  );

  logger.info(
    {
      registered: ['ingest', 'drift', 'scoring', 'ais-import', 'report', 'sweep'],
      // `inference` stays unregistered ON PURPOSE. Detection currently runs inside the
      // ingest job; a separate inference queue belongs with the learned segmentation model,
      // and a stub processor here would mark work complete without doing it.
      pending: ['inference'],
      sweepSchedule: '0 6 * * * (UTC, daily)',
    },
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

export type {
  IngestJobData,
  DriftJobData,
  CorrelateJobData,
  AisImportJobData,
  ReportJobData,
  SweepTickJobData,
};
