import type { Job } from 'bullmq';
import { runSweepTick, type SweepRegionResult } from '@varuna/api/src/modules/sweep/service.js';

/**
 * `sweep` queue processor — one tick across every Discover watch region.
 *
 * A thin wrapper, deliberately: the actual logic lives in `runSweepTick`
 * (`apps/api/src/modules/sweep/service.ts`) so it is testable with plain Vitest, the same
 * way `processReport` wraps `buildReportData` rather than embedding report assembly here.
 * This function's only job is to run it as a BullMQ job and shape a result BullMQ can store.
 */
export interface SweepTickJobData {
  triggeredBy?: 'SCHEDULE' | 'MANUAL';
  /** One watch region, or every one of them when absent. The "Discover now" button sets it
   * to whatever region the analyst is looking at, so a manual sweep costs one region's
   * provider calls instead of four. */
  regionId?: string;
}

export async function processSweep(job: Job<SweepTickJobData>): Promise<{
  regions: SweepRegionResult[];
  totalFound: number;
  totalEnqueued: number;
}> {
  const scope = job.data?.regionId;
  await job.updateProgress({
    pct: 10,
    stage: 'SWEEPING',
    message: scope ? `Checking ${scope}` : 'Checking watch regions',
  });

  // A manual press asks 'what is out there?', so it re-searches a wide window instead of
  // the incremental gap a scheduled tick needs — see MANUAL_SWEEP_LOOKBACK_DAYS.
  const regions = await runSweepTick(scope, { manual: job.data?.triggeredBy === 'MANUAL' });

  await job.updateProgress({ pct: 100, stage: 'COMPLETE' });

  return {
    regions,
    totalFound: regions.reduce((s, r) => s + r.found, 0),
    totalEnqueued: regions.reduce((s, r) => s + r.enqueued, 0),
  };
}
