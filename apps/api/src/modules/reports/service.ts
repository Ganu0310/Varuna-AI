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
import { detectorLimitationText } from './detectorMetrics.js';

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

/** One candidate vessel, translated for a reader with no domain background. */
export interface PlainVesselSummary {
  mmsi: number;
  rank: number;
  /** A complete sentence — never a bare tier label. */
  assessment: string;
}

/**
 * The dossier, for someone who has never seen a SAR image or an MMSI before — a journalist,
 * an official, a member of the public. Every field here is prose, derived from the same real
 * numbers the technical sections show, never a separate or softer set of facts.
 *
 * `PlainVesselSummary.assessment` is the one place this differs in KIND from the technical
 * dossier rather than only in wording: a tier and a confidence interval are replaced with a
 * sentence, because a non-specialist reader who sees "MODERATE, 64–77" has no way to know
 * whether that is reassuring or alarming, and guessing wrongly in either direction is worse
 * than the plain sentence costing a little precision.
 */
export interface PlainSummary {
  headline: string;
  howThisWasFound: string;
  whatWasSeen: string;
  whereAndWhen: string;
  possibleOrigin: string;
  vesselsIntro: string;
  vessels: PlainVesselSummary[];
  /** Each entry is one complete, standalone caveat — never a fragment needing the others. */
  whatWeDontKnow: string[];
  bottomLine: string;
}

export interface ReportData {
  investigation: Record<string, unknown>;
  scenes: Record<string, unknown>[];
  detections: Record<string, unknown>[];
  origin: Record<string, unknown> | null;
  aisCoverage: Awaited<ReturnType<typeof coverage>> | null;
  candidates: Record<string, unknown>[];
  uncertainty: UncertaintyStatement;
  /**
   * NOTE: deliberately NOT named `provenance`. That key is reserved for a provenance
   * RECORD, and `provenanceGuard` validates any object carrying it against the shared Zod
   * schema — an appendix under that name is stripped from the response as malformed.
   */
  provenanceAppendix: ProvenanceAppendix;
  /**
   * Always computed, like `uncertainty` and `provenanceAppendix` — there is no `sections`
   * toggle for it. A document written for a non-specialist is not an optional extra a report
   * can be generated without; it is the only version of this report most of its eventual
   * readers will ever open.
   */
  plainSummary: PlainSummary;
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
    // Stays a LIMITATION even once measured. Knowing the false-positive rate does not remove
    // it; the number IS the caveat.
    text: detectorLimitationText(),
  });

  /*
   * The most decision-relevant sentence in the dossier, when it applies.
   *
   * A reader who acts on a ranking acts on its top row. If redrawing the uncertain inputs
   * reorders the top two, that is a limitation of the analysis, not a detail -- and it has
   * to appear in the section a reader turns to for exactly this.
   */
  const sep = (candidates.find((c) => c.rank === 1) ?? candidates[0])?.separation as
    | { winShare: number; meanMargin: number; distinguishable: boolean; verdict: string }
    | null
    | undefined;

  if (sep && !sep.distinguishable) {
    s.push({ topic: 'Rank separation', severity: 'LIMITATION', text: sep.verdict });
  } else if (sep && sep.meanMargin < 2) {
    s.push({ topic: 'Rank separation', severity: 'CAVEAT', text: sep.verdict });
  } else if (!sep && candidates.length > 1) {
    // Absence of the measurement is itself worth stating: a reader must not read a missing
    // separation figure as a clean one.
    s.push({
      topic: 'Rank separation',
      severity: 'CAVEAT',
      text:
        'Whether the top two candidates are separable was not measured for this ranking. ' +
        'That is the case after re-ranking under custom weights, which clears the figure ' +
        'rather than carrying forward one measured for a different ordering. Re-run ' +
        'correlation to restore it. Until then, treat the gap between the first and second ' +
        'candidate as unquantified.',
    });
  }

  const atBoundary = candidates.filter((c) => c.scoreCiBoundaryEffect);
  if (atBoundary.length > 0) {
    s.push({
      topic: 'Score intervals',
      severity: 'CAVEAT',
      text:
        `${atBoundary.length} candidate(s) have a score sitting at the optimistic end of ` +
        'their confidence interval rather than its centre. This happens when the evidence ' +
        'rests on a measurement already at its limit — a closest approach of 0 km cannot get ' +
        'closer — so any perturbation of the uncertain inputs moves the score down and never ' +
        'up. Treat those scores as a ceiling, not a best guess.',
    });
  }

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

/** A FIFA regulation pitch, 105 m × 68 m. A fixed reference for scale, not a measurement. */
const FOOTBALL_PITCH_KM2 = 0.00714;

function formatKm2Plain(km2: number): string {
  if (km2 < 0.01) return 'less than 0.01 km²';
  return km2 < 100 ? `${km2.toFixed(2)} km²` : `${Math.round(km2).toLocaleString('en-GB')} km²`;
}

/** "21 September 2025 at 20:07 UTC" — a date a reader can say out loud. */
function formatPlainDateTime(d: Date): string {
  const date = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${date} at ${d.toISOString().slice(11, 16)} UTC`;
}

const TIER_PLAIN: Record<string, string> = {
  STRONG:
    'This is a strong lead: the evidence available fits well with this ship having been ' +
    'involved.',
  MODERATE:
    'This is worth investigating further: some evidence points this way, but it is not ' +
    'strong enough on its own to be sure.',
  WEAK: 'This is a weak lead: a little evidence exists, but not much.',
  INSUFFICIENT_EVIDENCE:
    'This could not really be assessed: too little information was available about this ' +
    'ship to judge how likely it is to be involved.',
};

/**
 * The same finding, written for a reader who has never seen a SAR image or an MMSI —
 * a journalist, an official, a member of the public. 01_PRD FR-1 F1, extended to serve the
 * document's actual widest audience rather than only its analysts.
 *
 * The rule is the same one `buildUncertainty` follows: every sentence is derived from a
 * recorded state, never a template filled from nothing. This function does not call
 * `buildUncertainty` and rephrase its output, because that output is written for a reader who
 * already knows what "uncalibrated" and "look-alike risk" mean; translating jargon sentence by
 * sentence keeps the jargon's shape. Instead this walks the same real inputs a second time and
 * writes each caveat as a reader with no background would need it stated.
 */
export function buildPlainSummary(
  inv: { aoi?: unknown; windowStart?: unknown; windowEnd?: unknown },
  detections: Record<string, unknown>[],
  origin: Record<string, unknown> | null,
  cov: Awaited<ReturnType<typeof coverage>> | null,
  candidates: Record<string, unknown>[],
): PlainSummary {
  const totalAreaKm2 = detections.reduce(
    (sum, d) => sum + (Number((d as { areaKm2?: number }).areaKm2) || 0),
    0,
  );
  const pitches = Math.max(1, Math.round(totalAreaKm2 / FOOTBALL_PITCH_KM2));

  const windowStart = inv.windowStart ? new Date(String(inv.windowStart)) : null;
  const windowEnd = inv.windowEnd ? new Date(String(inv.windowEnd)) : null;

  // A rough centre of the marked area, for a reader with no map in front of them — not the
  // AOI itself, which the technical dossier's map already shows precisely.
  const ring = (inv.aoi as { coordinates?: number[][][] } | undefined)?.coordinates?.[0] ?? [];
  const lons = ring.map((c) => c[0]).filter((n): n is number => typeof n === 'number');
  const lats = ring.map((c) => c[1]).filter((n): n is number => typeof n === 'number');
  const centreLon = lons.length ? (Math.min(...lons) + Math.max(...lons)) / 2 : null;
  const centreLat = lats.length ? (Math.min(...lats) + Math.max(...lats)) / 2 : null;

  const topCandidate = candidates.find((c) => c.rank === 1) ?? candidates[0];
  const topTier = topCandidate?.tier as string | undefined;

  let headline: string;
  if (detections.length === 0) {
    headline =
      'Satellite images of this area and time period did not show anything that looks like ' +
      'an oil spill.';
  } else if (candidates.length === 0) {
    headline =
      'Satellite images show what looks like an oil spill, but ship-tracking data could not ' +
      'point to any particular vessel as a possible source.';
  } else if (topTier === 'STRONG') {
    headline =
      'Satellite images show what looks like an oil spill, and one ship stands out as a ' +
      'strong lead worth investigating.';
  } else if (topTier === 'MODERATE') {
    headline =
      'Satellite images show what looks like an oil spill. A few ships are worth ' +
      'investigating further, though none of the evidence is conclusive on its own.';
  } else if (topTier === 'WEAK') {
    headline =
      'Satellite images show what looks like an oil spill, but the ships found nearby are ' +
      'only weak leads — there is not much evidence tying any one of them to it.';
  } else {
    headline =
      'Satellite images show what looks like an oil spill, but there is not enough ' +
      'information to say which, if any, nearby ship was responsible.';
  }

  const howThisWasFound =
    'A satellite that can see through cloud and darkness ' +
    'photographed the sea surface using radar. Oil smooths the water, so it shows up as an ' +
    'unusually dark patch, and the images were searched automatically for dark shapes that ' +
    'look like a spill rather than something else, such as a natural film or a patch of calm ' +
    'water. Weather data on wind and ocean currents was then used to work out where that ' +
    'patch most likely drifted from. Finally, real ship-tracking signals — the same system ' +
    'ships use to avoid collisions at sea — were checked for any vessel that was in the ' +
    'right place at the right time to have caused it.';

  const whatWasSeen =
    detections.length === 0
      ? 'No slick-like feature was found in the satellite imagery for this case.'
      : `The satellite imagery shows ${detections.length} dark patch${detections.length === 1 ? '' : 'es'} ` +
        `consistent with an oil slick, covering about ${formatKm2Plain(totalAreaKm2)} in total ` +
        `— roughly the area of ${pitches.toLocaleString('en-GB')} football pitch${pitches === 1 ? '' : 'es'}. ` +
        'This was found automatically by a computer program; every patch still needs a person ' +
        'to confirm it before it counts as a confirmed spill.';

  const whereAndWhen =
    centreLat !== null && centreLon !== null
      ? `The area searched is centred around ${Math.abs(centreLat).toFixed(1)}° ` +
        `${centreLat >= 0 ? 'North' : 'South'}, ${Math.abs(centreLon).toFixed(1)}° ` +
        `${centreLon >= 0 ? 'East' : 'West'}` +
        (windowStart && windowEnd
          ? `, during the period ${formatPlainDateTime(windowStart)} to ${formatPlainDateTime(windowEnd)}.`
          : '.') +
        ' See the full technical dossier for the exact shape of the area on a map.'
      : 'The exact area and time period searched are recorded in the full technical dossier.';

  let possibleOrigin: string;
  if (!origin) {
    possibleOrigin =
      'It was not possible to work out where or when the spill most likely started. This ' +
      'report only shows where the oil was SEEN by satellite, not where it came from.';
  } else if (origin.status === 'OK') {
    const rw = origin.releaseWindow as
      { mostLikelyStart?: string; mostLikelyEnd?: string } | undefined;
    possibleOrigin =
      rw?.mostLikelyStart && rw?.mostLikelyEnd
        ? 'Using real wind and ocean current data, the analysis worked backwards from where ' +
          'the oil was seen to estimate when it was most likely released: between ' +
          `${formatPlainDateTime(new Date(rw.mostLikelyStart))} and ` +
          `${formatPlainDateTime(new Date(rw.mostLikelyEnd))}.`
        : 'Using real wind and ocean current data, the analysis worked backwards from where ' +
          'the oil was seen to estimate a likely release area — see the technical dossier for ' +
          'the map.';
  } else if (origin.status === 'DEGRADED') {
    possibleOrigin =
      'A rough estimate of where the spill may have started was made, but the weather and ' +
      'current data available for this exact time and place was limited, so the estimate ' +
      'covers a wider area than usual and should be treated as approximate.';
  } else {
    possibleOrigin =
      'The available weather and current data was not good enough to trace the spill back ' +
      'to a likely release point or time.';
  }

  const vessels: PlainVesselSummary[] = candidates.slice(0, 5).map((c) => ({
    mmsi: Number(c.mmsi),
    rank: Number(c.rank),
    assessment:
      TIER_PLAIN[String(c.tier)] ??
      'This ship was assessed, but the analysis could not categorise the strength of the ' +
        'evidence for it.',
  }));

  const vesselsIntro =
    candidates.length === 0
      ? 'No ships could be checked against this spill, either because none were transmitting ' +
        'tracking signals nearby, or because no likely origin could be estimated to search ' +
        'around.'
      : `${candidates.length} ship${candidates.length === 1 ? ' was' : 's were'} close enough, ` +
        'at the right time, to be worth checking. They are listed from most to least likely, ' +
        'by how well the evidence fits — this is a list of leads for investigators to follow ' +
        'up, not an accusation.';

  // The same real conditions `buildUncertainty` checks, written for a reader with no
  // background rather than translated sentence-by-sentence from its output.
  const dontKnow: string[] = [];
  if (!origin || origin.status === 'DEGRADED' || origin.status === 'UNAVAILABLE') {
    dontKnow.push(
      'Where and when the spill was actually released is uncertain. That can only be worked ' +
        'out clearly when good wind and current data is available for that exact time and ' +
        'place, and here it was limited or missing.',
    );
  }
  if (cov && cov.distinctVessels < 5) {
    dontKnow.push(
      (cov.distinctVessels === 0
        ? 'No ships were broadcasting tracking signals in this area at the time.'
        : `Only ${cov.distinctVessels} ship${cov.distinctVessels === 1 ? ' was' : 's were'} ` +
          'broadcasting tracking signals in this area at the time.') +
        ' A ship with its tracking switched off, or simply out of range of a receiver, would ' +
        'not appear in this report at all — even if it was responsible.',
    );
  }
  const risky = detections.filter(
    (d) => ((d.confidence as { lookAlikeCompetition?: number })?.lookAlikeCompetition ?? 0) > 0.4,
  );
  if (risky.length > 0) {
    dontKnow.push(
      'Not every dark patch in a satellite image is oil. Calm patches of water, natural sea ' +
        `films and rain can look similar from space. ${risky.length} of the patch${risky.length === 1 ? '' : 'es'} ` +
        'found here has a real chance of being one of these look-alikes rather than genuine ' +
        'oil, and would need checking by a person — ideally against a photo or a sample.',
    );
  }
  if (candidates.length > 0) {
    dontKnow.push(
      'The ship rankings above are computed automatically from the evidence available, and ' +
        'this scoring method has not yet been checked against enough real, confirmed spills ' +
        'to know exactly how reliable it is. A ship near the top of the list means the ' +
        'evidence available fits it well — it is not the same as proof of guilt.',
    );
  }
  dontKnow.push(
    'This report is a starting point for an investigation, not a finished one. Anyone acting ' +
      'on it should confirm the findings independently before treating any ship named here ' +
      'as responsible for anything.',
  );

  const bottomLine =
    'In short: this report lists places, times and ships worth investigating further. It is ' +
    'not proof that a spill happened exactly as described, and it is not proof that any ship ' +
    'named in it is responsible. Every finding here should be checked by a person before it ' +
    'is acted on.';

  return {
    headline,
    howThisWasFound,
    whatWasSeen,
    whereAndWhen,
    possibleOrigin,
    vesselsIntro,
    vessels,
    whatWeDontKnow: dontKnow,
    bottomLine,
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
    plainSummary: buildPlainSummary(
      inv as unknown as { aoi?: unknown; windowStart?: unknown; windowEnd?: unknown },
      detections as unknown as Record<string, unknown>[],
      (origin as unknown as Record<string, unknown>) ?? null,
      cov,
      candidates as unknown as Record<string, unknown>[],
    ),
    provenanceAppendix: {
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
