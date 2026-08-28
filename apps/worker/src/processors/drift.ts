import type { Job } from 'bullmq';
import { runOrigin } from '@varuna/api/src/modules/origin/service.js';

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
}

export async function processDrift(job: Job<DriftJobData>) {
  return runOrigin({
    investigationId: job.data.investigationId,
    detectionId: job.data.detectionId,
    horizonHours: job.data.horizonHours,
    particleCount: job.data.particleCount,
    onProgress: async (pct, stage, message) => {
      await job.updateProgress({ pct, stage, message });
    },
  });
}
