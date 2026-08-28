// geographiclib-geodesic ships CommonJS: under real ESM a named import throws at runtime
// ("does not provide an export named 'Geodesic'"), even though the types permit it and
// bundler-based test runners paper over it. Import the default and destructure.
import geographiclib from 'geographiclib-geodesic';
import type { Feature, LineString, Point, Polygon, Position } from 'geojson';

const { Geodesic } = geographiclib;
import { area as turfArea } from '@turf/turf';
import { km, metres, sqKm, type Kilometres, type Metres, type SquareKm } from '@varuna/shared';

/**
 * Ellipsoidal geodesy on WGS84 via GeographicLib (Karney). `pyproj.Geod` in the Python
 * service uses the same algorithm — the known-answer suite (geodesy.test.ts) proves the two
 * stacks agree within 0.1% (02_TRD §2.6.4 / §2.15).
 *
 * Rules:
 *  - Distance / length / area here are ALWAYS ellipsoidal, never in degrees (02_TRD TR-3).
 *  - Every function takes and returns branded units. Bare `number` for a distance or area
 *    is rejected in review (05_FRONTEND §5.2, 02_TRD §2.6.4).
 *  - `$near` is never used against a polygon — that lint rule lives in eslint.config.mjs.
 */
const geod = Geodesic.WGS84;

/** Shortest ellipsoidal distance between two [lon, lat] points, in metres. */
export function geodesicDistanceM(
  a: readonly [number, number],
  b: readonly [number, number],
): Metres {
  const r = geod.Inverse(a[1], a[0], b[1], b[0]);
  return metres(r.s12 ?? 0);
}

export function geodesicDistanceKm(
  a: readonly [number, number],
  b: readonly [number, number],
): Kilometres {
  return km((geodesicDistanceM(a, b) as number) / 1000);
}

/** Initial bearing (degrees true, [0,360)) from `a` to `b`. */
export function geodesicBearingDeg(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const r = geod.Inverse(a[1], a[0], b[1], b[0]);
  return (((r.azi1 ?? 0) % 360) + 360) % 360;
}

/** Ellipsoidal area of a polygon (outer ring minus holes), in m². */
export function geodesicPolygonAreaM2Value(polygon: Polygon): number {
  let total = 0;
  polygon.coordinates.forEach((ring, i) => {
    const poly = geod.Polygon(false);
    for (const pos of ringWithoutClosingDuplicate(ring)) {
      poly.AddPoint(Number(pos[1]), Number(pos[0]));
    }
    const res = poly.Compute(false, true);
    const ringArea = Math.abs(res.area ?? 0);
    total += i === 0 ? ringArea : -ringArea;
  });
  return total;
}

export function geodesicPolygonAreaKm2(polygon: Polygon): SquareKm {
  return sqKm(geodesicPolygonAreaM2Value(polygon) / 1e6);
}

/** Geodesic length of a LineString, in km. */
export function geodesicLengthKm(line: LineString): Kilometres {
  let total = 0;
  const c = line.coordinates;
  for (let i = 1; i < c.length; i++) {
    const prev = c[i - 1];
    const cur = c[i];
    if (!prev || !cur) continue;
    total += geodesicDistanceM([prev[0]!, prev[1]!], [cur[0]!, cur[1]!]) as number;
  }
  return km(total / 1000);
}

function ringWithoutClosingDuplicate(ring: Position[]): Position[] {
  if (ring.length < 2) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  return first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

/**
 * Planar/spherical area via Turf — used ONLY where a fast approximate area is acceptable
 * (e.g. the AOI size guard). For anything that becomes evidence, use
 * `geodesicPolygonAreaKm2`.
 */
export function approxPolygonAreaKm2(polygon: Polygon | Feature<Polygon>): SquareKm {
  return sqKm(turfArea(polygon as Feature<Polygon>) / 1e6);
}

export type { Point, Polygon, LineString, Feature };
