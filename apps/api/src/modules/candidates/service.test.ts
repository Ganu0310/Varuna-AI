import { describe, it, expect } from 'vitest';
import type { Polygon } from 'geojson';
import { envelopeFor, DEFAULT_WEIGHTS } from './service.js';

/**
 * The envelope radius encodes how much we trust the origin estimate: 15 km around a real
 * drift support, 40 km when the origin came from proximity alone. A degraded origin must
 * search WIDER, because it knows less about where the release was — narrowing the search on
 * a weak estimate would exclude the true vessel to make the list look decisive.
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

function areaDeg2(p: Polygon): number {
  const ring = p.coordinates[0]!;
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  }
  return Math.abs(s / 2);
}

describe('AIS search envelope', () => {
  it('is larger than the origin zone it wraps', () => {
    expect(areaDeg2(envelopeFor(ZONE, false))).toBeGreaterThan(areaDeg2(ZONE));
  });

  it('a DEGRADED origin searches wider than a real drift support', () => {
    const confident = envelopeFor(ZONE, false); // 15 km
    const degraded = envelopeFor(ZONE, true); // 40 km
    expect(areaDeg2(degraded)).toBeGreaterThan(areaDeg2(confident) * 2);
  });

  it('the envelope is right-hand wound so a $geoWithin cannot match the globe', () => {
    const ring = envelopeFor(ZONE, false).coordinates[0]!;
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      s += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
    }
    expect(s / 2).toBeGreaterThan(0);
  });
});

describe('default weight profile', () => {
  it('sums to 1.00 so scores are comparable between candidates', () => {
    const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 10);
  });

  it('weights the vessel-type prior low enough that it can never decide a ranking', () => {
    // A tanker must not out-rank a vessel with real spatial and temporal evidence purely
    // because it is a tanker.
    expect(DEFAULT_WEIGHTS.vessel_type_prior).toBeLessThan(DEFAULT_WEIGHTS.spatial_proximity);
    expect(DEFAULT_WEIGHTS.vessel_type_prior).toBeLessThan(DEFAULT_WEIGHTS.temporal_alignment);
    expect(DEFAULT_WEIGHTS.prior_incident_history).toBeLessThanOrEqual(0.01);
  });

  it('spatial and temporal evidence dominates', () => {
    const spatialTemporal =
      DEFAULT_WEIGHTS.spatial_proximity +
      DEFAULT_WEIGHTS.temporal_alignment +
      DEFAULT_WEIGHTS.track_intersection;
    expect(spatialTemporal).toBeGreaterThan(0.4);
  });
});
