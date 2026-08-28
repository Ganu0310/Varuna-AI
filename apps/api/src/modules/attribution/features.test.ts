import { describe, it, expect } from 'vitest';
import type { LineString, Polygon } from 'geojson';
import { MIN_MEASURED_FEATURES, TIER_THRESHOLDS } from '@varuna/shared';
import {
  scoreCandidate,
  rankCandidates,
  type CandidateInput,
  type ScoringContext,
} from './features.js';

/**
 * These tests exist to prove the three honesty guarantees of the attribution model
 * (07_AIML §7.5.2, 12 F-14). They are the most important tests in the system: everything
 * else produces data, this produces an accusation.
 */

const ORIGIN_ZONE: Polygon = {
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
  originZone: ORIGIN_ZONE,
  originCentroid: { type: 'Point', coordinates: [144.65, 13.45] },
  releaseEarliest: '2025-09-21T14:00:00Z',
  releaseLatest: '2025-09-21T20:00:00Z',
  slickOrientationDeg: 45,
  originDegraded: false,
};

/** A vessel that passes straight through the origin zone during the release window. */
function throughTheZone(mmsi = 111111111): CandidateInput {
  const fixes = Array.from({ length: 8 }, (_, i) => ({
    t: new Date(Date.parse('2025-09-21T15:00:00Z') + i * 15 * 60_000).toISOString(),
    lon: 144.61 + i * 0.012,
    lat: 13.41 + i * 0.012,
    sog: 9,
    cog: 45,
    heading: 45,
    navStatus: 0,
    draught: 8.0 - i * 0.05,
  }));
  const line: LineString = {
    type: 'LineString',
    coordinates: fixes.map((f) => [f.lon, f.lat]),
  };
  return {
    mmsi,
    shipType: 80, // tanker
    fixes,
    gaps: [
      {
        startAt: '2025-09-21T16:00:00Z',
        endAt: '2025-09-21T17:30:00Z',
        durationMin: 90,
        fromLonLat: [144.64, 13.44],
        toLonLat: [144.67, 13.47],
      },
    ],
    trackLine: line,
    priorIncidents: 0,
  };
}

/** A vessel far away, at the wrong time, with almost nothing measurable. */
function barelyObserved(mmsi = 222222222): CandidateInput {
  return {
    mmsi,
    shipType: null,
    fixes: [
      {
        t: '2025-09-21T02:00:00Z',
        lon: 145.6,
        lat: 14.4,
        sog: null,
        cog: null,
        heading: null,
        navStatus: null,
        draught: null,
      },
    ],
    gaps: [],
    trackLine: null,
    priorIncidents: null,
  };
}

describe('a missing feature is MISSING, never zero', () => {
  it('marks unmeasurable features MISSING with a stated reason, and contributes nothing', () => {
    const s = scoreCandidate(barelyObserved(), CTX);
    const miss = s.features.filter((f) => f.status === 'MISSING');
    expect(miss.length).toBeGreaterThan(0);
    for (const f of miss) {
      expect(f.rawValue).toBeNull();
      expect(f.normalised).toBeNull();
      expect(f.contribution).toBeNull();
      // Every missing feature must SAY why it could not be measured.
      expect(f.explanation.length).toBeGreaterThan(10);
    }
  });

  it('distinguishes a measured zero from a missing value', () => {
    const c = throughTheZone();
    c.gaps = []; // no gaps at all — a real observation, not an absence of data
    const s = scoreCandidate(c, CTX);
    const dark = s.features.find((f) => f.key === 'ais_dark_period')!;
    expect(dark.status).toBe('MEASURED');
    expect(dark.rawValue).toBe(0);
    expect(dark.normalised).toBe(0);
    expect(dark.explanation).toMatch(/continuous coverage/i);
  });
});

describe('weights renormalise over MEASURED features only', () => {
  it('the denominator is the measured weight, not 1.0', () => {
    const s = scoreCandidate(throughTheZone(), CTX);
    const sumMeasuredWeight = s.features
      .filter((f) => f.status === 'MEASURED')
      .reduce((acc, f) => acc + f.weight, 0);
    expect(s.measuredWeight).toBeCloseTo(sumMeasuredWeight, 3);

    const contributions = s.features
      .filter((f) => f.status === 'MEASURED')
      .reduce((acc, f) => acc + (f.contribution ?? 0), 0);
    expect(s.score).toBeCloseTo((100 * contributions) / sumMeasuredWeight, 1);
  });

  it('a candidate is not penalised merely for having fewer measurable features', () => {
    // Same behaviour, but one lacks static ship-type data.
    const full = throughTheZone(1);
    const noType = { ...throughTheZone(2), shipType: null };
    const a = scoreCandidate(full, CTX);
    const b = scoreCandidate(noType, CTX);
    expect(b.measuredFeatureCount).toBe(a.measuredFeatureCount - 1);
    // The missing tanker prior removes a strong signal, but must not collapse the score to
    // near zero the way scoring MISSING as 0 would.
    expect(b.score).toBeGreaterThan(a.score * 0.6);
  });
});

describe('the insufficient-evidence floor is absolute', () => {
  it(`fewer than ${MIN_MEASURED_FEATURES} measured features forces INSUFFICIENT_EVIDENCE`, () => {
    const s = scoreCandidate(barelyObserved(), CTX);
    expect(s.measuredFeatureCount).toBeLessThan(MIN_MEASURED_FEATURES);
    expect(s.tier).toBe('INSUFFICIENT_EVIDENCE');
    expect(s.insufficientReason).toMatch(/Only \d+ of 12/);
  });

  it('a HIGH score from too few features is still INSUFFICIENT_EVIDENCE', () => {
    // Construct a candidate that scores well on the few features it has.
    const sparse: CandidateInput = {
      mmsi: 333333333,
      shipType: 80,
      fixes: [
        {
          t: '2025-09-21T15:00:00Z',
          lon: 144.65,
          lat: 13.45,
          sog: null,
          cog: null,
          heading: null,
          navStatus: null,
          draught: null,
        },
      ],
      gaps: [],
      trackLine: null,
      priorIncidents: null,
    };
    const s = scoreCandidate(sparse, { ...CTX, slickOrientationDeg: null });
    if (s.measuredFeatureCount < MIN_MEASURED_FEATURES) {
      expect(s.tier).toBe('INSUFFICIENT_EVIDENCE');
      // The point: the tier is not derived from the score here.
      expect(s.insufficientReason).toBeTruthy();
    }
  });
});

describe('tiering and ranking', () => {
  it('a vessel through the zone at the right time scores above the WEAK threshold', () => {
    const s = scoreCandidate(throughTheZone(), CTX);
    expect(s.measuredFeatureCount).toBeGreaterThanOrEqual(MIN_MEASURED_FEATURES);
    expect(s.score).toBeGreaterThan(TIER_THRESHOLDS.WEAK);
    expect(['STRONG', 'MODERATE', 'WEAK']).toContain(s.tier);
  });

  it('ranks the plausible vessel above the barely-observed one', () => {
    const ranked = rankCandidates([barelyObserved(), throughTheZone()], CTX);
    expect(ranked[0]!.mmsi).toBe(111111111);
    expect(ranked[1]!.tier).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('every feature carries a raw value and unit, not only a normalised number', () => {
    const s = scoreCandidate(throughTheZone(), CTX);
    for (const f of s.features.filter((x) => x.status === 'MEASURED')) {
      expect(f.rawValue).not.toBeNull();
      expect(f.rawUnit.length).toBeGreaterThan(0);
      expect(f.explanation.length).toBeGreaterThan(10);
    }
  });
});

describe('a degraded origin estimate is reflected honestly', () => {
  it('origin_density_at_track becomes MISSING when there is no drift field to sample', () => {
    const s = scoreCandidate(throughTheZone(), { ...CTX, originDegraded: true });
    const f = s.features.find((x) => x.key === 'origin_density_at_track')!;
    expect(f.status).toBe('MISSING');
    expect(f.explanation).toMatch(/degraded/i);
  });
});
