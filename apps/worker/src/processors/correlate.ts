import type { Job } from 'bullmq';
import { correlate } from '@varuna/api/src/modules/candidates/service.js';
import { getOrigin } from '@varuna/api/src/modules/origin/service.js';
import { SpillDetectionModel } from '@varuna/api/src/modules/detections/model.js';

/**
 * `scoring` queue processor — correlate AIS against the origin estimate and rank candidates.
 *
 * The origin estimate is loaded here rather than passed in the job payload, so the scoring
 * always uses the CURRENT origin. A payload snapshot could silently score against a
 * superseded release zone after a re-run of the drift.
 */
export interface CorrelateJobData {
  investigationId: string;
  detectionId: string;
  originEstimateId: string;
}

export async function processCorrelate(job: Job<CorrelateJobData>) {
  const origin = await getOrigin(job.data.originEstimateId);
  const detection = await SpillDetectionModel.findById(job.data.detectionId).lean();
  if (!detection) throw new Error(`detection ${job.data.detectionId} not found`);

  const field = origin.originField as unknown as {
    support90?: { type: 'Polygon'; coordinates: number[][][] };
    centroid?: { type: 'Point'; coordinates: number[] };
  };
  const zone = field?.support90;
  if (!zone) {
    throw new Error(
      'The origin estimate has no support polygon, so no search envelope can be built. ' +
        'Re-run back-tracking before correlating.',
    );
  }

  const rw = origin.releaseWindow as unknown as {
    earliest: Date;
    latest: Date;
    status: 'OK' | 'WIDE';
  };
  const morph = detection.morphology as unknown as {
    orientationDeg?: number;
    elongationRatio?: number;
  };

  return correlate({
    investigationId: job.data.investigationId,
    detectionId: job.data.detectionId,
    originEstimateId: job.data.originEstimateId,
    originZone: zone,
    originCentroid: (field.centroid ?? {
      type: 'Point',
      coordinates: [0, 0],
    }) as { type: 'Point'; coordinates: number[] },
    releaseEarliest: rw.earliest.toISOString(),
    releaseLatest: rw.latest.toISOString(),
    releaseWindowStatus: rw.status,
    // The degraded flag travels from the stored origin, so a proximity-derived zone keeps
    // capping tiers at MODERATE wherever the scoring runs.
    originDegraded: origin.status !== 'OK',
    slickOrientationDeg: morph?.orientationDeg ?? null,
    slickElongationRatio: morph?.elongationRatio ?? null,
    onProgress: async (pct, stage, message) => {
      await job.updateProgress({ pct, stage, message });
    },
  });
}
