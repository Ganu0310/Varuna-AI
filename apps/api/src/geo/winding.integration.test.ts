import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../db/connection.js';
import { rewindPolygon } from './envelope.js';
import type { Polygon } from 'geojson';

/**
 * POLYGON WINDING vs $geoWithin — the empirically established behaviour.
 *
 * 06_BACKEND §6.3.2 and 12 F-10 state that MongoDB interprets a wrongly-wound (clockwise)
 * polygon as its COMPLEMENT — the whole globe minus the intended area — so a `$geoWithin`
 * matches nearly every position on Earth.
 *
 * Measured on MongoDB 8.3.7 (2026-08-28), that is TRUE ONLY under the opt-in
 * `urn:x-mongodb:crs:strictwinding:EPSG:4326` CRS. With the DEFAULT CRS, MongoDB ignores
 * ring orientation for a single-ring query polygon and takes the smaller of the two
 * regions, so a clockwise polygon behaves identically to a counter-clockwise one.
 *
 * These tests pin BOTH behaviours so a future server-version change is caught, and they
 * document why the winding validator is still worth having:
 *   1. RFC 7946 §3.1.6 requires right-hand winding for GeoJSON interchange — our report
 *      exports are consumed by QGIS / Turf / Shapely, which DO care about orientation.
 *   2. Turf's own predicates and signed areas depend on winding.
 *   3. The moment anyone adds the strictwinding CRS (required for a genuine AOI larger
 *      than a hemisphere), the catastrophe becomes live — as the third test proves.
 *
 * See CONTEXT.md decision D-011.
 */
const COLL = 'winding_probe';

const INSIDE: [number, number] = [80.2, 13.1]; // Bay of Bengal, inside the box
const FAR_AWAY: [number, number] = [-20.0, 5.0]; // Atlantic off West Africa, far outside

const CCW_RIGHT_HAND: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [80.0, 13.0],
      [80.4, 13.0],
      [80.4, 13.4],
      [80.0, 13.4],
      [80.0, 13.0],
    ],
  ],
};

const CW_WRONGLY_WOUND: Polygon = {
  type: 'Polygon',
  coordinates: [[...CCW_RIGHT_HAND.coordinates[0]!].reverse()],
};

/** Opt-in CRS that makes MongoDB honour ring orientation literally. */
const STRICT_WINDING_CRS = {
  type: 'name',
  properties: { name: 'urn:x-mongodb:crs:strictwinding:EPSG:4326' },
};

describe('polygon winding vs $geoWithin (real MongoDB)', () => {
  beforeAll(async () => {
    await connectMongo();
    const db = mongoose.connection.db!;
    await db.collection(COLL).deleteMany({});
    await db.collection(COLL).insertMany([
      { name: 'inside', position: { type: 'Point', coordinates: INSIDE } },
      { name: 'far_away', position: { type: 'Point', coordinates: FAR_AWAY } },
    ]);
    await db.collection(COLL).createIndex({ position: '2dsphere' });
  });

  afterAll(async () => {
    await mongoose.connection
      .db!.collection(COLL)
      .drop()
      .catch(() => {});
    await disconnectMongo();
  });

  const within = async (geometry: object) =>
    mongoose.connection
      .db!.collection(COLL)
      .find({ position: { $geoWithin: { $geometry: geometry } } })
      .map((d) => d.name as string)
      .toArray();

  it('a correctly wound (CCW exterior) polygon matches only the point inside it', async () => {
    expect(await within(CCW_RIGHT_HAND)).toEqual(['inside']);
  });

  it('DEFAULT CRS: a clockwise polygon is NOT treated as the complement (smaller region wins)', async () => {
    // Contradicts the literal claim in 06_BACKEND §6.3.2 / 12 F-10 — see D-011.
    expect(await within(CW_WRONGLY_WOUND)).toEqual(['inside']);
  });

  it('STRICTWINDING CRS: a clockwise polygon DOES become the globe complement', async () => {
    // This is the real form of the catastrophe: the "search envelope" becomes the planet.
    const hits = await within({ ...CW_WRONGLY_WOUND, crs: STRICT_WINDING_CRS });
    expect(hits).toContain('far_away');
    expect(hits).not.toContain('inside');
  });

  it('STRICTWINDING CRS: a correctly wound polygon still matches only the inside point', async () => {
    const hits = await within({ ...CCW_RIGHT_HAND, crs: STRICT_WINDING_CRS });
    expect(hits).toEqual(['inside']);
  });

  it('rewindPolygon repairs a clockwise polygon so it is safe even under strictwinding', async () => {
    const repaired = rewindPolygon(CW_WRONGLY_WOUND);
    expect(await within({ ...repaired, crs: STRICT_WINDING_CRS })).toEqual(['inside']);
    expect(await within(repaired)).toEqual(['inside']);
  });

  it('the SERVER accepts either winding on insert — our Mongoose validator is the only RFC 7946 guard', async () => {
    const db = mongoose.connection.db!;
    const polys = db.collection('winding_polys');
    await polys.deleteMany({});
    await polys.createIndex({ geom: '2dsphere' });
    await expect(polys.insertOne({ geom: CCW_RIGHT_HAND })).resolves.toBeTruthy();
    await expect(polys.insertOne({ geom: CW_WRONGLY_WOUND })).resolves.toBeTruthy();
    await polys.drop().catch(() => {});
  });
});
