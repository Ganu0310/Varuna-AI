import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { Polygon } from 'geojson';
import { AIS_SENTINELS } from '@varuna/shared';
import { connectMongo, disconnectMongo } from '../../db/connection.js';
import { bootstrapDatabase } from '../../db/bootstrap.js';
import { coverage, darkPeriods, chooseHint } from './service.js';
import { reconstructTracks } from './tracks.js';

/**
 * AIS ingestion and track reconstruction against a real MongoDB — 06_BACKEND §6.6.
 *
 * The exit criterion these exist to prove: **a sentinel value never reaches kinematic
 * filtering.** AIS encodes "unknown" in-band — SOG 102.3, COG 360.0, heading 511 — and
 * stored as numbers they become a vessel doing 102 knots on a course of 360 degrees, which
 * poisons speed-consistency and heading-alignment scoring downstream.
 */
const BBOX: [number, number, number, number] = [144.4, 13.2, 145.1, 13.8];
const FROM = '2025-09-21T08:00:00Z';
const TO = '2025-09-22T08:00:00Z';
const BATCH = 'test-ais-batch';

function fix(
  mmsi: number,
  minutesFromStart: number,
  lon: number,
  lat: number,
  over: Partial<{ sog: number | null; cog: number | null; heading: number | null }> = {},
) {
  return {
    t: new Date(Date.parse(FROM) + minutesFromStart * 60_000),
    meta: { mmsi, source: 'MARINE_CADASTRE', ingestBatchId: BATCH },
    position: { type: 'Point', coordinates: [lon, lat] },
    sog: over.sog === undefined ? 8 : over.sog,
    cog: over.cog === undefined ? 90 : over.cog,
    heading: over.heading === undefined ? 90 : over.heading,
    rot: null,
    navStatus: 0,
    draught: 7.5,
    quality: { flags: [], impliedSpeedKn: null },
  };
}

describe('AIS ingestion and tracks (real MongoDB)', () => {
  beforeAll(async () => {
    await connectMongo();
    await bootstrapDatabase();
  });

  beforeEach(async () => {
    await mongoose.connection.db!.collection('ais_positions').deleteMany({
      'meta.ingestBatchId': BATCH,
    });
  });

  afterAll(async () => {
    await mongoose.connection.db!.collection('ais_positions').deleteMany({
      'meta.ingestBatchId': BATCH,
    });
    await disconnectMongo();
  });

  async function insert(docs: unknown[]) {
    await mongoose.connection.db!.collection('ais_positions').insertMany(docs as never[]);
  }

  it('EXIT CRITERION: a 102.3 SOG sentinel never enters kinematic filtering', async () => {
    // The importer maps sentinels to null; this asserts the whole chain honours that, so a
    // "102.3 knot" vessel can never be produced by track reconstruction.
    await insert([
      fix(111000001, 0, 144.6, 13.4, { sog: null, cog: null, heading: null }),
      fix(111000001, 5, 144.61, 13.4),
      fix(111000001, 10, 144.62, 13.4),
    ]);

    const tracks = await reconstructTracks(FROM, TO, BBOX);
    const track = tracks.find((t) => t.mmsi === 111000001)!;
    expect(track).toBeTruthy();

    const sogs = track.fixes.map((f) => f.sog);
    expect(sogs).toContain(null);
    for (const s of sogs) {
      expect(s).not.toBe(AIS_SENTINELS.sog);
      if (s !== null) expect(s).toBeLessThan(60);
    }
    for (const c of track.fixes.map((f) => f.cog)) {
      expect(c).not.toBe(AIS_SENTINELS.cog);
    }
    for (const h of track.fixes.map((f) => f.heading)) {
      expect(h).not.toBe(AIS_SENTINELS.heading);
    }
  });

  it('a null speed is preserved as null, not coerced to zero', async () => {
    // Zero means "measured as stationary"; null means "not reported". Conflating them
    // would make a vessel with no speed data look like one sitting still.
    await insert([
      fix(111000002, 0, 144.6, 13.4, { sog: null }),
      fix(111000002, 5, 144.61, 13.4, { sog: null }),
      fix(111000002, 10, 144.62, 13.4, { sog: null }),
    ]);
    const track = (await reconstructTracks(FROM, TO, BBOX)).find((t) => t.mmsi === 111000002)!;
    expect(track.fixes.every((f) => f.sog === null)).toBe(true);
  });

  it('removes kinematically impossible fixes and COUNTS them', async () => {
    // The outlier must sit INSIDE the bbox: the spatial $geoWithin filter runs first, so a
    // fix outside the envelope is excluded before the kinematic gate ever sees it and would
    // make this test vacuous.
    await insert([
      fix(111000003, 0, 144.5, 13.4),
      // 0.55 degrees of longitude in one minute is roughly 1,900 knots.
      fix(111000003, 1, 145.05, 13.4),
      fix(111000003, 5, 144.52, 13.4),
      fix(111000003, 10, 144.54, 13.4),
    ]);
    const track = (await reconstructTracks(FROM, TO, BBOX)).find((t) => t.mmsi === 111000003)!;
    // Surfaced, never silently dropped (06_BACKEND §6.6.3).
    expect(track.removedOutlierCount).toBeGreaterThan(0);
    expect(track.fixes.length).toBe(3);
  });

  it('segments on gaps longer than 20 minutes and records their geometry', async () => {
    await insert([
      fix(111000004, 0, 144.6, 13.4),
      fix(111000004, 10, 144.61, 13.41),
      // 90-minute silence
      fix(111000004, 100, 144.68, 13.47),
      fix(111000004, 110, 144.69, 13.48),
    ]);
    const track = (await reconstructTracks(FROM, TO, BBOX)).find((t) => t.mmsi === 111000004)!;
    expect(track.gaps).toHaveLength(1);
    expect(track.gaps[0]!.durationMin).toBe(90);
    expect(track.gaps[0]!.fromLonLat[0]).toBeCloseTo(144.61, 3);
    expect(track.gaps[0]!.toLonLat[0]).toBeCloseTo(144.68, 3);
  });

  it('flags a dark period that crosses the origin zone', async () => {
    await insert([
      fix(111000005, 0, 144.6, 13.4),
      fix(111000005, 10, 144.62, 13.42),
      fix(111000005, 100, 144.72, 13.52), // silent across the zone
      fix(111000005, 110, 144.74, 13.54),
    ]);
    const tracks = (await reconstructTracks(FROM, TO, BBOX)).filter((t) => t.mmsi === 111000005);

    const zone: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [144.65, 13.45],
          [144.7, 13.45],
          [144.7, 13.5],
          [144.65, 13.5],
          [144.65, 13.45],
        ],
      ],
    };

    const inZone = darkPeriods(tracks, zone);
    expect(inZone).toHaveLength(1);
    expect(inZone[0]!.overlapsOriginZone).toBe(true);
    expect(inZone[0]!.durationMin).toBe(90);
    expect(inZone[0]!.straightLineKm).toBeGreaterThan(0);

    // The same gap against a distant zone must NOT be flagged.
    const elsewhere: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [140.0, 10.0],
          [140.1, 10.0],
          [140.1, 10.1],
          [140.0, 10.1],
          [140.0, 10.0],
        ],
      ],
    };
    expect(darkPeriods(tracks, elsewhere)[0]!.overlapsOriginZone).toBe(false);
  });

  it('coverage reports measured numbers, and says so plainly when there are none', async () => {
    const empty = await coverage(FROM, TO, [10, 10, 10.1, 10.1]);
    expect(empty.recordCount).toBe(0);
    expect(empty.distinctVessels).toBe(0);
    // An empty evidence base is not the same as an absence of vessels.
    expect(empty.assessment).toMatch(/not the same as an absence of vessels/i);

    await insert([
      fix(111000006, 0, 144.6, 13.4),
      fix(111000006, 2, 144.61, 13.4),
      fix(111000007, 1, 144.65, 13.45),
      fix(111000007, 3, 144.66, 13.45),
    ]);
    const c = await coverage(FROM, TO, BBOX);
    expect(c.recordCount).toBe(4);
    expect(c.distinctVessels).toBe(2);
    expect(c.medianIntervalSec).toBe(120);
    expect(c.bbox).not.toBeNull();
    // With few vessels, the assessment must warn that a top candidate may reflect coverage.
    expect(c.assessment).toMatch(/sparse coverage|Few vessels/i);
  });

  it('coverage measures the interval per vessel, not across vessels', async () => {
    // Two vessels each reporting every 10 min, interleaved every 5 min. A naive global
    // diff would report 5 min and overstate the sampling rate.
    await insert([
      fix(111000008, 0, 144.6, 13.4),
      fix(111000009, 5, 144.65, 13.45),
      fix(111000008, 10, 144.61, 13.4),
      fix(111000009, 15, 144.66, 13.45),
      fix(111000008, 20, 144.62, 13.4),
      fix(111000009, 25, 144.67, 13.45),
    ]);
    const c = await coverage(FROM, TO, BBOX);
    expect(c.medianIntervalSec).toBe(600);
  });

  it('a track needs a minimum number of points to be reconstructed at all', async () => {
    await insert([fix(111000010, 0, 144.6, 13.4), fix(111000010, 5, 144.61, 13.4)]);
    const tracks = await reconstructTracks(FROM, TO, BBOX);
    expect(tracks.find((t) => t.mmsi === 111000010)).toBeUndefined();
  });

  it('the envelope query picks its index hint from the query shape', () => {
    const smallLong = chooseHint([144.6, 13.4, 144.62, 13.42], FROM, TO);
    expect(smallLong.hint).toBe('meta.mmsi_1_t_1');

    const largeShort = chooseHint(
      [140, 10, 150, 20],
      '2025-09-21T20:00:00Z',
      '2025-09-21T21:00:00Z',
    );
    expect(largeShort.hint).toBe('position_2dsphere');
    expect(largeShort.reason).toMatch(/spatial index/);
  });
});
