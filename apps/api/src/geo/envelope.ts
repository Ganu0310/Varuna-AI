import type { Feature, Polygon } from 'geojson';
import { buffer as turfBuffer, rewind as turfRewind } from '@turf/turf';
import type { Kilometres } from '@varuna/shared';

/**
 * Build the AIS search envelope. MongoDB cannot buffer a geometry (no `ST_Buffer`), so this
 * runs in Turf and the result is persisted back as an indexed GeoJSON document
 * (02_TRD §2.6.3, 06_BACKEND §6.6.2).
 *
 * The result is right-hand-rule wound. MongoDB 8 with the default CRS tolerates either
 * winding (it takes the smaller region), but under the `strictwinding` CRS a clockwise ring
 * becomes the globe complement, and RFC 7946 requires RHR for the GeoJSON we export.
 * `rewind` here and the Mongoose winding validator on save are the two guards.
 * Measured behaviour: geo/winding.integration.test.ts; rationale: CONTEXT.md D-011.
 */
export function buildSearchEnvelope(support: Polygon, radiusKm: Kilometres): Polygon {
  const buffered = turfBuffer(support as Feature<Polygon> | Polygon, radiusKm as number, {
    units: 'kilometers',
  });
  if (!buffered) throw new Error('turf.buffer returned nothing for the origin support polygon');
  const wound = turfRewind(buffered, { reverse: false });
  const geom = 'geometry' in wound ? wound.geometry : wound;
  if (geom.type !== 'Polygon') {
    throw new Error(`expected a Polygon envelope, got ${geom.type}`);
  }
  return geom;
}

/** Normalise any polygon to right-hand-rule winding before it is stored or queried. */
export function rewindPolygon(polygon: Polygon): Polygon {
  const wound = turfRewind(polygon, { reverse: false });
  return 'geometry' in wound ? (wound.geometry as Polygon) : (wound as Polygon);
}
