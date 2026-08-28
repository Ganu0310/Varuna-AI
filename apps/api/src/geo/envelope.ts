import type { Feature, Polygon } from 'geojson';
import { buffer as turfBuffer, rewind as turfRewind } from '@turf/turf';
import type { Kilometres } from '@varuna/shared';

/**
 * Build the AIS search envelope. MongoDB cannot buffer a geometry (no `ST_Buffer`), so this
 * runs in Turf and the result is persisted back as an indexed GeoJSON document
 * (02_TRD §2.6.3, 06_BACKEND §6.6.2).
 *
 * The result is right-hand-rule wound. A wrongly-wound polygon is interpreted by MongoDB as
 * its COMPLEMENT — the whole globe minus the intended area — so a `$geoWithin` against it
 * matches nearly every AIS position on Earth (06_BACKEND §6.3.2, 12 F-10). `rewind` here and
 * the Mongoose winding validator on save are the two guards against that.
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
