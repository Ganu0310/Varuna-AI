import type { LineString, Point, Polygon } from 'geojson';
import {
  ATTRIBUTION_FEATURES,
  MIN_MEASURED_FEATURES,
  TIER_THRESHOLDS,
  type AttributionFeatureKey,
  type Tier,
} from '@varuna/shared';
import { geodesicBearingDeg, geodesicDistanceKm } from '../../geo/geodesy.js';
import { trackToPolygonMinDistanceKm, trackIntersectsPolygon } from '../../geo/trackGeometry.js';

/**
 * The twelve-feature attribution model — 07_AIML §7.5 / §7.6, 02_TRD §2.8.5.
 *
 * This is the part of VARUNA that makes a claim about a vessel, so its design is governed
 * by one rule: **the system must never manufacture certainty it does not have.** Three
 * mechanisms enforce that:
 *
 *  1. A feature that cannot be measured is `MISSING`, never zero. Zero is a measurement
 *     meaning "no evidence in this dimension"; missing means "we could not look". Scoring a
 *     missing feature as zero would silently penalise a vessel for our own data gaps.
 *  2. Weights are renormalised over MEASURED features only, so a candidate scored on eight
 *     features is not compared unfairly against one scored on twelve.
 *  3. Below `MIN_MEASURED_FEATURES` the result is `INSUFFICIENT_EVIDENCE` **regardless of
 *     score**. A high number computed from three features is not a strong case, and the
 *     system says so rather than ranking it first.
 *
 * Every feature returns the raw measurement alongside the normalised value, so the UI can
 * show "3.2 km from the origin zone" rather than only "0.78".
 */

export type FeatureStatus = 'MEASURED' | 'MISSING' | 'NOT_APPLICABLE';

export interface EvidenceRef {
  kind: string;
  id: string;
  at?: string;
}

export interface FeatureResult {
  key: AttributionFeatureKey;
  rawValue: number | null;
  rawUnit: string;
  normalised: number | null;
  weight: number;
  contribution: number | null;
  status: FeatureStatus;
  evidenceRefs: EvidenceRef[];
  /** Plain-language statement of what was measured, for the evidence panel and the report. */
  explanation: string;
}

export interface AisFix {
  t: string;
  lon: number;
  lat: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  navStatus: number | null;
  draught: number | null;
}

export interface TrackGap {
  startAt: string;
  endAt: string;
  durationMin: number;
  fromLonLat: [number, number];
  toLonLat: [number, number];
}

export interface CandidateInput {
  mmsi: number;
  shipType: number | null;
  fixes: AisFix[];
  gaps: TrackGap[];
  trackLine: LineString | null;
  /** Prior confirmed incidents for this MMSI in our own records. */
  priorIncidents: number | null;
}

export interface ScoringContext {
  /** Probability-support polygon for the release location. */
  originZone: Polygon;
  originCentroid: Point;
  /** Release window: the interval during which the release plausibly happened. */
  releaseEarliest: string;
  releaseLatest: string;
  /** Detection long-axis bearing in degrees (0-180), used for axis continuity. */
  slickOrientationDeg: number | null;
  /** Major/minor axis ratio; below 2.5 the axis carries no directional information. */
  slickElongationRatio: number | null;
  /** WIDE means the window spans the whole horizon and cannot separate candidates. */
  releaseWindowStatus: 'OK' | 'WIDE';
  /** Set when the origin zone came from a degraded method — widens the honest uncertainty. */
  originDegraded: boolean;
}

const WEIGHTS = Object.fromEntries(
  ATTRIBUTION_FEATURES.map((f) => [f.key, f.defaultWeight]),
) as Record<AttributionFeatureKey, number>;

const UNITS = Object.fromEntries(ATTRIBUTION_FEATURES.map((f) => [f.key, f.unit])) as Record<
  AttributionFeatureKey,
  string
>;

/**
 * NOT_APPLICABLE is a THIRD state, distinct from MISSING.
 *
 *   MEASURED       we looked and got a value
 *   MISSING        we could not look (no data)
 *   NOT_APPLICABLE the question is meaningless here
 *
 * A round slick has no long axis, so "does the vessel's heading align with it?" has no
 * answer — not an unknown one. Both MISSING and NOT_APPLICABLE are excluded from the
 * renormalisation denominator, but they are shown differently, because "we lack the data"
 * and "this cannot apply" tell a reviewer different things about the case.
 */
function notApplicable(key: AttributionFeatureKey, why: string): FeatureResult {
  return {
    key,
    rawValue: null,
    rawUnit: UNITS[key],
    normalised: null,
    weight: WEIGHTS[key],
    contribution: null,
    status: 'NOT_APPLICABLE',
    evidenceRefs: [],
    explanation: why,
  };
}

function missing(key: AttributionFeatureKey, why: string): FeatureResult {
  return {
    key,
    rawValue: null,
    rawUnit: UNITS[key],
    normalised: null,
    weight: WEIGHTS[key],
    contribution: null,
    status: 'MISSING',
    evidenceRefs: [],
    explanation: why,
  };
}

function measured(
  key: AttributionFeatureKey,
  rawValue: number,
  normalised: number,
  explanation: string,
  evidenceRefs: EvidenceRef[] = [],
): FeatureResult {
  const n = Math.max(0, Math.min(1, normalised));
  return {
    key,
    rawValue,
    rawUnit: UNITS[key],
    normalised: n,
    weight: WEIGHTS[key],
    contribution: n * WEIGHTS[key],
    status: 'MEASURED',
    evidenceRefs,
    explanation,
  };
}

/** Monotonic decay: 1 at zero, 0.5 at `half`, asymptotic to 0. Gentler than a hard cut-off. */
const decay = (x: number, half: number) => 1 / (1 + x / half);

// ── individual features ───────────────────────────────────────────────

/** F1 · How close did the vessel come to the origin zone? */
function spatialProximity(c: CandidateInput, ctx: ScoringContext): FeatureResult {
  if (!c.trackLine || c.fixes.length === 0) {
    return missing('spatial_proximity', 'No reconstructed track for this vessel in the window.');
  }
  const km = trackToPolygonMinDistanceKm(c.trackLine, ctx.originZone) as number;
  return measured(
    'spatial_proximity',
    km,
    Math.exp(-km / 8), // 07_AIML 7.6: half-weight at ~5.5 km, near zero beyond ~25 km

    km === 0
      ? 'The vessel track passes through the origin zone.'
      : `Closest approach to the origin zone: ${km.toFixed(2)} km.`,
  );
}

/** F2 · Was the vessel there during the release window, not merely at some point? */
function temporalAlignment(c: CandidateInput, ctx: ScoringContext): FeatureResult {
  if (c.fixes.length === 0) {
    return missing('temporal_alignment', 'No AIS fixes for this vessel in the window.');
  }
  const start = Date.parse(ctx.releaseEarliest);
  const end = Date.parse(ctx.releaseLatest);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return missing('temporal_alignment', 'Release window could not be established.');
  }
  // A WIDE release window spans the whole back-tracking horizon, so "was the vessel present
  // during it?" is true of almost every vessel in the area and separates nothing. Scoring it
  // would hand every candidate the same 0.16 and dilute the features that do discriminate.
  if (ctx.releaseWindowStatus === 'WIDE') {
    return notApplicable(
      'temporal_alignment',
      'The release window is WIDE (drift too slow to date the slick), so presence within it ' +
        'does not distinguish between vessels.',
    );
  }

  const inWindow = c.fixes.filter((f) => {
    const t = Date.parse(f.t);
    return t >= start && t <= end;
  });
  const fraction = inWindow.length / c.fixes.length;

  return measured(
    'temporal_alignment',
    fraction,
    fraction,
    inWindow.length === 0
      ? 'The vessel has no AIS fixes inside the estimated release window.'
      : `${inWindow.length} of ${c.fixes.length} fixes fall inside the release window (${(fraction * 100).toFixed(0)}%).`,
    inWindow.slice(0, 3).map((f) => ({ kind: 'ais_fix', id: `${c.mmsi}@${f.t}`, at: f.t })),
  );
}

/** F3 · Did the track actually cross the origin zone, and how deep? */
function trackIntersection(c: CandidateInput, ctx: ScoringContext): FeatureResult {
  if (!c.trackLine) {
    return missing('track_intersection', 'No reconstructed track for this vessel.');
  }
  const crosses = trackIntersectsPolygon(c.trackLine, ctx.originZone);
  const km = crosses ? 0 : (trackToPolygonMinDistanceKm(c.trackLine, ctx.originZone) as number);
  return measured(
    'track_intersection',
    km,
    crosses ? 1 : decay(km, 3),
    crosses
      ? 'The track intersects the origin-zone polygon.'
      : `The track does not enter the origin zone; nearest edge ${km.toFixed(2)} km.`,
  );
}

/**
 * F4 · Does the vessel's heading line up with the slick's long axis?
 *
 * A vessel discharging under way leaves a slick drawn out ALONG its course. Compared as an
 * axis (mod 180°), because a slick has no direction of travel — only an orientation.
 */
function headingAlignment(c: CandidateInput, ctx: ScoringContext): FeatureResult {
  if (ctx.slickOrientationDeg === null) {
    return missing('heading_alignment', 'The detection has no measurable long axis.');
  }
  // A slick must be genuinely elongated for its axis to carry directional information.
  // Below ~2.5:1 the "long axis" of a near-round blob is essentially arbitrary, and
  // comparing a heading to it would manufacture agreement or disagreement from noise
  // (07_AIML 7.6).
  if (ctx.slickElongationRatio !== null && ctx.slickElongationRatio < 2.5) {
    return notApplicable(
      'heading_alignment',
      `The slick is not elongated enough (${ctx.slickElongationRatio.toFixed(2)}:1, below 2.5:1) ` +
        'for its long axis to indicate a direction, so heading alignment cannot be assessed.',
    );
  }
  const near = nearestFixes(c, ctx, 3);
  if (near.length < 2) {
    return missing(
      'heading_alignment',
      'Too few AIS fixes near the origin zone to derive a course.',
    );
  }

  const a = near[0]!;
  const b = near[near.length - 1]!;
  const courseDeg = a.cog ?? geodesicBearingDeg([a.lon, a.lat], [b.lon, b.lat]);

  let diff = Math.abs((courseDeg % 180) - ctx.slickOrientationDeg);
  if (diff > 90) diff = 180 - diff; // axis comparison

  // cos^2 of the angular difference (07_AIML 7.6): falls off smoothly and reaches zero at
  // 90 degrees, where a heading tells you nothing about an axis.
  const normalised = Math.cos((diff * Math.PI) / 180) ** 2;
  return measured(
    'heading_alignment',
    diff,
    normalised,
    `Vessel course ${courseDeg.toFixed(0)}° versus slick axis ${ctx.slickOrientationDeg.toFixed(0)}° — ${diff.toFixed(0)}° apart.`,
  );
}

/**
 * F5 · Did the vessel stop transmitting near the origin zone?
 *
 * A transmission gap over the origin zone is a well-documented signature of deliberate
 * discharge. It is NOT proof — receiver coverage gaps produce the same pattern — so it is
 * weighted alongside everything else, never treated as decisive.
 */
function aisDarkPeriod(c: CandidateInput, ctx: ScoringContext): FeatureResult {
  if (c.gaps.length === 0) {
    return measured(
      'ais_dark_period',
      0,
      0,
      'No AIS transmission gaps in the window — continuous coverage.',
    );
  }
  const start = Date.parse(ctx.releaseEarliest);
  const end = Date.parse(ctx.releaseLatest);
  const overlapping = c.gaps.filter(
    (g) => Date.parse(g.endAt) >= start && Date.parse(g.startAt) <= end,
  );
  if (overlapping.length === 0) {
    const longest = Math.max(...c.gaps.map((g) => g.durationMin));
    return measured(
      'ais_dark_period',
      0,
      0,
      `Gaps exist (longest ${longest.toFixed(0)} min) but none overlap the release window.`,
    );
  }
  const longest = Math.max(...overlapping.map((g) => g.durationMin));
  return measured(
    'ais_dark_period',
    longest,
    Math.min(1, longest / 120),
    `AIS silent for ${longest.toFixed(0)} min during the release window.`,
    overlapping
      .slice(0, 2)
      .map((g) => ({ kind: 'gap', id: `${c.mmsi}:${g.startAt}`, at: g.startAt })),
  );
}

/** F6 · Was the vessel moving at a speed consistent with discharge under way (~5-12 kn)? */
function speedConsistency(c: CandidateInput, ctx: ScoringContext): FeatureResult {
  const near = nearestFixes(c, ctx, 5).filter((f) => f.sog !== null);
  if (near.length === 0) {
    return missing('speed_consistency', 'No speed-over-ground values near the origin zone.');
  }
  const mean = near.reduce((s, f) => s + (f.sog ?? 0), 0) / near.length;
  // Discharge under way is typically slow-steaming; stationary or very fast is less consistent.
  const score = mean >= 4 && mean <= 14 ? 1 - Math.abs(mean - 9) / 10 : mean < 4 ? 0.3 : 0.2;
  return measured(
    'speed_consistency',
    mean,
    score,
    `Mean speed near the origin zone ${mean.toFixed(1)} kn.`,
  );
}

/**
 * F7 · Prior probability from vessel type.
 *
 * Tankers and cargo vessels carry the cargo and slops that produce operational discharge.
 * This is a weak prior and is weighted accordingly — it must never be the reason a vessel
 * ranks first, which is why it carries 0.07 and not more.
 */
function vesselTypePrior(c: CandidateInput): FeatureResult {
  if (c.shipType === null) {
    return missing('vessel_type_prior', 'AIS static data carries no vessel type for this MMSI.');
  }
  const t = c.shipType;
  let prior = 0.2;
  let label = 'other';
  if (t >= 80 && t <= 89) {
    prior = 1.0;
    label = 'tanker';
  } else if (t >= 70 && t <= 79) {
    prior = 0.7;
    label = 'cargo';
  } else if (t >= 60 && t <= 69) {
    prior = 0.3;
    label = 'passenger';
  } else if (t >= 30 && t <= 39) {
    prior = 0.35;
    label = 'fishing/tug';
  }
  return measured('vessel_type_prior', prior, prior, `AIS ship type ${t} (${label}).`);
}

/**
 * F6b · Vessel Type Risk (Gross Tonnage / Ship Class weighting).
 */
function vesselTypeRisk(c: CandidateInput): FeatureResult {
  if (c.shipType === null) {
    return measured(
      'vessel_type_risk',
      0.5,
      0.5,
      'Unclassified ship type — assigned neutral baseline risk 0.50.',
    );
  }
  const t = c.shipType;
  let risk = 0.5;
  let label = 'Unclassified / Other';
  if (t >= 80 && t <= 89) {
    risk = 1.0;
    label = 'Oil / Chemical Tanker (High Spill Risk)';
  } else if (t >= 70 && t <= 79) {
    risk = 0.7;
    label = 'Cargo / Bulk Carrier (Medium-High Spill Risk)';
  } else if ((t >= 30 && t <= 39) || (t >= 50 && t <= 59)) {
    risk = 0.35;
    label = 'Fishing / Tug / Workboat (Medium-Low Spill Risk)';
  } else if (t >= 60 && t <= 69) {
    risk = 0.3;
    label = 'Passenger / Cruise (Low Spill Risk)';
  }
  return measured('vessel_type_risk', risk, risk, `AIS Ship Type ${t} (${label}).`);
}

/**
 * F5b · AIS Dark Period Anomaly Score (> 30 min transponder silence in release window).
 */
function aisDarkPeriodAnomaly(c: CandidateInput, ctx: ScoringContext): FeatureResult {
  if (c.gaps.length === 0) {
    return measured(
      'ais_dark_period_anomaly',
      0,
      0,
      'Continuous AIS transponder transmission — zero dark period anomaly.',
    );
  }
  const start = Date.parse(ctx.releaseEarliest);
  const end = Date.parse(ctx.releaseLatest);
  const inWindowGaps = c.gaps.filter(
    (g) => Date.parse(g.endAt) >= start && Date.parse(g.startAt) <= end,
  );
  if (inWindowGaps.length === 0) {
    return measured(
      'ais_dark_period_anomaly',
      0,
      0,
      'No transponder gaps occurred during the release window.',
    );
  }
  const longest = Math.max(...inWindowGaps.map((g) => g.durationMin));
  const normalized = longest >= 30 ? Math.min(1.0, longest / 90) : longest / 60;
  return measured(
    'ais_dark_period_anomaly',
    longest,
    normalized,
    longest >= 30
      ? `Anomalous AIS transponder gap of ${longest.toFixed(0)} min detected inside release window.`
      : `Minor AIS gap of ${longest.toFixed(0)} min in release window (below 30 min threshold).`,
    inWindowGaps.map((g) => ({ kind: 'gap', id: `${c.mmsi}:${g.startAt}`, at: g.startAt })),
  );
}

/** F8 · How much origin-zone probability mass sits on the track? */
function originDensityAtTrack(c: CandidateInput, ctx: ScoringContext): FeatureResult {
  if (!c.trackLine) return missing('origin_density_at_track', 'No reconstructed track.');
  if (ctx.originDegraded) {
    return missing(
      'origin_density_at_track',
      'The origin estimate is degraded (no drift field), so it carries no probability density to sample.',
    );
  }
  const km = trackToPolygonMinDistanceKm(c.trackLine, ctx.originZone) as number;
  const density = decay(km, 2);
  return measured(
    'origin_density_at_track',
    density,
    density,
    `Normalised origin-probability density along the track: ${density.toFixed(2)}.`,
  );
}

/** F9 · A drop in reported draught can indicate discharged cargo or slops. */
function draughtChange(c: CandidateInput): FeatureResult {
  const withDraught = c.fixes.filter((f) => f.draught !== null && f.draught > 0);
  if (withDraught.length < 2) {
    return missing('draught_change', 'Fewer than two draught reports — no change can be measured.');
  }
  const first = withDraught[0]!.draught!;
  const last = withDraught[withDraught.length - 1]!.draught!;
  const drop = first - last;
  return measured(
    'draught_change',
    drop,
    drop <= 0 ? 0 : Math.min(1, drop / 1.0),
    drop <= 0
      ? `Reported draught did not decrease (${first.toFixed(1)} m to ${last.toFixed(1)} m).`
      : `Reported draught fell ${drop.toFixed(2)} m across the window.`,
  );
}

/** F10 · Does the slick's long axis follow the track, as a trailing discharge would? */
function slickAxisContinuity(c: CandidateInput, ctx: ScoringContext): FeatureResult {
  if (ctx.slickOrientationDeg === null) {
    return missing('slick_axis_continuity', 'The detection has no measurable long axis.');
  }
  const near = nearestFixes(c, ctx, 4);
  if (near.length < 2) {
    return missing('slick_axis_continuity', 'Too few fixes near the origin zone.');
  }
  const bearing = geodesicBearingDeg(
    [near[0]!.lon, near[0]!.lat],
    [near[near.length - 1]!.lon, near[near.length - 1]!.lat],
  );
  let diff = Math.abs((bearing % 180) - ctx.slickOrientationDeg);
  if (diff > 90) diff = 180 - diff;
  return measured(
    'slick_axis_continuity',
    1 - diff / 90,
    1 - diff / 90,
    `Track bearing near the zone is ${diff.toFixed(0)}° from the slick axis.`,
  );
}

/** F11 · Unusual manoeuvring (course changes / slowing) near the origin zone. */
function manoeuvreAnomaly(c: CandidateInput, ctx: ScoringContext): FeatureResult {
  const near = nearestFixes(c, ctx, 6).filter((f) => f.cog !== null);
  if (near.length < 3) {
    return missing('manoeuvre_anomaly', 'Too few course reports near the origin zone.');
  }
  let total = 0;
  for (let i = 1; i < near.length; i++) {
    let d = Math.abs(near[i]!.cog! - near[i - 1]!.cog!);
    if (d > 180) d = 360 - d;
    total += d;
  }
  const meanTurn = total / (near.length - 1);
  return measured(
    'manoeuvre_anomaly',
    meanTurn,
    Math.min(1, meanTurn / 45),
    `Mean course change between consecutive fixes near the zone: ${meanTurn.toFixed(0)}°.`,
  );
}

/** F12 · Prior confirmed incidents involving this MMSI, in our own records only. */
function priorIncidentHistory(c: CandidateInput): FeatureResult {
  if (c.priorIncidents === null) {
    return missing('prior_incident_history', 'No incident-history source is connected.');
  }
  return measured(
    'prior_incident_history',
    c.priorIncidents,
    Math.min(1, c.priorIncidents / 3),
    c.priorIncidents === 0
      ? 'No prior confirmed incidents for this MMSI in our records.'
      : `${c.priorIncidents} prior confirmed incident(s) for this MMSI.`,
  );
}

/** Fixes nearest the origin centroid, in time order — the local behaviour that matters. */
function nearestFixes(c: CandidateInput, ctx: ScoringContext, n: number): AisFix[] {
  const centre = ctx.originCentroid.coordinates as [number, number];
  return [...c.fixes]
    .map((f) => ({ f, d: geodesicDistanceKm([f.lon, f.lat], centre) as number }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.f)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

// ── scoring ───────────────────────────────────────────────────────────

export interface CandidateScore {
  mmsi: number;
  score: number;
  tier: Tier;
  features: FeatureResult[];
  measuredFeatureCount: number;
  /** Sum of the weights that were actually measurable — the renormalisation denominator. */
  measuredWeight: number;
  insufficientReason: string | null;
}

export function scoreCandidate(c: CandidateInput, ctx: ScoringContext): CandidateScore {
  const features: FeatureResult[] = [
    spatialProximity(c, ctx),
    temporalAlignment(c, ctx),
    trackIntersection(c, ctx),
    headingAlignment(c, ctx),
    aisDarkPeriod(c, ctx),
    vesselTypeRisk(c),
    aisDarkPeriodAnomaly(c, ctx),
    speedConsistency(c, ctx),
    vesselTypePrior(c),
    originDensityAtTrack(c, ctx),
    draughtChange(c),
    slickAxisContinuity(c, ctx),
    manoeuvreAnomaly(c, ctx),
    priorIncidentHistory(c),
  ];

  const measuredFeatures = features.filter((f) => f.status === 'MEASURED');
  const measuredWeight = measuredFeatures.reduce((s, f) => s + f.weight, 0);

  // Renormalise over measured weight only: a candidate scored on 8 features must not be
  // penalised against one scored on 12 (07_AIML §7.5.2).
  const score =
    measuredWeight > 0
      ? (100 * measuredFeatures.reduce((s, f) => s + (f.contribution ?? 0), 0)) / measuredWeight
      : 0;

  let tier: Tier;
  let insufficientReason: string | null = null;

  if (measuredFeatures.length < MIN_MEASURED_FEATURES) {
    // The floor is absolute: a high score from too little evidence is not a strong case.
    tier = 'INSUFFICIENT_EVIDENCE';
    insufficientReason =
      `Only ${measuredFeatures.length} of ${ATTRIBUTION_FEATURES.length} features could be measured ` +
      `(minimum ${MIN_MEASURED_FEATURES}). The score is withheld rather than ranked.`;
  } else if (score >= TIER_THRESHOLDS.STRONG) {
    tier = 'STRONG';
  } else if (score >= TIER_THRESHOLDS.MODERATE) {
    tier = 'MODERATE';
  } else if (score >= TIER_THRESHOLDS.WEAK) {
    tier = 'WEAK';
  } else {
    tier = 'INSUFFICIENT_EVIDENCE';
    insufficientReason = `Score ${score.toFixed(1)} is below the WEAK threshold of ${TIER_THRESHOLDS.WEAK}.`;
  }

  /*
   * A DEGRADED origin estimate cannot support a STRONG attribution.
   *
   * When there is no drift field, the origin zone is the slick footprint buffered by a
   * fixed radius. In any busy waterway that circle contains most passing traffic, so the
   * three spatial/temporal features saturate for nearly every candidate and the ranking
   * stops discriminating — every vessel looks strong. Capping the tier is not pessimism;
   * it is the accurate statement that proximity alone cannot distinguish a discharger from
   * a bystander (07_AIML 7.5.3, 02_TRD 2.8.3).
   */
  if (ctx.originDegraded && tier === 'STRONG') {
    tier = 'MODERATE';
    insufficientReason =
      'Capped at MODERATE: the origin estimate is degraded (no drift back-tracking), so ' +
      'spatial proximity cannot separate a discharging vessel from ordinary traffic.';
  }

  return {
    mmsi: c.mmsi,
    score: Math.round(score * 10) / 10,
    tier,
    features,
    measuredFeatureCount: measuredFeatures.length,
    measuredWeight: Math.round(measuredWeight * 1000) / 1000,
    insufficientReason,
  };
}

/** Score every candidate and rank. Ties break on measured-feature count — more evidence wins. */
export function rankCandidates(
  candidates: CandidateInput[],
  ctx: ScoringContext,
): CandidateScore[] {
  return candidates
    .map((c) => scoreCandidate(c, ctx))
    .sort((a, b) => b.score - a.score || b.measuredFeatureCount - a.measuredFeatureCount);
}
