import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import { JOB_QUEUES, type QueueName } from '@varuna/shared';
import { redisConnection } from './connection.js';

/**
 * Queue definitions — 03_ARCHITECTURE §3.6.
 *
 * Per-queue retry / backoff / concurrency come from the shared constants table so the API,
 * the worker and the docs cannot drift. Concurrency is applied by the worker; the producer
 * side only needs retry + backoff.
 */
const queues = new Map<QueueName, Queue>();
const queueEvents = new Map<QueueName, QueueEvents>();

export function defaultJobOptions(name: QueueName): JobsOptions {
  const cfg = JOB_QUEUES[name];
  return {
    attempts: cfg.retries + 1, // BullMQ counts the first run as an attempt
    backoff: { type: 'exponential', delay: cfg.backoffBaseMs },
    removeOnComplete: { age: 60 * 60 * 24 }, // the `jobs` collection is the durable record
    removeOnFail: false, // keep failures for the dead-letter view
  };
}

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: redisConnection(),
      defaultJobOptions: defaultJobOptions(name),
    });
    queues.set(name, q);
  }
  return q;
}

export function getQueueEvents(name: QueueName): QueueEvents {
  let qe = queueEvents.get(name);
  if (!qe) {
    qe = new QueueEvents(name, { connection: redisConnection() });
    queueEvents.set(name, qe);
  }
  return qe;
}

export const ALL_QUEUES = Object.keys(JOB_QUEUES) as QueueName[];

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  await Promise.all([...queueEvents.values()].map((qe) => qe.close()));
  queues.clear();
  queueEvents.clear();
}
