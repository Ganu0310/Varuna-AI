import { describe, it, expect } from 'vitest';
import {
  makeProjector,
  pointInRing,
  findIntersections,
  intersectionsByVessel,
} from './geometry.ts';

/**
 * The prism's whole claim is that a helix passing through the origin slab means a vessel was
 * in the plausible release area during the plausible release window. That claim is only worth
 * anything if the intersection test is exact, so these pin the ways it could quietly be wrong:
 * matching on place but not time, matching on time but not place, or counting an interpolated
 * position as an observation.
 */

const T0 = Date.parse('2025-09-21T00:00:00Z');
const H = 3_600_000;

// A square degree-ish box around the Guam AOI.
const RING = [
  [144.6, 13.4],
  [144.8, 13.4],
  [144.8, 13.5],
  [144.6, 13.5],
  [144.6, 13.4],
];

describe('local projection', () => {
  const p = makeProjector(
    { west: 144.55, south: 13.3, east: 144.95, north: 13.6 },
    T0,
    T0 + 24 * H,
  );

  it('puts the AOI centre at the origin', () => {
    const [x, y] = p.toLocal(144.75, 13.45);
    expect(Math.abs(x)).toBeLessThan(1);
    expect(Math.abs(y)).toBeLessThan(1);
  });

  it('is metric and east-positive', () => {
    // 0.1 degrees of longitude at 13.45N is ~10.8 km.
    const [x] = p.toLocal(144.85, 13.45);
    expect(x).toBeGreaterThan(10_000);
    expect(x).toBeLessThan(11_500);
  });

  it('shrinks longitude with latitude, as a projection must', () => {
    const equator = makeProjector({ west: -0.1, south: -0.1, east: 0.1, north: 0.1 }, T0, T0 + H);
    const high = makeProjector({ west: -0.1, south: 59.9, east: 0.1, north: 60.1 }, T0, T0 + H);
    // A degree of longitude at 60N is about half its length at the equator.
    const [xe] = equator.toLocal(0.1, 0);
    const [xh] = high.toLocal(0.1, 60);
    expect(xh / xe).toBeGreaterThan(0.45);
    expect(xh / xe).toBeLessThan(0.55);
  });

  it('maps the window start to the base and the end to the top', () => {
    expect(p.toZ(T0)).toBe(0);
    expect(p.toZ(T0 + 24 * H)).toBeCloseTo(30_000, 3);
    expect(p.toZ(T0 + 12 * H)).toBeCloseTo(15_000, 3);
  });

  it('reports the vertical scale, which the caption has to state', () => {
    expect(p.metresPerHour).toBeCloseTo(30_000 / 24, 6);
  });
});

describe('point in ring', () => {
  it('accepts an interior point and rejects an exterior one', () => {
    expect(pointInRing(144.7, 13.45, RING)).toBe(true);
    expect(pointInRing(144.9, 13.45, RING)).toBe(false);
    expect(pointInRing(144.7, 13.9, RING)).toBe(false);
  });
});

describe('intersections require BOTH place and time', () => {
  const inside = { lon: 144.7, lat: 13.45 };
  const outside = { lon: 144.95, lat: 13.45 };
  const release = [T0 + 4 * H, T0 + 8 * H] as const;

  const track = (mmsi: number, pts: Array<{ lon: number; lat: number; t: number }>) => ({
    mmsi,
    line: {
      type: 'LineString' as const,
      coordinates: pts.map((p) => [p.lon, p.lat]),
    },
    times: pts.map((p) => p.t),
  });

  it('finds a vessel that was in the area during the window', () => {
    const hits = findIntersections(
      [track(1, [{ ...inside, t: T0 + 6 * H }])],
      RING,
      release[0],
      release[1],
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.mmsi).toBe(1);
    expect(hits[0]!.windowFraction).toBeCloseTo(0.5, 6);
  });

  it('rejects the right place at the WRONG time', () => {
    // Ordinary traffic. The commonest false coincidence, and the one a flat map cannot rule
    // out — on a 2D plot this vessel's track is indistinguishable from the one above.
    const hits = findIntersections(
      [track(2, [{ ...inside, t: T0 + 20 * H }])],
      RING,
      release[0],
      release[1],
    );
    expect(hits).toHaveLength(0);
  });

  it('rejects the right time in the WRONG place', () => {
    const hits = findIntersections(
      [track(3, [{ ...outside, t: T0 + 6 * H }])],
      RING,
      release[0],
      release[1],
    );
    expect(hits).toHaveLength(0);
  });

  it('accepts a fix exactly on the window boundary', () => {
    // The release window is already an interval estimate; narrowing it further by excluding
    // its own endpoints would discard evidence for no reason.
    expect(
      findIntersections([track(4, [{ ...inside, t: release[0] }])], RING, release[0], release[1]),
    ).toHaveLength(1);
    expect(
      findIntersections([track(5, [{ ...inside, t: release[1] }])], RING, release[0], release[1]),
    ).toHaveLength(1);
  });

  it('returns nothing when there is no origin support', () => {
    // No back-tracking means no release area, so there is nothing for a track to intersect.
    // Falling back to "anywhere in the AOI" would turn every vessel into a coincidence.
    expect(
      findIntersections([track(6, [{ ...inside, t: T0 + 6 * H }])], null, release[0], release[1]),
    ).toHaveLength(0);
  });

  it('ignores a track whose times do not match its coordinates', () => {
    const bad = {
      mmsi: 7,
      line: {
        type: 'LineString' as const,
        coordinates: [
          [144.7, 13.45],
          [144.71, 13.45],
        ],
      },
      times: [T0 + 6 * H],
    };
    expect(findIntersections([bad], RING, release[0], release[1])).toHaveLength(0);
  });

  it('groups repeated hits by vessel', () => {
    const hits = findIntersections(
      [
        track(8, [
          { ...inside, t: T0 + 5 * H },
          { ...inside, t: T0 + 6 * H },
        ]),
        track(9, [{ ...inside, t: T0 + 7 * H }]),
      ],
      RING,
      release[0],
      release[1],
    );
    const grouped = intersectionsByVessel(hits);
    expect(grouped.get(8)).toHaveLength(2);
    expect(grouped.get(9)).toHaveLength(1);
  });
});
