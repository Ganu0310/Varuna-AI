import { Types } from 'mongoose';
import type { JobKind, QueueName } from '@varuna/shared';
import { logger } from '../lib/logger.js';
import { JobModel } from '../modules/jobs/model.js';
import { getQueue } from './queues.js';

export interface EnqueueInput<T = Record<string, unknown>> {
  queue: QueueName;
  kind: JobKind;
  /**
   * Deterministic idempotency key, e.g. `ingest:${productId}` — used as the BullMQ job id,
   * so a duplicate enqueue is a no-op rather than a second 1 GB download
   * (03_ARCHITECTURE §3.6, 01_PRD NFR-10).
   */
  jobKey: string;
  payload: T;
  investigationId?: string;
  userId?: string;
}

export interface EnqueueResult {
  jobId: string;
  deduplicated: boolean;
}

/**
 * Enqueue a job and mirror it into the `jobs` collection so the UI can query history after
 * the Redis job is evicted (03_ARCHITECTURE §3.6).
 */
export async function enqueue<T extends Record<string, unknown>>(
  input: EnqueueInput<T>,
): Promise<EnqueueResult> {
  const queue = getQueue(input.queue);

  const existing = await queue.getJob(input.jobKey);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'failed' && state !== 'completed') {
      logger.info({ jobKey: input.jobKey, state }, 'duplicate enqueue ignored (idempotent)');
      return { jobId: input.jobKey, deduplicated: true };
    }
    // A previously finished job with this key is removed so the work can be re-run.
    await existing.remove();
  }

  await queue.add(input.kind, input.payload, { jobId: input.jobKey });

  await JobModel.findOneAndUpdate(
    { jobKey: input.jobKey },
    {
      $set: {
        jobKey: input.jobKey,
        kind: input.kind,
        queue: input.queue,
        status: 'QUEUED',
        attempts: 0,
        failureReason: undefined,
        completedAt: undefined,
        ...(input.investigationId
          ? { investigationId: new Types.ObjectId(input.investigationId) }
          : {}),
        ...(input.userId ? { createdBy: new Types.ObjectId(input.userId) } : {}),
      },
    },
    { upsert: true, new: true },
  );

  return { jobId: input.jobKey, deduplicated: false };
}

/** Cancel a queued or running job. A running job is asked to stop; BullMQ removes queued ones. */
export async function cancelJob(jobKey: string): Promise<boolean> {
  const record = await JobModel.findOne({ jobKey });
  if (!record) return false;

  const queue = getQueue(record.queue as QueueName);
  const job = await queue.getJob(jobKey);
  if (job) {
    const state = await job.getState();
    if (state === 'active') {
      // Cooperative cancellation: the processor checks this flag between stages.
      await job.updateData({ ...(job.data as object), __cancelled: true });
    } else {
      await job.remove();
    }
  }

  record.status = 'CANCELLED';
  record.completedAt = new Date();
  await record.save();
  return true;
}

export async function retryJob(jobKey: string): Promise<boolean> {
  const record = await JobModel.findOne({ jobKey });
  if (!record) return false;

  const queue = getQueue(record.queue as QueueName);
  const job = await queue.getJob(jobKey);
  if (job) await job.remove();

  await queue.add(record.kind, (record.result ?? {}) as Record<string, unknown>, { jobId: jobKey });
  record.status = 'QUEUED';
  record.attempts = 0;
  record.failureReason = undefined;
  record.completedAt = undefined;
  await record.save();
  return true;
}
