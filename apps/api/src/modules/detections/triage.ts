import {
  TRIAGE_PRECOMPUTE,
  TRIAGE_PRIORITY_THRESHOLDS,
  TRIAGE_SCALES,
  TRIAGE_WEIGHTS,
  type TriagePriority,
} from '@varuna/shared';

/**
 * Detection triage — 07_AIML §9, 08_APP_FLOW §8.2.
 *
 * ## What this is, and the thing it deliberately is not
 *
 * This module ORDERS the review queue. It does not review anything. Nothing here writes
 * `reviewStatus`, and there is no code path from a triage score to CONFIRMED or REJECTED.
 *
 * The obvious feature to build instead was auto-confirmation: gate on
 * `confidence >= 0.75 && lookAlikeRisk < 0.20`, mark the winners AUTO_CONFIRMED, and let the
 * analyst arrive at a finished dossier. This system's own measurements say that gate does
 * not work:
 *
 *  - On the 66-scene held-out split the shipped detector fired on **68.2% of look-alike
 *    scenes** against a target of 20%.
 *  - On those false positives its own look-alike channel averaged **0.259** — so a large
 *    share of them sit BELOW a 0.20 auto-confirm gate and would pass straight through it.
 *  - `tuning.py` swept that exact gate (0.2-1.0) over 384 development scenes. The best
 *    configuration removed 8.5 points of false positives in development and transferred as
 *    **exactly zero** improvement on held-out data, while costing 0.028 oil IoU. Not adopted.
 *  - Across every configuration swept, mean risk on false positives stayed in the 0.15-0.29
 *    band. No parameter setting makes the warning channel informative about its own errors.
 *
 * The two gates are not even independent: `overall` confidence is
 * `0.40*model + 0.25*separation + 0.20*wind + 0.15*shape` where `shape = 1 - lookAlikeRisk`,
 * so the risk gate is already worth up to 0.15 of the confidence it would be checked against.
 * 07_AIML §9 records the same trap being found once before — an elongation gate stacked on
 * the risk gate moved the false-positive rate by exactly zero, because `look_alike_risk()`
 * already contains an elongation term.
 *
 * So the score below answers a question the measurements can actually support — **where is
 * an analyst's attention worth most?** — and the analyst still decides what the thing is.
 *
 * ## Why look-alike risk is absent from the score
 *
 * It is displayed, never weighted. A number measured to be uninformative about its own
 * errors cannot improve an ordering; including it would only add noise, and de-prioritising
 * on it would push real slicks down the queue for nothing. `caveats` carries it to the UI so
 * the analyst sees the detector's own warning without the ranking pretending to trust it.
 *
 * ## Why wind is absent
 *
 * `wind_suitability` is a genuinely informative physical term, but it is not available here:
 * the ingest chain calls `/detect`, which never invokes `detection_confidence()`, and
 * `ingest.ts` writes `windSuitability: 0.5` as a literal. Scoring against a constant would
 * be scoring against nothing. It is left out rather than faked.
 */

/** Bumped whenever the weights or scales change, so a stored score says which policy made it. */
export const TRIAGE_POLICY_VERSION = 'TRIAGE_V1';

export interface TriageInput {
  areaKm2: number;
  elongationRatio: number;
  /** dB below local sea background. Null when the detector did not report it. */
  contrastDb: number | null;
  /** Displayed as a caveat, never scored. See the note above. */
  lookAlikeRisk: number | null;
}

export interface TriageComponents {
  significance: number;
  interpretability: number;
  attributability: number;
}

export interface TriageAssessment {
  score: number;
  priority: TriagePriority;
  components: TriageComponents;
  inputs: { areaKm2: number; contrastDb: number | null; elongationRatio: number };
  reasons: string[];
  /** Statements that qualify the score without moving it. */
  caveats: string[];
  eligibleForPrecompute: boolean;
  policyVersion: string;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Area, log-scaled between the detector's minimum and a 10 km² saturation.
 *
 * Linear would be wrong: the step from 0.05 to 0.5 km² changes what a slick IS — a marginal
 * blob becomes a substantial one — while the step from 9 to 10 km² changes nothing about how
 * urgently a human should look at it.
 */
function significanceOf(areaKm2: number): number {
  const { areaFloorKm2, areaSaturationKm2 } = TRIAGE_SCALES;
  if (!(areaKm2 > 0)) return 0;
  return clamp01(Math.log1p(areaKm2 / areaFloorKm2) / Math.log1p(areaSaturationKm2 / areaFloorKm2));
}

/**
 * Contrast against the local sea background.
 *
 * This is the one term that is a direct physical measurement of the observation rather than a
 * model opinion about it, which is why it carries the second-largest weight. An unknown
 * contrast scores 0.5 — the same convention `wind_suitability` uses for an unknown wind, and
 * for the same reason: a missing measurement is not evidence of a good one.
 */
function interpretabilityOf(contrastDb: number | null): number {
  if (contrastDb === null || !Number.isFinite(contrastDb)) return 0.5;
  return clamp01(Math.abs(contrastDb) / TRIAGE_SCALES.contrastSaturationDb);
}

/**
 * Elongation, as a measure of whether correlation can do anything with this detection.
 *
 * Read narrowly. 07_AIML §9 established that elongation adds nothing as evidence of
 * oil-ness — it is already inside `look_alike_risk()`, and gating on both moved the
 * false-positive rate by exactly zero. It is used here for a different purpose: a linear
 * slick has an axis that can be matched against a vessel track, and a round one does not.
 * That is a statement about ANSWERABILITY, not about truth.
 */
function attributabilityOf(elongationRatio: number): number {
  if (!(elongationRatio > 0)) return 0;
  return clamp01(elongationRatio / TRIAGE_SCALES.elongationSaturation);
}

function priorityFor(score: number): TriagePriority {
  if (score >= TRIAGE_PRIORITY_THRESHOLDS.HIGH) return 'HIGH';
  if (score >= TRIAGE_PRIORITY_THRESHOLDS.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

export function assessTriage(input: TriageInput): TriageAssessment {
  const components: TriageComponents = {
    significance: significanceOf(input.areaKm2),
    interpretability: interpretabilityOf(input.contrastDb),
    attributability: attributabilityOf(input.elongationRatio),
  };

  const score = clamp01(
    components.significance * TRIAGE_WEIGHTS.significance +
      components.interpretability * TRIAGE_WEIGHTS.interpretability +
      components.attributability * TRIAGE_WEIGHTS.attributability,
  );

  const reasons = [
    `Extent ${input.areaKm2.toFixed(2)} km² (significance ${components.significance.toFixed(2)}).`,
    input.contrastDb === null
      ? 'Backscatter contrast was not reported, so interpretability is scored 0.50 (unknown), ' +
        'not assumed good.'
      : `${Math.abs(input.contrastDb).toFixed(1)} dB below local sea background ` +
        `(interpretability ${components.interpretability.toFixed(2)}).`,
    `Elongation ${input.elongationRatio.toFixed(2)} — ` +
      (components.attributability >= 0.5
        ? 'a linear form gives correlation an axis to match against a track'
        : 'a compact form gives correlation little to match against a track') +
      ` (attributability ${components.attributability.toFixed(2)}).`,
  ];

  const caveats: string[] = [];
  if (input.lookAlikeRisk !== null && Number.isFinite(input.lookAlikeRisk)) {
    caveats.push(
      `Detector look-alike risk ${input.lookAlikeRisk.toFixed(2)}. This does not affect the ` +
        'ranking: on held-out data the detector fired on 68.2% of look-alike scenes with a ' +
        'mean risk of 0.259 on its own false positives, so the channel is not informative ' +
        'about its own errors.',
    );
  }
  caveats.push(
    'Triage orders the queue only. This detection is UNREVIEWED and stays UNREVIEWED until ' +
      'an analyst decides what it is.',
  );

  return {
    score: Math.round(score * 1000) / 1000,
    priority: priorityFor(score),
    components,
    inputs: {
      areaKm2: input.areaKm2,
      contrastDb: input.contrastDb,
      elongationRatio: input.elongationRatio,
    },
    reasons,
    caveats,
    eligibleForPrecompute: score >= TRIAGE_PRECOMPUTE.minScore,
    policyVersion: TRIAGE_POLICY_VERSION,
  };
}

/**
 * Which detections in a scene get drift + correlation run before anyone asks.
 *
 * Ordered by score and capped, because a drift run is a 5,000-particle ensemble behind an
 * external OPeNDAP fetch. Spending it on every dark patch in a busy scene would delay the
 * detections an analyst is most likely to open first, which is the opposite of the point.
 *
 * Ties break on array order, which is the detector's own rank — stable, so re-ingesting a
 * scene selects the same detections rather than shuffling the queue.
 */
export function selectForPrecompute<T>(
  items: Array<{ id: T; triage: TriageAssessment }>,
  maxPerScene: number = TRIAGE_PRECOMPUTE.maxPerScene,
): T[] {
  return items
    .map((item, index) => ({ ...item, index }))
    .filter((item) => item.triage.eligibleForPrecompute)
    .sort((a, b) => b.triage.score - a.triage.score || a.index - b.index)
    .slice(0, Math.max(0, maxPerScene))
    .map((item) => item.id);
}
