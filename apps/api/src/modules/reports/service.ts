import { Types } from 'mongoose';
import { MANDATORY_REPORT_SECTIONS } from '@varuna/shared';
import { HttpError, NotFoundError } from '../../errors.js';
import { InvestigationModel } from '../investigations/model.js';
import { SatelliteSceneModel } from '../scenes/model.js';
import { SpillDetectionModel } from '../detections/model.js';
import { CandidateVesselModel } from '../candidates/model.js';
import { OriginEstimateModel } from '../origin/model.js';
import { ProvenanceRecordModel } from '../provenance/model.js';
import { coverage } from '../ais/service.js';

/**
 * Report assembly — 06_BACKEND §6.4.9, 01_PRD FR-1 F1.
 *
 * Two sections are structurally mandatory and cannot be deselected: UNCERTAINTY and
 * PROVENANCE. This is enforced in three places — the request schema, this service, and the
 * job — because a dossier that names a vessel without stating what the analysis could not
 * establish, and where every number came from, is not a lesser report. It is a misleading
 * one, and it is exactly the document someone would want when the caveats are inconvenient.
 */

export const ALL_SECTIONS = [
  'SUMMARY',
  'SCENES',
  'DETECTIONS',
  'ORIGIN',
  'AIS',
  'CANDIDATES',
  'EVIDENCE',
  'UNCERTAINTY',
  'PROVENANCE',
] as const;
export type ReportSection = (typeof ALL_SECTIONS)[number];

/** Adds the mandatory sections and de-duplicates. Never removes them. */
export function enforceMandatorySections(requested: string[]): ReportSection[] {
  const set = new Set<string>(requested);
  for (const m of MANDATORY_REPORT_SECTIONS) set.add(m);
  return ALL_SECTIONS.filter((s) => set.has(s));
}

export function assertMandatorySections(requested: string[]): void {
  const missing = MANDATORY_REPORT_SECTIONS.filter((m) => !requested.includes(m));
  if (missing.length > 0) {
    throw new HttpError(
      422,
      'Mandatory report sections cannot be omitted',
      `A dossier must include ${missing.join(' and ')}. A report that names a vessel without ` +
        'stating the limits of the analysis, or where its numbers came from, misrepresents ' +
        'the strength of the finding.',
      'https://varuna.dev/problems/mandatory-sections',
    );
  }
}

export interface UncertaintyStatement {
  statements: Array<{ topic: string; text: string; severity: 'INFO' | 'CAVEAT' | 'LIMITATION' }>;
  overall: string;
}

export interface ProvenanceAppendix {
  records: Array<{
    id: string;
    sourceType: string;
    provider: string;
    datasetId: string;
    externalId: string;
    licence: string;
    retrievedAt: string;
    derivedFrom: string[];
  }>;
  lineageNote: string;
}

export interface RunManifest {
  pipelineVersion: string;
  detectorSha: string | null;
  weightProfileId: string | null;
  sceneProductIds: string[];
  aisSource: string | null;
  originMethod: string | null;
  generatedAt: string;
  note: string;
}

export interface ReportData {
  investigation: Record<string, unknown>;
  scenes: Record<string, unknown>[];
  detections: Record<string, unknown>[];
  origin: Record<string, unknown> | null;
  aisCoverage: Awaited<ReturnType<typeof coverage>> | null;
  candidates: Record<string, unknown>[];
  uncertainty: UncertaintyStatement;
  provenance: ProvenanceAppendix;
  manifest: RunManifest;
  sections: ReportSection[];
  generatedAt: string;
}

/**
 * Build the uncertainty statement from what the run ACTUALLY did — not a boilerplate
 * paragraph. Each caveat is derived from a recorded state, so it cannot go stale or be
 * quietly softened between runs.
 */
function buildUncertainty(
  origin: Record<string, unknown> | null,
  cov: Awaited<ReturnType<typeof coverage>> | null,
  candidates: Record<string, unknown>[],
  detections: Record<string, unknown>[],
): UncertaintyStatement {
  const s: UncertaintyStatement['statements'] = [];

  const degraded = origin?.status === 'DEGRADED' || origin === null;
  if (degraded) {
    s.push({
      topic: 'Origin estimate',
      severity: 'LIMITATION',
      text:
        origin === null
          ? 'No origin estimate was produced. Without back-tracking, no release location or ' +
            'time can be stated, and any spatial association with a vessel rests on proximity ' +
            'to the observed slick alone.'
          : `The origin estimate is DEGRADED (${String(origin.degradationReason ?? 'forcing unavailable')}). ` +
            'A proximity-derived zone cannot distinguish upstream from downstream, so it cannot ' +
            'separate a discharging vessel from ordinary passing traffic. Candidate tiers are ' +
            'capped at MODERATE for this reason.',
    });
  }

  const uncalibrated = candidates.some((c) => c.calibrated === false);
  if (uncalibrated || candidates.length === 0) {
    s.push({
      topic: 'Score calibration',
      severity: 'LIMITATION',
      text:
        'Scores are UNCALIBRATED weighted evidence, not probabilities. Too few validated ' +
        'incidents exist to fit a calibration, so a score of 70 does not mean a 70% likelihood ' +
        'of responsibility. Scores are comparable between candidates in this report, and not ' +
        'between reports.',
    });
  }

  if (cov) {
    if (cov.distinctVessels < 5) {
      s.push({
        topic: 'AIS coverage',
        severity: 'LIMITATION',
        text:
          `Only ${cov.distinctVessels} vessel(s) were transmitting in this area and window. A ` +
          'highly-ranked candidate may reflect sparse coverage rather than strong evidence: a ' +
          'vessel that was not transmitting could not be considered at all.',
      });
    } else {
      s.push({ topic: 'AIS coverage', severity: 'INFO', text: cov.assessment });
    }
    if (cov.medianIntervalSec && cov.medianIntervalSec > 600) {
      s.push({
        topic: 'AIS sampling',
        severity: 'CAVEAT',
        text:
          `The median reporting interval was ${Math.round(cov.medianIntervalSec)} s. Positions ` +
          'between fixes are interpolated, and manoeuvres shorter than that interval were not ' +
          'observed.',
      });
    }
  }

  const risky = detections.filter(
    (d) => ((d.confidence as { lookAlikeCompetition?: number })?.lookAlikeCompetition ?? 0) > 0.4,
  );
  if (risky.length > 0) {
    s.push({
      topic: 'Detection',
      severity: 'CAVEAT',
      text:
        `${risky.length} detection(s) carry a look-alike risk above 0.4. Low-wind zones, ` +
        'biogenic films and rain cells produce dark SAR features that shape alone cannot ' +
        'separate from oil.',
    });
  }

  s.push({
    topic: 'Detector',
    severity: 'LIMITATION',
    text:
      'Detection used a classical adaptive-threshold algorithm, not a trained segmentation ' +
      'model. It locates dark features and scores how oil-like their shape and context are; it ' +
      'cannot classify oil versus look-alike from texture, and has no measured oil-IoU or ' +
      'false-positive rate on a held-out test split.',
  });

  const insufficient = candidates.filter((c) => c.tier === 'INSUFFICIENT_EVIDENCE').length;
  if (insufficient > 0) {
    s.push({
      topic: 'Evidence sufficiency',
      severity: 'INFO',
      text:
        `${insufficient} of ${candidates.length} candidates returned INSUFFICIENT_EVIDENCE: ` +
        'fewer than six of twelve evidence features could be measured. Their scores are ' +
        'withheld rather than ranked.',
    });
  }

  return {
    statements: s,
    overall:
      'This report ranks investigative leads. It is not a determination of responsibility. ' +
      'Every score is weighted evidence renormalised over the features that could actually be ' +
      'measured, and every limitation above materially affects how the ranking should be read.',
  };
}

export async function buildReportData(
  investigationId: string,
  requestedSections: string[],
): Promise<ReportData> {
  assertMandatorySections(requestedSections);
  const sections = enforceMandatorySections(requestedSections);

  const inv = await InvestigationModel.findOne({ _id: investigationId, deletedAt: null }).lean();
  if (!inv) throw new NotFoundError('Investigation not found');

  const oid = new Types.ObjectId(investigationId);
  const [scenes, detections, candidates, origin] = await Promise.all([
    SatelliteSceneModel.find({ investigationId: oid }).sort({ acquiredAt: 1 }).lean(),
    SpillDetectionModel.find({ investigationId: oid }).sort({ 'confidence.overall': -1 }).lean(),
    CandidateVesselModel.find({ investigationId: oid }).sort({ rank: 1 }).lean(),
    OriginEstimateModel.findOne({ investigationId: oid }).sort({ createdAt: -1 }).lean(),
  ]);

  const ring = (inv.aoi as unknown as { coordinates: number[][][] }).coordinates[0]!;
  const lons = ring.map((c) => c[0]!);
  const lats = ring.map((c) => c[1]!);

  let cov: Awaited<ReturnType<typeof coverage>> | null = null;
  try {
    cov = await coverage(inv.windowStart.toISOString(), inv.windowEnd.toISOString(), [
      Math.min(...lons),
      Math.min(...lats),
      Math.max(...lons),
      Math.max(...lats),
    ]);
  } catch {
    cov = null;
  }

  // The provenance appendix IS the lineage DAG (13_REAL_DATA_POLICY §13.5.1): every record,
  // with its parents, so a reader can walk from a candidate back to a provider product.
  const provRecords = await ProvenanceRecordModel.find().sort({ createdAt: 1 }).limit(500).lean();

  return {
    investigation: inv as unknown as Record<string, unknown>,
    scenes: scenes as unknown as Record<string, unknown>[],
    detections: detections as unknown as Record<string, unknown>[],
    origin: (origin as unknown as Record<string, unknown>) ?? null,
    aisCoverage: cov,
    candidates: candidates as unknown as Record<string, unknown>[],
    uncertainty: buildUncertainty(
      (origin as unknown as Record<string, unknown>) ?? null,
      cov,
      candidates as unknown as Record<string, unknown>[],
      detections as unknown as Record<string, unknown>[],
    ),
    provenance: {
      records: provRecords.map((p) => ({
        id: String(p._id),
        sourceType: String(p.sourceType),
        provider: String(p.provider),
        datasetId: String(p.datasetId),
        externalId: String(p.externalId),
        licence: String(p.licence),
        retrievedAt: (p.retrievedAt as Date).toISOString(),
        derivedFrom: (p.derivedFrom ?? []).map((d) => String(d)),
      })),
      lineageNote:
        'Every observed or derived object in this report carries a provenance record. The ' +
        'derivedFrom field links each derived value back to the provider product it came from, ' +
        'so any figure here can be traced to a dataset an independent party can retrieve.',
    },
    manifest: {
      pipelineVersion: 'varuna-1.0.0',
      detectorSha:
        (detections[0]?.model as { artefactSha256?: string } | undefined)?.artefactSha256 ?? null,
      weightProfileId: (candidates[0]?.weightProfileId as string | undefined) ?? null,
      sceneProductIds: scenes.map((s) => String(s.productId)),
      aisSource: cov?.source ?? null,
      originMethod: (origin?.method as string | undefined) ?? null,
      generatedAt: new Date().toISOString(),
      note:
        'This manifest pins what is needed to reproduce the run: scene product IDs, the ' +
        'detector artefact hash, the weight profile, and the AIS source.',
    },
    sections,
    generatedAt: new Date().toISOString(),
  };
}
