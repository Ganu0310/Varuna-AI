import { Types } from 'mongoose';
import type { Role } from '@varuna/shared';
import { InvestigationModel, REAL_CASE_FILTER } from '../investigations/model.js';
import { SatelliteSceneModel } from '../scenes/model.js';
import { SpillDetectionModel } from '../detections/model.js';
import { CandidateVesselModel } from '../candidates/model.js';
import { JobModel } from '../jobs/model.js';

/**
 * The operations dashboard's data — one request, so the landing screen does not fan out into
 * six.
 *
 * SCOPING IS THE WHOLE DESIGN HERE. Counts are computed over the investigations the caller
 * can actually see: an admin's totals cover the instance, an analyst's cover their own cases.
 * Any other choice makes the tiles lie to somebody. Showing an analyst an instance-wide
 * detection count would have them hunting for detections they cannot open; showing an admin
 * only their own would make the dashboard useless for the job it exists to do.
 *
 * So the visible-investigation id list is resolved FIRST and every other count is constrained
 * to it, rather than each collection being counted independently and hoped to agree.
 */

export interface DashboardOverview {
  generatedAt: string;
  scope: 'INSTANCE' | 'OWN';
  counts: {
    investigations: number;
    scenes: number;
    detections: number;
    candidates: number;
    jobs: number;
  };
  recentInvestigations: Array<{
    _id: string;
    name: string | null;
    status: string | null;
    aoiAreaKm2: number | null;
    createdAt: string | null;
  }>;
  recentJobs: Array<{
    _id: string;
    kind: string;
    status: string;
    investigationId: string | null;
    progressPct: number | null;
    createdAt: string | null;
  }>;
}

export async function buildOverview(actor: { id: string; role: Role }): Promise<DashboardOverview> {
  const isAdmin = actor.role === 'admin';
  const actorId = new Types.ObjectId(actor.id);

  // Excludes Discover's sweep-container investigations — see `REAL_CASE_FILTER`'s own
  // comment in modules/investigations/model.ts.
  const visibleFilter: Record<string, unknown> = { deletedAt: null, ...REAL_CASE_FILTER };
  if (!isAdmin) {
    visibleFilter.$or = [{ createdBy: actorId }, { 'members.userId': actorId }];
  }

  const visible = await InvestigationModel.find(visibleFilter, {
    name: 1,
    status: 1,
    aoiAreaKm2: 1,
    createdAt: 1,
  })
    .sort({ _id: -1 })
    .lean();

  const ids = visible.map((v) => v._id);

  // An empty id list would make `$in: []` match nothing, which is correct — but running four
  // collection scans to discover that is not, so short-circuit.
  const [scenes, detections, candidates, jobs, recentJobs] =
    ids.length === 0
      ? [0, 0, 0, 0, []]
      : await Promise.all([
          SatelliteSceneModel.countDocuments({ investigationId: { $in: ids } }),
          SpillDetectionModel.countDocuments({ investigationId: { $in: ids } }),
          CandidateVesselModel.countDocuments({ investigationId: { $in: ids } }),
          JobModel.countDocuments({ investigationId: { $in: ids } }),
          JobModel.find({ investigationId: { $in: ids } })
            .sort({ _id: -1 })
            .limit(8)
            .lean(),
        ]);

  return {
    generatedAt: new Date().toISOString(),
    scope: isAdmin ? 'INSTANCE' : 'OWN',
    counts: {
      investigations: visible.length,
      scenes: scenes as number,
      detections: detections as number,
      candidates: candidates as number,
      jobs: jobs as number,
    },
    recentInvestigations: visible.slice(0, 6).map((v) => ({
      _id: String(v._id),
      name: v.name ?? null,
      status: v.status ?? null,
      aoiAreaKm2: typeof v.aoiAreaKm2 === 'number' ? v.aoiAreaKm2 : null,
      createdAt: v.createdAt ? new Date(v.createdAt as Date).toISOString() : null,
    })),
    recentJobs: (recentJobs as Array<Record<string, unknown>>).map((j) => ({
      _id: String(j._id),
      kind: String(j.kind),
      status: String(j.status),
      investigationId: j.investigationId ? String(j.investigationId) : null,
      progressPct:
        j.progress && typeof (j.progress as { pct?: unknown }).pct === 'number'
          ? ((j.progress as { pct: number }).pct ?? null)
          : null,
      createdAt: j.createdAt ? new Date(j.createdAt as Date).toISOString() : null,
    })),
  };
}
