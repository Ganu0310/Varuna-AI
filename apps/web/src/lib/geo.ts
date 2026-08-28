/**
 * Client-side geometry helpers — 05_FRONTEND §5.1 (`lib/geo.ts`).
 *
 * The authoritative area is computed server-side with GeographicLib and returned as
 * `aoiAreaKm2`. The value here is a spherical approximation used only for the live readout
 * while typing, so it is labelled as such and never persisted or reported as evidence
 * (02_TRD TR-3).
 */
export interface PolygonGeoJSON {
  type: 'Polygon';
  coordinates: number[][][];
}

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius

/** Spherical excess of a ring, in m². Approximation — see the file note. */
function ringAreaM2(ring: number[][]): number {
  if (ring.length < 4) return 0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i]!;
    const [lon2, lat2] = ring[i + 1]!;
    total += (toRad(lon2!) - toRad(lon1!)) * (2 + Math.sin(toRad(lat1!)) + Math.sin(toRad(lat2!)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

export function approxPolygonAreaKm2(polygon: PolygonGeoJSON): number {
  const [outer, ...holes] = polygon.coordinates;
  if (!outer) return 0;
  const area = ringAreaM2(outer) - holes.reduce((s, h) => s + ringAreaM2(h), 0);
  return area / 1e6;
}

export interface ParsedPolygon {
  polygon: PolygonGeoJSON | null;
  error: string | null;
}

/**
 * Parse pasted GeoJSON into a Polygon, with messages that say what is wrong and what to do
 * (04_UIUX §4.11). Accepts a bare geometry, a Feature, or a FeatureCollection of one.
 */
export function parsePolygon(text: string): ParsedPolygon {
  const trimmed = text.trim();
  if (!trimmed) return { polygon: null, error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { polygon: null, error: 'Not valid JSON.' };
  }

  const geometry = extractGeometry(parsed);
  if (!geometry) {
    return {
      polygon: null,
      error: 'Expected a GeoJSON Polygon, or a Feature/FeatureCollection containing one.',
    };
  }

  const rings = (geometry as PolygonGeoJSON).coordinates;
  if (!Array.isArray(rings) || rings.length === 0) {
    return { polygon: null, error: 'The polygon has no coordinate rings.' };
  }

  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) {
      return { polygon: null, error: 'Each ring needs at least four positions.' };
    }
    for (const pos of ring) {
      if (
        !Array.isArray(pos) ||
        pos.length < 2 ||
        typeof pos[0] !== 'number' ||
        typeof pos[1] !== 'number'
      ) {
        return { polygon: null, error: 'Every position must be a [longitude, latitude] pair.' };
      }
      if (pos[0] < -180 || pos[0] > 180 || pos[1] < -90 || pos[1] > 90) {
        return {
          polygon: null,
          error: `Position [${pos[0]}, ${pos[1]}] is out of range. Coordinate order is [longitude, latitude].`,
        };
      }
    }
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      return {
        polygon: null,
        error: 'Each ring must be closed — the last position repeats the first.',
      };
    }
  }

  return { polygon: { type: 'Polygon', coordinates: rings }, error: null };
}

function extractGeometry(value: unknown): PolygonGeoJSON | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;

  if (v.type === 'Polygon') return v as unknown as PolygonGeoJSON;
  if (v.type === 'Feature') return extractGeometry(v.geometry);
  if (v.type === 'FeatureCollection' && Array.isArray(v.features) && v.features.length > 0) {
    return extractGeometry(v.features[0]);
  }
  return null;
}
