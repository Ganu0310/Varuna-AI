import { Types } from 'mongoose';
import type { Point, Polygon } from 'geojson';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { NotFoundError, ProviderUnavailable } from '../../errors.js';
import { rewindPolygon } from '../../geo/envelope.js';
import { recordProvenance } from '../provenance/service.js';
import { SpillDetectionModel } from '../detections/model.js';
import { SatelliteSceneModel } from '../scenes/model.js';
import { OriginEstimateModel } from './model.js';

/**
 * Origin estimation — 06_BACKEND §6.4.6, 07_AIML §7.3.
 *
 * The Node side owns persistence and provenance; the Python service runs the drift physics.
 * This module is the seam, and its job beyond plumbing is to make sure a DEGRADED result is
 * stored as degraded. A proximity-derived zone and a back-tracked drift field are different
 * kinds of claim, and the difference has to survive into the database, the UI and the report
 * — not just the log line at the moment it happened.
 */

interface MlBacktrackResponse {
  status: 'OK' | 'DEGRADED' | 'UNAVAILABLE';
  method: 'LAGRANGIAN_BACKTRACK' | 'FOOTPRINT_PROXIMITY';
  degradationReason: string | null;
  attempted: Array<{ provider: string; outcome: string; covers?: string }>;
  frames: Array<{ atTime: string; bounds: number[]; cellSizeDeg: number; centroid: number[] }>;
  support50: Polygon | null;
  support90: Polygon | null;
  centroid: [number, number];
  particles?: { count: number; lon: number[]; lat: number[] };
  releaseWindow: {
    earliest: string;
    latest: string;
    mostLikelyStart: string;
    mostLikelyEnd: string;
    status: 'OK' | 'WIDE';
    boundedByPriorClearScene?: boolean;
  };
  medianDriftSpeedMs?: number;
  forcing: {
    currents: Record<string, unknown> | null;
    winds: Record<string, unknown> | null;
  };
  params: Record<string, unknown>;
}

export interface RunOriginInput {
  investigationId: string;
  detectionId: string;
  horizonHours?: number;
  particleCount?: number;
  onProgress?: (pct: number, stage: string, message?: string) => void | Promise<void>;
}

export interface RunOriginOutput {
  originEstimateId: string;
  status: string;
  method: string;
  degradationReason: string | null;
  releaseWindow: MlBacktrackResponse['releaseWindow'];
  particleCount: number;
}

/**
 * The most recent acquisition over the same footprint that showed NO detection.
 *
 * This is a hard lower bound on the release time (07_AIML §7.3.5): if an earlier scene
 * covered the same water and was clear, the release cannot predate it. It is a real
 * observational constraint and it overrides the kinematic estimate, so it is worth the extra
 * query.
 */
async function priorClearSceneAt(
  investigationId: string,
  before: Date,
): Promise<string | undefined> {
  const scenes = await SatelliteSceneModel.find({
    investigationId: new Types.ObjectId(investigationId),
    acquiredAt: { $lt: before },
    status: 'READY',
  })
    .sort({ acquiredAt: -1 })
    .limit(5)
    .lean();

  for (const s of scenes) {
    const detections = await SpillDetectionModel.countDocuments({
      sceneId: s._id,
      reviewStatus: { $ne: 'REJECTED' },
    });
    if (detections === 0) return (s.acquiredAt as Date).toISOString();
  }
  return undefined;
}

export async function runOrigin(input: RunOriginInput): Promise<RunOriginOutput> {
  const progress = input.onProgress ?? (() => {});

  const detection = await SpillDetectionModel.findById(input.detectionId).lean();
  if (!detection) throw new NotFoundError('Detection not found');

  const scene = await SatelliteSceneModel.findById(detection.sceneId).lean();
  if (!scene) throw new NotFoundError('The detection references a scene that no longer exists');

  const observedAt = (scene.acquiredAt as Date).toISOString();

  await progress(10, 'FETCH_CURRENTS', 'Requesting ocean-current forcing');

  const priorClear = await priorClearSceneAt(input.investigationId, scene.acquiredAt as Date);

  const res = await fetch(`${env.ML_SERVICE_URL}/backtrack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': env.ML_SERVICE_TOKEN },
    body: JSON.stringify({
      geometry: detection.geometry,
      observedAt,
      horizonHours: input.horizonHours ?? 24,
      particleCount: input.particleCount ?? 5000,
      priorClearSceneAt: priorClear,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ProviderUnavailable(
      'ML_SERVICE',
      `HTTP_${res.status}`,
      undefined,
      detail.slice(0, 400),
      [{ provider: 'ML_SERVICE', outcome: `HTTP_${res.status}` }],
      'Back-tracking is unavailable, so no origin estimate was recorded. Correlation cannot ' +
        'run without one, and no partial or unverified origin enters the investigation.',
    );
  }

  const bt = (await res.json()) as MlBacktrackResponse;

  await progress(70, 'KDE', 'Building the origin probability surface');

  // Forcing provenance is recorded as its own immutable record so the origin estimate can be
  // traced to the exact ocean/atmosphere model run it used — a drift result is only as
  // defensible as the field it integrated.
  const forcingProvenanceIds: string[] = [];
  for (const f of [bt.forcing.currents, bt.forcing.winds]) {
    if (!f) continue;
    const id = await recordProvenance({
      sourceType: f.sourceType as never,
      provider: String(f.provider),
      datasetId: String(f.datasetId),
      externalId: String(f.externalId),
      retrievedAt: String(f.retrievedAt),
      licence: String(f.licence),
      accessUrl: f.accessUrl ? String(f.accessUrl) : undefined,
      derivedFrom: [],
    });
    forcingProvenanceIds.push(id);
  }

  await progress(85, 'CONTOURING', 'Storing support polygons');

  const support90 = bt.support90 ? rewindPolygon(bt.support90) : undefined;
  const support50 = bt.support50 ? rewindPolygon(bt.support50) : undefined;
  const centroid: Point = { type: 'Point', coordinates: bt.centroid };

  // A re-run supersedes: two origin estimates for one detection would let the UI show
  // contradictory release zones at once.
  await OriginEstimateModel.deleteMany({ detectionId: new Types.ObjectId(input.detectionId) });

  const doc = await OriginEstimateModel.create({
    investigationId: new Types.ObjectId(input.investigationId),
    detectionId: new Types.ObjectId(input.detectionId),
    method: bt.method,
    status: bt.status,
    // Stored, not just logged: the UI and the report both read this, and a degraded origin
    // must stay visibly degraded wherever it is used.
    degradationReason: bt.degradationReason,
    forcing: {
      currents: bt.forcing.currents
        ? {
            provider: String(bt.forcing.currents.provider),
            datasetId: String(bt.forcing.currents.datasetId),
            resolutionDeg: 0.08,
            temporalResolutionH: 3,
            provenanceId: forcingProvenanceIds[0]
              ? new Types.ObjectId(forcingProvenanceIds[0])
              : undefined,
          }
        : null,
      winds: bt.forcing.winds
        ? {
            provider: String(bt.forcing.winds.provider),
            datasetId: String(bt.forcing.winds.datasetId),
            resolutionDeg: 0.25,
            temporalResolutionH: 1,
            provenanceId: forcingProvenanceIds[1]
              ? new Types.ObjectId(forcingProvenanceIds[1])
              : undefined,
          }
        : null,
    },
    params: {
      particleCount: Number(bt.params.particleCount ?? 0),
      timeStepMinutes: Number(bt.params.timeStepMinutes ?? 15),
      horizonHours: Number(bt.params.horizonHours ?? 24),
      windDriftCoefficientRange: (bt.params.windDriftCoefficientRange as number[]) ?? [0, 0],
      ekmanDeflectionRangeDeg: (bt.params.ekmanDeflectionRangeDeg as number[]) ?? [0, 0],
      horizontalDiffusivity: Number(bt.params.horizontalDiffusivity ?? 0),
    },
    releaseWindow: {
      earliest: new Date(bt.releaseWindow.earliest),
      latest: new Date(bt.releaseWindow.latest),
      mostLikelyStart: new Date(bt.releaseWindow.mostLikelyStart),
      mostLikelyEnd: new Date(bt.releaseWindow.mostLikelyEnd),
      status: bt.releaseWindow.status,
    },
    originField: {
      frames: bt.frames.map((f) => ({
        atTime: new Date(f.atTime),
        gridKey: `origin/${input.detectionId}/${f.atTime}`,
        bounds: f.bounds,
        cellSizeDeg: f.cellSizeDeg,
      })),
      ...(support90 ? { support90 } : {}),
      ...(support50 ? { support50 } : {}),
      centroid,
    },
    provenance: {
      sourceType: 'DERIVED',
      provider: 'VARUNA',
      datasetId: `${bt.method.toLowerCase()}-v1`,
      externalId: `origin:${input.detectionId}`,
      retrievedAt: new Date(),
      licence: 'internal',
      derivedFrom: [...forcingProvenanceIds.map((id) => new Types.ObjectId(id))],
    },
  });

  await progress(100, 'COMPLETE');

  logger.info(
    {
      originEstimateId: String(doc._id),
      status: bt.status,
      method: bt.method,
      attempted: bt.attempted,
    },
    'origin estimate recorded',
  );

  return {
    originEstimateId: String(doc._id),
    status: bt.status,
    method: bt.method,
    degradationReason: bt.degradationReason,
    releaseWindow: bt.releaseWindow,
    particleCount: bt.particles?.count ?? 0,
  };
}

export async function getOrigin(id: string) {
  const doc = await OriginEstimateModel.findById(id).lean();
  if (!doc) throw new NotFoundError('Origin estimate not found');
  return doc;
}

export async function latestOriginForInvestigation(investigationId: string) {
  return OriginEstimateModel.findOne({ investigationId: new Types.ObjectId(investigationId) })
    .sort({ createdAt: -1 })
    .lean();
}
