import type { Job } from 'bullmq';
import { runOrigin } from '@varuna/api/src/modules/origin/service.js';
import { enqueue } from '@varuna/api/src/queue/producer.js';
import { logger } from '@varuna/api/src/lib/logger.js';

/**
 * `drift` queue processor — backward Lagrangian back-tracking.
 *
 * Runs on the worker rather than in the request because a 5,000-particle ensemble over a
 * 24 h horizon takes tens of seconds, and because the forcing fetch reaches out to an
 * external OPeNDAP endpoint that can be slow or absent.
 */
export interface DriftJobData {
  investigationId: string;
  detectionId: string;
  horizonHours?: number;
  particleCount?: number;
  /**
   * Set by the speculative precompute path in `scenes/ingest.ts`. Correlation cannot be
   * enqueued alongside the drift job because it needs an `originEstimateId` that does not
   * exist until this job has produced one — so the chain is closed here instead.
   */
  chainScoring?: boolean;
}

export async function processDrift(job: Job<DriftJobData>) {
  const result = await runOrigin({
    investigationId: job.data.investigationId,
    detectionId: job.data.detectionId,
    horizonHours: job.data.horizonHours,
    particleCount: job.data.particleCount,
    onProgress: async (pct, stage, message) => {
      await job.updateProgress({ pct, stage, message });
    },
  });

  if (job.data.chainScoring && result.originEstimateId) {
    /*
     * Chained even when the origin came back DEGRADED.
     *
     * A degraded back-track still bounds the release zone, and the scorer already knows how
     * to say so — `originDegraded` suppresses the origin-density feature rather than letting
     * it contribute a fabricated value. Skipping correlation here would leave the analyst
     * with a blank candidate table and no statement of why, which is strictly less honest
     * than a scored table that reports the degradation.
     *
     * Same jobKey the analyst-triggered route uses, so a manual correlate on this detection
     * deduplicates against this run instead of repeating it.
     */
    try {
      await enqueue({
        queue: 'scoring',
        kind: 'SCORING',
        jobKey: `scoring:${job.data.investigationId}:${job.data.detectionId}`,
        payload: {
          investigationId: job.data.investigationId,
          detectionId: job.data.detectionId,
          originEstimateId: result.originEstimateId,
        },
        investigationId: job.data.investigationId,
      });
    } catch (err) {
      // The origin estimate is already written and is the valuable half. Correlation can be
      // re-run from the workspace, so a failed chain must not fail a completed back-track.
      logger.error(
        { err, detectionId: job.data.detectionId },
        'chained correlation enqueue failed — the origin estimate stands and correlation can be run manually',
      );
    }
  }

  return result;
}
