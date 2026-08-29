import type { Job } from 'bullmq';
import { ingestAndDetect, type SceneSource } from '@varuna/api/src/modules/scenes/ingest.js';

/**
 * `ingest` queue processor — 03_ARCHITECTURE §3.6.
 *
 * Progress is reported through BullMQ rather than written directly, because the worker is a
 * separate process from the API: `job.updateProgress` publishes over Redis, and the API's
 * QueueEvents bridge mirrors it into the `jobs` collection and out to the investigation's
 * Socket.IO room (06_BACKEND §6.7).
 *
 * Cancellation is cooperative: a cancel request sets `__cancelled` on the job data, and the
 * processor checks it between stages. A half-downloaded scene is never persisted.
 */
export interface IngestJobData {
  investigationId: string;
  productId: string;
  aoi: [number, number, number, number];
  collection?: string;
  /** Absent for a catalogue ingest; present when the analyst uploaded the scene. */
  source?: SceneSource;
  __cancelled?: boolean;
}

export async function processIngest(job: Job<IngestJobData>) {
  const cancelled = async () => {
    const fresh = await job.getState().catch(() => null);
    return fresh === 'failed' || Boolean((job.data as IngestJobData).__cancelled);
  };

  if (await cancelled()) {
    return { cancelled: true };
  }

  const result = await ingestAndDetect({
    investigationId: job.data.investigationId,
    productId: job.data.productId,
    aoi: job.data.aoi,
    collection: job.data.collection,
    source: job.data.source,
    onProgress: async (pct, stage, message) => {
      await job.updateProgress({ pct, stage, message });
    },
  });

  return result;
}
