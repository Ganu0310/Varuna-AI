import { describe, it, expect } from 'vitest';
import type { LineString, Polygon } from 'geojson';
import { bootstrapCi, calibrationState } from './bootstrap.js';
import { scoreCandidate } from './features.js';
import type { CandidateInput, ScoringContext } from './features.js';

/**
 * The bootstrap exists so a score is reported as `71 ±6` rather than `71`. The rule it must
 * never break: **real AIS fixes are not perturbed.** Jittering a recorded observation to
 * widen an interval would be fabricating data to look careful (13_REAL_DATA_POLICY §13.3).
 */
const ZONE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [144.6, 13.4],
      [144.7, 13.4],
      [144.7, 13.5],
      [144.6, 13.5],
      [144.6, 13.4],
    ],
  ],
};

const CTX: ScoringContext = {
  originZone: ZONE,
  originCentroid: { type: 'Point', coordinates: [144.65, 13.45] },
  releaseEarliest: '2025-09-21T14:00:00Z',
  releaseLatest: '2025-09-21T20:00:00Z',
  slickOrientationDeg: 45,
  slickElongationRatio: 3.0,
  releaseWindowStatus: 'OK',
  originDegraded: false,
};

/** `gapMinutes` between two of the fixes marks the later one as interpolated. */
function candidate(gapMinutes = 0): CandidateInput {
  const base = Date.parse('2025-09-21T15:00:00Z');
  const offsets = [
    0,
    5,
    10,
    15 + gapMinutes,
    20 + gapMinutes,
    25 + gapMinutes,
    30 + gapMinutes,
    35 + gapMinutes,
  ];
  const fixes = offsets.map((m, i) => ({
    t: new Date(base + m * 60_000).toISOString(),
    lon: 144.61 + i * 0.012,
    lat: 13.41 + i * 0.012,
    sog: 9,
    cog: 45,
    heading: 45,
    navStatus: 0,
    draught: 8,
  }));
  const line: LineString = { type: 'LineString', coordinates: fixes.map((f) => [f.lon, f.lat]) };
  return { mmsi: 1, shipType: 80, fixes, gaps: [], trackLine: line, priorIncidents: 0 };
}

describe('bootstrap confidence interval', () => {
  it('produces an ordered interval bracketing a plausible score', () => {
    const r = bootstrapCi(candidate(), CTX, 200, 42);
    expect(r.ci[0]).toBeLessThanOrEqual(r.ci[1]);
    expect(r.ci[0]).toBeGreaterThanOrEqual(0);
    expect(r.ci[1]).toBeLessThanOrEqual(100);
    expect(r.iterations).toBe(200);
  });

  it('is deterministic for a given seed, so a report can be reproduced', () => {
    const a = bootstrapCi(candidate(), CTX, 100, 7);
    const b = bootstrapCi(candidate(), CTX, 100, 7);
    expect(a.ci).toEqual(b.ci);
  });

  it('REAL fixes are never perturbed — evenly-sampled tracks have nothing perturbable', () => {
    const r = bootstrapCi(candidate(0), CTX, 100, 3);
    expect(r.perturbableFixCount).toBe(0);
    expect(r.realFixCount).toBe(8);
    expect(r.note).toMatch(/never jittered/i);
  });

  it('only positions after a long silence count as interpolated', () => {
    const r = bootstrapCi(candidate(120), CTX, 100, 3);
    expect(r.perturbableFixCount).toBeGreaterThan(0);
    expect(r.realFixCount).toBe(8 - r.perturbableFixCount);
  });

  it('a track with an interpolated stretch gets a WIDER interval than a fully-observed one', () => {
    const width = (c: CandidateInput) => {
      const r = bootstrapCi(c, CTX, 300, 11);
      return r.ci[1] - r.ci[0];
    };
    // More estimated positions means less certainty, and the interval must say so.
    expect(width(candidate(180))).toBeGreaterThanOrEqual(width(candidate(0)));
  });
});

describe('calibration state', () => {
  it('is UNCALIBRATED below 30 validated incidents and says why', () => {
    const s = calibrationState(4);
    expect(s.calibrated).toBe(false);
    expect(s.method).toBe('identity');
    // Scores must not be read as probabilities until there is evidence to map them onto.
    expect(s.note).toMatch(/must not be read as/i);
    expect(s.note).toMatch(/would be noise/i);
  });

  it('reports calibrated once enough validated incidents exist', () => {
    const s = calibrationState(40);
    expect(s.calibrated).toBe(true);
    expect(s.method).toBe('isotonic');
  });

  it('the boundary is inclusive at the minimum', () => {
    expect(calibrationState(29).calibrated).toBe(false);
    expect(calibrationState(30).calibrated).toBe(true);
  });
});

describe('boundary effects on the confidence interval', () => {
  /**
   * Discovered on the real Guam incident: the rank-1 candidate scored 80.6 with a percentile
   * interval of [72.0, 75.1] — the point estimate sat entirely outside its own CI, which in a
   * dossier is indefensible whatever the statistics behind it.
   *
   * The cause is a boundary, not an arithmetic slip. That candidate's `spatial_proximity`
   * measured 0 km and normalised to 1.0, and jitter can only move a vessel further from the
   * origin zone, never closer — so every resample scored lower than the estimate.
   */
  it('always reports an interval containing the point estimate', () => {
    // A long silence makes several fixes interpolated, so there is something to perturb.
    const c = candidate(120);
    const r = bootstrapCi(c, CTX, 200, 42);
    const point = scoreCandidate(c, CTX).score;

    expect(r.ci[0]).toBeLessThanOrEqual(point);
    expect(r.ci[1]).toBeGreaterThanOrEqual(point);
  });

  it('names the boundary effect rather than silently widening the interval', () => {
    const c = candidate(120);
    const r = bootstrapCi(c, CTX, 200, 42);
    const point = scoreCandidate(c, CTX).score;

    const outside = point < r.percentileCi[0] || point > r.percentileCi[1];
    if (outside) {
      expect(r.boundaryEffect).toMatch(/optimistic end of the range/);
      // The unwidened bounds must survive, or the adjustment stops being auditable.
      expect(r.percentileCi[0]).toBeLessThanOrEqual(r.percentileCi[1]);
      expect(r.ci).not.toEqual(r.percentileCi);
    } else {
      expect(r.boundaryEffect).toBeNull();
      expect(r.ci).toEqual(r.percentileCi);
    }
  });

  it('a fully-observed track has nothing to perturb, so the estimate sits inside', () => {
    const c = candidate(0);
    const r = bootstrapCi(c, CTX, 100, 3);
    const point = scoreCandidate(c, CTX).score;
    expect(point).toBeGreaterThanOrEqual(r.ci[0]);
    expect(point).toBeLessThanOrEqual(r.ci[1]);
  });
});
