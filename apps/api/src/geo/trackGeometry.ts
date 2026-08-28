import type { Feature, LineString, Point, Polygon } from 'geojson';
import {
  lineString as turfLineString,
  point as turfPoint,
  nearestPointOnLine,
  pointToLineDistance,
  booleanPointInPolygon,
  lineIntersect,
} from '@turf/turf';
import { km, type Kilometres } from '@varuna/shared';
import { geodesicDistanceKm, geodesicLengthKm } from './geodesy.js';

/**
 * Exact track-to-origin geometry. MongoDB has no `ST_Distance` to a polygon edge, no
 * `ST_ClosestPoint`, no geodesic `ST_Length` — using centroid distance instead overstates
 * proximity for a large slick and is a documented source of false attribution
 * (02_TRD §2.6.2, 12 F-09). These functions compute the correct answer; results are
 * persisted back into MongoDB as derived, indexed GeoJSON.
 */

/** Minimum distance from a track (LineString) to a point, in km (ellipsoidal). */
export function trackToPointMinDistanceKm(track: LineString, pt: Point): Kilometres {
  const snapped = nearestPointOnLine(
    track as Feature<LineString> | LineString,
    turfPoint(pt.coordinates),
  );
  return geodesicDistanceKm(
    pt.coordinates as [number, number],
    snapped.geometry.coordinates as [number, number],
  );
}

/**
 * Minimum distance from a track to a polygon's boundary, in km. Zero if the track enters
 * the polygon. Turf's `pointToLineDistance` gives the planar approximation used for the
 * coarse pass; the fine value is the ellipsoidal `trackToPointMinDistanceKm` against the
 * nearest boundary vertex/segment.
 */
export function trackToPolygonMinDistanceKm(track: LineString, polygon: Polygon): Kilometres {
  for (const c of track.coordinates) {
    if (booleanPointInPolygon(turfPoint(c), polygon as Feature<Polygon> | Polygon)) return km(0);
  }
  let min = Number.POSITIVE_INFINITY;
  for (const ring of polygon.coordinates) {
    const edge = turfLineString(ring);
    for (const c of track.coordinates) {
      const d = pointToLineDistance(turfPoint(c), edge, { units: 'kilometers' });
      if (d < min) min = d;
    }
  }
  return km(Number.isFinite(min) ? min : 0);
}

/** Geodesic length of the portion of a track that lies inside a polygon, in km. */
export function trackLengthInsidePolygonKm(track: LineString, polygon: Polygon): Kilometres {
  let total = 0;
  const c = track.coordinates;
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1]!;
    const b = c[i]!;
    const midIn = booleanPointInPolygon(
      turfPoint([(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2]),
      polygon as Feature<Polygon> | Polygon,
    );
    if (midIn) total += geodesicDistanceKm([a[0]!, a[1]!], [b[0]!, b[1]!]) as number;
  }
  return km(total);
}

/** Whether the track geometry intersects the polygon boundary at all. */
export function trackIntersectsPolygon(track: LineString, polygon: Polygon): boolean {
  if (track.coordinates.some((c) => booleanPointInPolygon(turfPoint(c), polygon as Polygon))) {
    return true;
  }
  for (const ring of polygon.coordinates) {
    const hits = lineIntersect(track as LineString, turfLineString(ring));
    if (hits.features.length > 0) return true;
  }
  return false;
}

export { geodesicLengthKm as trackLengthKm };
