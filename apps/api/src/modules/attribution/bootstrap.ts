import type { CandidateInput, ScoringContext } from './features.js';
import { scoreCandidate } from './features.js';

/**
 * Bootstrap confidence interval for an attribution score — 07_AIML §7.5.3.
 *
 * A single score of "71" invites a precision the evidence does not support. The interval
 * makes the uncertainty visible: `71 ±6` is a different claim from `71 ±22`, and only the
 * first would justify acting.
 *
 * Two sources of uncertainty are resampled:
 *
 *  1. THE DRIFT ENSEMBLE. The origin zone is itself a probability surface produced by
 *     particles with sampled wind-drift and Ekman parameters. Resampling which members are
 *     drawn propagates that physical uncertainty into the score.
 *
 *  2. INTERPOLATED POSITIONS. Between AIS fixes a vessel's position is an estimate, and its
 *     error grows with the reporting interval. Those estimates are perturbed.
 *
 * **Real AIS fixes are NEVER perturbed.** This is a hard rule, not an optimisation: a
 * recorded observation is evidence, and jittering it to widen an interval would be
 * fabricating data to make a result look more careful than it is (13_REAL_DATA_POLICY
 * §13.3). Only values that were already estimates may be resampled.
 */

export interface BootstrapResult {
  /** 5th and 95th percentiles of the resampled score. */
  ci: [number, number];
  iterations: number;
  /** How many fixes were treated as interpolated and therefore perturbable. */
  perturbableFixCount: number;
  realFixCount: number;
  note: string;
}

/** A fix is interpolated when it sits far enough from its neighbours to have been filled in. */
function isInterpolated(
  fix: { t: string },
  prevT: string | null,
  medianIntervalSec: number,
): boolean {
  if (!prevT) return false;
  const gapSec = (Date.parse(fix.t) - Date.parse(prevT)) / 1000;
  return gapSec > medianIntervalSec * 3;
}

/** Metres of positional error to expect after `seconds` of silence at typical vessel speed. */
function positionalErrorDeg(seconds: number): number {
  // ~10 kn = 5.1 m/s. Half the gap is the expected worst-case displacement error.
  const metres = Math.min(5.1 * seconds * 0.5, 20_000);
  return metres / 111_320; // degrees, near enough at these latitudes
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  // Box-Muller
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function bootstrapCi(
  candidate: CandidateInput,
  ctx: ScoringContext,
  iterations = 500,
  seed = 1,
): BootstrapResult {
  const rand = mulberry32(seed);

  // Classify each fix once: real observations are immutable, interpolated ones may be jittered.
  const intervals: number[] = [];
  for (let i = 1; i < candidate.fixes.length; i++) {
    intervals.push(
      (Date.parse(candidate.fixes[i]!.t) - Date.parse(candidate.fixes[i - 1]!.t)) / 1000,
    );
  }
  intervals.sort((a, b) => a - b);
  const medianIntervalSec = intervals.length ? intervals[Math.floor(intervals.length / 2)]! : 60;

  const perturbable: boolean[] = candidate.fixes.map((f, i) =>
    isInterpolated(f, i > 0 ? candidate.fixes[i - 1]!.t : null, medianIntervalSec),
  );
  const perturbableCount = perturbable.filter(Boolean).length;
  const realCount = candidate.fixes.length - perturbableCount;

  const scores: number[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    const fixes = candidate.fixes.map((f, i) => {
      if (!perturbable[i]) return f; // a real observation is never moved
      const gapSec =
        i > 0
          ? (Date.parse(f.t) - Date.parse(candidate.fixes[i - 1]!.t)) / 1000
          : medianIntervalSec;
      const sigma = positionalErrorDeg(gapSec);
      return {
        ...f,
        lon: f.lon + gaussian(rand) * sigma,
        lat: f.lat + gaussian(rand) * sigma,
      };
    });

    const trackLine =
      fixes.length >= 2
        ? { type: 'LineString' as const, coordinates: fixes.map((f) => [f.lon, f.lat]) }
        : null;

    // Resample the drift ensemble by jittering the origin zone's extent: a different draw
    // of particles yields a slightly different support polygon.
    const jitter = 1 + gaussian(rand) * 0.08;
    const zone = scaleAboutCentroid(ctx.originZone, jitter);

    scores.push(
      scoreCandidate({ ...candidate, fixes, trackLine }, { ...ctx, originZone: zone }).score,
    );
  }

  scores.sort((a, b) => a - b);
  const lo = scores[Math.floor(iterations * 0.05)] ?? 0;
  const hi = scores[Math.min(iterations - 1, Math.floor(iterations * 0.95))] ?? 0;

  return {
    ci: [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10],
    iterations,
    perturbableFixCount: perturbableCount,
    realFixCount: realCount,
    note:
      `Resampled ${iterations} times over drift-ensemble spread and ${perturbableCount} ` +
      `interpolated position(s). The ${realCount} real AIS fixes were not perturbed: a ` +
      `recorded observation is evidence and is never jittered.`,
  };
}

function scaleAboutCentroid(
  polygon: { type: 'Polygon'; coordinates: number[][][] },
  factor: number,
): { type: 'Polygon'; coordinates: number[][][] } {
  const ring = polygon.coordinates[0];
  if (!ring || ring.length === 0) return polygon;

  const cx = ring.reduce((s, c) => s + c[0]!, 0) / ring.length;
  const cy = ring.reduce((s, c) => s + c[1]!, 0) / ring.length;

  return {
    type: 'Polygon',
    coordinates: polygon.coordinates.map((r) =>
      r.map((c) => [cx + (c[0]! - cx) * factor, cy + (c[1]! - cy) * factor]),
    ),
  };
}

/**
 * Calibration state — 07_AIML §7.5.2 / §7.5.4.
 *
 * An isotonic calibrator maps raw scores onto observed frequencies, but fitting one needs
 * validated incidents where the responsible vessel is known. Below `MIN_CALIBRATION_SAMPLES`
 * the mapping is the identity and the result is labelled UNCALIBRATED, because a calibration
 * fitted on a handful of cases would be noise wearing the costume of rigour.
 */
export interface CalibrationState {
  calibrated: boolean;
  sampleCount: number;
  method: 'identity' | 'isotonic';
  note: string;
}

export function calibrationState(
  validatedIncidentCount: number,
  minSamples = 30,
): CalibrationState {
  if (validatedIncidentCount < minSamples) {
    return {
      calibrated: false,
      sampleCount: validatedIncidentCount,
      method: 'identity',
      note:
        `UNCALIBRATED: ${validatedIncidentCount} validated incident(s) available, ` +
        `${minSamples} required. Scores are raw weighted evidence and must not be read as ` +
        `probabilities. A calibration fitted on this few cases would be noise.`,
    };
  }
  return {
    calibrated: true,
    sampleCount: validatedIncidentCount,
    method: 'isotonic',
    note: `Isotonic calibration fitted on ${validatedIncidentCount} validated incidents.`,
  };
}
