import type { QueueName } from '@varuna/shared';
import { logger } from '../lib/logger.js';
import { JobModel } from '../modules/jobs/model.js';
import { ALL_QUEUES, getQueueEvents } from '../queue/queues.js';
import { emitJobProgress, emitJobTerminal } from './io.js';

/**
 * Worker → API bridge (06_BACKEND §6.7).
 *
 * Workers are separate processes, so they cannot emit on this process's Socket.IO server.
 * BullMQ's QueueEvents (Redis pub/sub) carries their progress here, where it is mirrored
 * into the `jobs` collection and fanned out to the relevant rooms.
 */
async function investigationIdFor(jobId: string): Promise<string | undefined> {
  const rec = await JobModel.findOne({ jobKey: jobId }).select({ investigationId: 1 }).lean();
  return rec?.investigationId ? String(rec.investigationId) : undefined;
}

export function startQueueBridge(queues: QueueName[] = ALL_QUEUES): void {
  for (const name of queues) {
    const events = getQueueEvents(name);

    events.on('progress', async ({ jobId, data }) => {
      const p = (data ?? {}) as { pct?: number; stage?: string; message?: string };
      const investigationId = await investigationIdFor(jobId);
      await JobModel.updateOne(
        { jobKey: jobId },
        {
          $set: {
            status: 'RUNNING',
            progress: { pct: p.pct ?? 0, stage: p.stage ?? 'RUNNING', message: p.message },
          },
        },
      );
      emitJobProgress({
        jobId,
        investigationId,
        pct: p.pct ?? 0,
        stage: p.stage ?? 'RUNNING',
        message: p.message,
      });
    });

    events.on('active', async ({ jobId }) => {
      await JobModel.updateOne({ jobKey: jobId }, { $set: { status: 'RUNNING' } });
    });

    events.on('completed', async ({ jobId, returnvalue }) => {
      const investigationId = await investigationIdFor(jobId);
      const rec = await JobModel.findOneAndUpdate(
        { jobKey: jobId },
        {
          $set: {
            status: 'COMPLETED',
            completedAt: new Date(),
            progress: { pct: 100, stage: 'COMPLETE' },
            result: returnvalue as unknown,
          },
        },
        { new: true },
      );
      emitJobTerminal('job:completed', {
        jobId,
        kind: rec?.kind ?? 'UNKNOWN',
        investigationId,
      });
    });

    events.on('failed', async ({ jobId, failedReason }) => {
      const investigationId = await investigationIdFor(jobId);
      const rec = await JobModel.findOneAndUpdate(
        { jobKey: jobId },
        {
          $set: { status: 'FAILED', completedAt: new Date(), failureReason: failedReason },
          $inc: { attempts: 1 },
        },
        { new: true },
      );
      // The verbatim provider/worker reason reaches the UI — the analyst must see the real
      // cause, not a sanitised one (04_UIUX §4.8.2 JobConsole, 08_APP_FLOW §8.7).
      emitJobTerminal('job:failed', {
        jobId,
        kind: rec?.kind ?? 'UNKNOWN',
        investigationId,
        reason: failedReason,
      });
    });

    events.on('error', (err) => {
      logger.error({ err, queue: name }, 'queue events error');
    });
  }

  logger.info({ queues }, 'queue → socket bridge started');
}
