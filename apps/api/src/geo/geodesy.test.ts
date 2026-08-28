import { describe, it, expect } from 'vitest';
import { GEO_KNOWN_ANSWERS } from '@varuna/shared';
import {
  geodesicDistanceM,
  geodesicPolygonAreaM2Value,
  geodesicLengthKm,
  geodesicBearingDeg,
} from './geodesy.js';
import { buildSearchEnvelope, rewindPolygon } from './envelope.js';
import { km } from '@varuna/shared';
import type { LineString, Polygon } from 'geojson';

/**
 * Known-answer geodesy suite — 02_TRD §2.6.4 / §2.15, IMPLEMENTATION_PLAN §14.10.
 * Every case here is also asserted by services/ml/tests/test_geodesy_known_answers.py
 * against the SAME packages/shared/geo-known-answers.json. Both stacks use GeographicLib's
 * algorithm; passing the same references within these tolerances means they agree < 0.1%.
 * This file is a CI gate.
 */
describe('geodesic inverse (distance) — Node/GeographicLib', () => {
  for (const c of GEO_KNOWN_ANSWERS.geodesicInverse) {
    it(`${c.name}: ${c.expectedMetres} m ±${c.tolMetres}`, () => {
      const d = geodesicDistanceM(c.from, c.to) as number;
      expect(Math.abs(d - c.expectedMetres)).toBeLessThanOrEqual(c.tolMetres);
      // and within 0.1% relative
      expect(Math.abs(d - c.expectedMetres) / c.expectedMetres).toBeLessThan(0.001);
    });
  }
});

describe('geodesic polygon area — Node/GeographicLib', () => {
  for (const c of GEO_KNOWN_ANSWERS.polygonAreaGeodesic) {
    it(`${c.name}: ${c.expectedSquareMetres} m² ±${c.tolSquareMetres}`, () => {
      const poly: Polygon = { type: 'Polygon', coordinates: [c.ringLonLat as number[][]] };
      const a = geodesicPolygonAreaM2Value(poly);
      expect(Math.abs(a - c.expectedSquareMetres)).toBeLessThanOrEqual(c.tolSquareMetres);
      expect(Math.abs(a - c.expectedSquareMetres) / c.expectedSquareMetres).toBeLessThan(0.001);
    });
  }
});

describe('derived geodesy helpers', () => {
  it('length of a two-segment equatorial line equals the sum of its legs', () => {
    const line: LineString = {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    };
    const len = geodesicLengthKm(line) as number;
    // each 1° of longitude at the equator ≈ 111.3195 km
    expect(len).toBeCloseTo(2 * 111.3195, 1);
  });

  it('bearing due east along the equator is 90°', () => {
    expect(geodesicBearingDeg([0, 0], [1, 0])).toBeCloseTo(90, 5);
  });

  it('bearing due north is 0°', () => {
    expect(geodesicBearingDeg([0, 0], [0, 1])).toBeCloseTo(0, 5);
  });
});

describe('search envelope — winding guard (12 F-10)', () => {
  const support: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0.1, 0],
        [0.1, 0.1],
        [0, 0.1],
        [0, 0],
      ],
    ],
  };

  it('buffering the support polygon produces a right-hand-wound Polygon', () => {
    const env = buildSearchEnvelope(support, km(15));
    expect(env.type).toBe('Polygon');
    expect(signedArea(env.coordinates[0]!)).toBeGreaterThan(0); // CCW outer ring = RHR
  });

  it('a clockwise (wrongly wound) polygon is rewound to counter-clockwise', () => {
    const cw: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
      ],
    };
    expect(signedArea(cw.coordinates[0]!)).toBeLessThan(0); // starts CW
    const fixed = rewindPolygon(cw);
    expect(signedArea(fixed.coordinates[0]!)).toBeGreaterThan(0); // now CCW
  });
});

/** Shoelace signed area in degree-space — sign only, used to check winding. */
function signedArea(ring: number[][]): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    s += x1! * y2! - x2! * y1!;
  }
  return s / 2;
}
