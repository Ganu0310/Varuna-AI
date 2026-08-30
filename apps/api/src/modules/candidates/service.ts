import { Types } from 'mongoose';
import type { Polygon } from 'geojson';
import { buffer as turfBuffer } from '@turf/turf';
import {
  ATTRIBUTION_FEATURES,
  DEFAULT_WEIGHT_PROFILE_ID,
  type AttributionFeatureKey,
} from '@varuna/shared';
import { logger } from '../../lib/logger.js';
import { HttpError, NotFoundError } from '../../errors.js';
import { rewindPolygon } from '../../geo/envelope.js';
import { audit } from '../audit/service.js';
import { reconstructTracks } from '../ais/tracks.js';
import { coverage } from '../ais/service.js';
import {
  rankCandidates,
  type CandidateInput,
  type ScoringContext,
} from '../attribution/features.js';
import { bootstrapCi, calibrationState } from '../attribution/bootstrap.js';
import { rankSeparation, type RankSeparation } from '../attribution/separation.js';
import { CandidateVesselModel } from './model.js';

/**
 * Correlation and candidate ranking — 06_BACKEND §6.6.2, §6.4.8.
 *
 * The single most important behaviour in this module is the NO_AIS_COVERAGE path. When the
 * envelope contains no AIS at all, returning an empty candidate list would render as "no
 * suspects found", which reads as an exoneration. It is not: it means we could not see. The
 * result therefore carries an explicit reason and the list of sources queried, so the
 * absence of evidence is never presented as evidence of absence (08_APP_FLOW §8.3).
 */

export interface CorrelateInput {
  investigationId: string;
  detectionId: string;
  originZone: Polygon;
  originCentroid: { type: 'Point'; coordinates: number[] };
  releaseEarliest: string;
  releaseLatest: string;
  releaseWindowStatus: 'OK' | 'WIDE';
  originDegraded: boolean;
  slickOrientationDeg: number | null;
  slickElongationRatio: number | null;
  originEstimateId?: string;
  actorId?: string;
  onProgress?: (pct: number, stage: string, message?: string) => void | Promise<void>;
}

export interface CorrelateResult {
  reason: 'OK' | 'NO_AIS_COVERAGE';
  candidateIds: string[];
  candidateCount: number;
  insufficientCount: number;
  sourcesQueried?: Array<{ source: string; recordCount: number; bboxCovered: boolean }>;
  message?: string;
  calibration: ReturnType<typeof calibrationState>;
  /** Whether the top of the ranking survives redrawing the uncertain inputs. */
  separation: RankSeparation;
}

/** Envelope radius: 15 km around a real drift support, 40 km when the origin is degraded. */
export function envelopeFor(originZone: Polygon, degraded: boolean): Polygon {
  const bufferKm = degraded ? 40 : 15;
  const buffered = turfBuffer(originZone, bufferKm, { units: 'kilometers' });
  if (!buffered) throw new Error('failed to buffer the origin zone');
  return rewindPolygon(buffered.geometry as Polygon);
}

export async function correlate(input: CorrelateInput): Promise<CorrelateResult> {
  const progress = input.onProgress ?? (() => {});

  await progress(10, 'ENVELOPE', 'Building the AIS search envelope');
  const envelope = envelopeFor(input.originZone, input.originDegraded);
  const ring = envelope.coordinates[0]!;
  const lons = ring.map((c) => c[0]!);
  const lats = ring.map((c) => c[1]!);
  const bbox: [number, number, number, number] = [
    Math.min(...lons),
    Math.min(...lats),
    Math.max(...lons),
    Math.max(...lats),
  ];

  // Widen the query by 3 h either side: a vessel that discharged at the window's edge is
  // still a candidate, and its approach track is what makes it one.
  const from = new Date(Date.parse(input.releaseEarliest) - 3 * 3_600_000).toISOString();
  const to = new Date(Date.parse(input.releaseLatest) + 3 * 3_600_000).toISOString();

  await progress(30, 'AIS_QUERY', 'Querying AIS in the envelope');
  const cov = await coverage(from, to, bbox);

  if (cov.recordCount === 0) {
    // NOT an empty success. "No candidates" and "no visibility" are different findings.
    logger.warn({ bbox, from, to }, 'correlation found no AIS coverage');
    return {
      reason: 'NO_AIS_COVERAGE',
      candidateIds: [],
      candidateCount: 0,
      insufficientCount: 0,
      // There is no ranking, so there is nothing to separate. Stated in the same shape as a
      // real result so a client never has to branch on the field being absent.
      separation: {
        iterations: 0,
        consideredCount: 0,
        topRankShare: [],
        leader: null,
        verdict:
          'No ranking was produced, so no separation between candidates can be measured. ' +
          'This reflects an absence of AIS observation, not an absence of vessels.',
        note: 'No paired resampling was run.',
      },
      sourcesQueried: [{ source: 'LOCAL_ARCHIVE', recordCount: 0, bboxCovered: false }],
      message:
        'No AIS positions exist for this area and time window, so no vessel could be ' +
        'evaluated. This is an absence of observation, not an absence of vessels — an ' +
        'untracked or non-transmitting vessel would look identical.',
      calibration: calibrationState(0),
    };
  }

  await progress(50, 'TRACKS', `Reconstructing tracks from ${cov.recordCount} positions`);
  const tracks = await reconstructTracks(from, to, bbox);

  const candidates: CandidateInput[] = tracks.map((t) => ({
    mmsi: t.mmsi,
    shipType: t.shipType,
    fixes: t.fixes,
    gaps: t.gaps,
    trackLine: t.line,
    priorIncidents: null,
  }));

  await progress(70, 'SCORING', `Scoring ${candidates.length} candidates`);
  const ctx: ScoringContext = {
    originZone: input.originZone,
    originCentroid: input.originCentroid as never,
    releaseEarliest: input.releaseEarliest,
    releaseLatest: input.releaseLatest,
    slickOrientationDeg: input.slickOrientationDeg,
    slickElongationRatio: input.slickElongationRatio,
    releaseWindowStatus: input.releaseWindowStatus,
    originDegraded: input.originDegraded,
  };

  const ranked = rankCandidates(candidates, ctx);
  const calibration = calibrationState(0);

  /*
   * Is the top of this ranking real, or did the estimates just land that way?
   *
   * Run once over the whole field rather than per candidate, because it is the one question
   * a per-candidate interval cannot answer: the origin zone is a single shared input, so its
   * uncertainty has to be drawn once and applied to everyone at the same time.
   */
  const separation = rankSeparation(
    ranked.map((r) => candidates.find((c) => c.mmsi === r.mmsi)!),
    ctx,
    300,
  );
  const shareByMmsi = new Map(separation.topRankShare.map((t) => [t.mmsi, t.share]));

  await progress(85, 'PERSISTING', 'Recording candidates');

  // Replace any previous ranking for this detection: a re-run supersedes rather than
  // accumulates, so the UI cannot show two contradictory rankings at once.
  await CandidateVesselModel.deleteMany({
    investigationId: new Types.ObjectId(input.investigationId),
    detectionId: new Types.ObjectId(input.detectionId),
  });

  const candidateIds: string[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i]!;
    const c = candidates.find((x) => x.mmsi === r.mmsi)!;
    // CIs only for the vessels a reader would act on; 500 iterations × 200 candidates would
    // dominate the run for no decision-relevant gain.
    const ci = i < 10 ? bootstrapCi(c, ctx, 300, r.mmsi) : null;

    const doc = await CandidateVesselModel.create({
      investigationId: new Types.ObjectId(input.investigationId),
      detectionId: new Types.ObjectId(input.detectionId),
      originEstimateId: input.originEstimateId
        ? new Types.ObjectId(input.originEstimateId)
        : new Types.ObjectId(),
      trackId: new Types.ObjectId(),
      mmsi: r.mmsi,
      score: r.score,
      scoreCI: ci ? ci.ci : [r.score, r.score],
      scoreCiBoundaryEffect: ci?.boundaryEffect ?? null,
      // Zero draws is a measured zero -- this vessel never came first. Only a candidate
      // outside the resampled field has no answer at all, and that is null.
      topRankShare: i < separation.consideredCount ? (shareByMmsi.get(r.mmsi) ?? 0) : null,
      // Carried on rank 1 alone: it describes the ORDER, not this vessel.
      separation:
        i === 0 && separation.leader
          ? {
              ...separation.leader,
              iterations: separation.iterations,
              consideredCount: separation.consideredCount,
              verdict: separation.verdict,
            }
          : null,
      tier: r.tier,
      rank: i + 1,
      features: r.features.map((f) => ({
        key: f.key,
        rawValue: f.rawValue,
        rawUnit: f.rawUnit,
        normalised: f.normalised,
        weight: f.weight,
        contribution: f.contribution,
        status: f.status,
        evidenceRefs: f.evidenceRefs,
      })),
      measuredFeatureCount: r.measuredFeatureCount,
      weightProfileId: DEFAULT_WEIGHT_PROFILE_ID,
      modelVersion: 'attribution-v1',
      calibrated: calibration.calibrated,
      provenance: {
        sourceType: 'DERIVED',
        provider: 'VARUNA',
        datasetId: 'attribution-v1',
        externalId: `candidate:${input.detectionId}:${r.mmsi}`,
        retrievedAt: new Date(),
        licence: 'internal',
        derivedFrom: [],
      },
    });
    candidateIds.push(String(doc._id));
  }

  await progress(100, 'COMPLETE');

  return {
    reason: 'OK',
    candidateIds,
    candidateCount: ranked.length,
    insufficientCount: ranked.filter((r) => r.tier === 'INSUFFICIENT_EVIDENCE').length,
    separation,
    sourcesQueried: [{ source: cov.source, recordCount: cov.recordCount, bboxCovered: true }],
    calibration,
  };
}

/**
 * Re-rank with an analyst-supplied weight profile — 06_BACKEND §6.4.8.
 *
 * Synchronous and fast because it must feel like moving a slider, and it recomputes only
 * the weighting: the underlying measurements are untouched, so an analyst can explore how
 * much the ranking depends on their priors without re-running any analysis.
 *
 * The profile used is recorded on every candidate, because a ranking produced under
 * non-default weights must be identifiable as such in the report.
 */
export async function reweight(
  investigationId: string,
  detectionId: string,
  weights: Partial<Record<AttributionFeatureKey, number>>,
  profileId: string,
  actorId?: string,
  requestId?: string,
) {
  const total = Object.values(weights).reduce((s, w) => s + (w ?? 0), 0);
  if (Math.abs(total - 1) > 0.001) {
    throw new HttpError(
      422,
      'Weights must sum to 1.00',
      `The supplied weights sum to ${total.toFixed(3)}. A profile that does not sum to 1 ` +
        'would make scores incomparable between candidates.',
      'https://varuna.dev/problems/weights-not-normalised',
    );
  }

  const docs = await CandidateVesselModel.find({
    investigationId: new Types.ObjectId(investigationId),
    detectionId: new Types.ObjectId(detectionId),
  });
  if (docs.length === 0) throw new NotFoundError('No candidates to reweight');

  const rescored = docs.map((doc) => {
    let contributions = 0;
    let measuredWeight = 0;

    const features = doc.features.map((f) => {
      const w = weights[f.key as AttributionFeatureKey] ?? f.weight;
      const contribution =
        f.status === 'MEASURED' && f.normalised != null ? f.normalised * w : null;
      if (f.status === 'MEASURED') {
        measuredWeight += w;
        contributions += contribution ?? 0;
      }
      return { ...(f.toObject?.() ?? f), weight: w, contribution };
    });

    // The same renormalisation rule as the original scoring: measured features only.
    const score = measuredWeight > 0 ? (100 * contributions) / measuredWeight : 0;
    return { doc, features, score: Math.round(score * 10) / 10, measuredWeight };
  });

  rescored.sort((a, b) => b.score - a.score);

  for (let i = 0; i < rescored.length; i++) {
    const { doc, features, score } = rescored[i]!;
    doc.score = score;
    doc.rank = i + 1;
    doc.features = features as never;
    doc.weightProfileId = profileId;
    /*
     * Separation is CLEARED, not recarried and not recomputed.
     *
     * Not recarried: it was measured for a different ordering, and a verdict saying "the top
     * two are clearly separated" sitting above a top two the analyst has just rearranged
     * would be the most misleading thing on the screen.
     *
     * Not recomputed: reweighting deliberately re-scores from the stored feature
     * contributions and never touches the tracks or the origin zone -- that is what makes it
     * fast enough to feel like a slider. The inputs a paired resample needs are not here.
     * Re-running correlation restores it.
     */
    doc.topRankShare = null;
    doc.separation = null;
    await doc.save();
  }

  await audit({
    actorId,
    action: 'CANDIDATES_REWEIGHTED',
    entityType: 'Investigation',
    entityId: investigationId,
    after: { profileId, weights },
    requestId,
  });

  return {
    profileId,
    items: rescored.map(({ doc }) => doc.toObject()),
    note:
      'Re-ranked under a non-default weight profile. The profile is recorded on every ' +
      'candidate and appears in the report, because a ranking depends on the priors used ' +
      'to produce it. Rank-separation figures are cleared rather than carried over: they ' +
      'were measured for the previous ordering, and re-running correlation is what restores ' +
      'them.',
  };
}

export async function excludeCandidate(
  candidateId: string,
  reason: string,
  actorId: string,
  requestId?: string,
) {
  if (!reason.trim()) {
    throw new HttpError(
      422,
      'A reason is required to exclude a candidate',
      'Excluding removes a vessel from the ranking. State why, so the decision can be ' +
        'reviewed — an unexplained exclusion is indistinguishable from hiding evidence.',
      'https://varuna.dev/problems/exclusion-reason-required',
    );
  }

  const doc = await CandidateVesselModel.findById(candidateId);
  if (!doc) throw new NotFoundError('Candidate not found');

  doc.excluded = { by: new Types.ObjectId(actorId), at: new Date(), reason } as never;
  await doc.save();

  await audit({
    actorId,
    action: 'CANDIDATE_EXCLUDED',
    entityType: 'CandidateVessel',
    entityId: candidateId,
    after: { mmsi: doc.mmsi, reason },
    requestId,
  });

  return doc.toObject();
}

export const DEFAULT_WEIGHTS = Object.fromEntries(
  ATTRIBUTION_FEATURES.map((f) => [f.key, f.defaultWeight]),
) as Record<AttributionFeatureKey, number>;
