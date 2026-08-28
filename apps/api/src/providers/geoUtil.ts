import type { Polygon } from 'geojson';
import { geodesicPolygonAreaM2Value } from '../geo/geodesy.js';

/**
 * Footprint helpers shared by the provider clients.
 * Overlap is measured on real geometry — a percentage the analyst reads off the catalogue
 * table must mean something (02_TRD TR-3).
 */
export function bboxOf(polygon: Polygon): [number, number, number, number] {
  let minX = 180;
  let minY = 90;
  let maxX = -180;
  let maxY = -90;
  for (const ring of polygon.coordinates) {
    for (const pos of ring) {
      const x = Number(pos[0]);
      const y = Number(pos[1]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

function bboxToPolygon(b: [number, number, number, number]): Polygon {
  const [w, s, e, n] = b;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

/**
 * Percentage of the AOI covered by the scene footprint.
 *
 * Computed on the bounding-box intersection and converted to a real area with the geodesic
 * routine, so the figure is an honest approximation rather than a degree-space ratio. Exact
 * polygon∩polygon area is a Shapely job on an equal-area projection and belongs in the ML
 * service (02_TRD §2.6.3) — this is the coarse catalogue-listing figure, and it is only
 * ever shown as a listing hint.
 */
export function aoiOverlapPct(aoi: Polygon, footprint: Polygon | null): number | null {
  if (!footprint) return null;

  const a = bboxOf(aoi);
  const f = bboxOf(footprint);

  const w = Math.max(a[0], f[0]);
  const s = Math.max(a[1], f[1]);
  const e = Math.min(a[2], f[2]);
  const n = Math.min(a[3], f[3]);
  if (e <= w || n <= s) return 0;

  const interArea = geodesicPolygonAreaM2Value(bboxToPolygon([w, s, e, n]));
  const aoiArea = geodesicPolygonAreaM2Value(bboxToPolygon(a));
  if (aoiArea <= 0) return null;

  return Math.min(100, Math.round((1000 * interArea) / aoiArea) / 10);
}
