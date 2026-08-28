import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from './connection.js';
import { bootstrapDatabase, verifyAisTimeSeries } from './bootstrap.js';

/**
 * Phase 1 DB verification — requires a REAL MongoDB (02_TRD §2.5.2).
 * These assertions cannot be made without a server: Mongoose can neither create a
 * time-series collection nor tell you how the server interprets a polygon.
 */
describe('bootstrapDatabase (real MongoDB)', () => {
  beforeAll(async () => {
    await connectMongo();
    await mongoose.connection.db!.dropDatabase();
    await bootstrapDatabase();
  });

  afterAll(async () => {
    await mongoose.connection.db!.dropDatabase();
    await disconnectMongo();
  });

  it('creates ais_positions as a TIME-SERIES collection with metaField "meta"', async () => {
    expect(await verifyAisTimeSeries()).toBe(true);

    const info = (await mongoose.connection
      .db!.listCollections({ name: 'ais_positions' })
      .toArray()) as Array<{
      options?: { timeseries?: { timeField: string; metaField: string; granularity: string } };
    }>;

    const ts = info[0]?.options?.timeseries;
    expect(ts).toBeDefined();
    expect(ts!.timeField).toBe('t');
    // metaField MUST be `meta` (containing mmsi) — every query is
    // "this vessel, this time range" or "this box, this time range" (02_TRD §2.5.2).
    expect(ts!.metaField).toBe('meta');
    expect(ts!.granularity).toBe('seconds');
  });

  it('creates the three ais_positions indexes required by the envelope query', async () => {
    const names = (await mongoose.connection.db!.collection('ais_positions').indexes()).map(
      (i) => i.name,
    );
    expect(names).toContain('meta.mmsi_1_t_1'); // "this vessel, this time range"
    expect(names).toContain('position_2dsphere'); // $geoWithin envelope
    expect(names).toContain('t_1');
  });

  it('creates the collections named in 02_TRD §2.5.1 (snake_case, not Mongoose plurals)', async () => {
    const names = (await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name);
    for (const expected of [
      'ais_positions',
      'satellite_scenes',
      'spill_detections',
      'vessel_tracks',
      'origin_estimates',
      'candidate_vessels',
      'provenance_records',
      'audit_log',
      'investigations',
      'jobs',
      'vessels',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('is idempotent — a second run does not throw or duplicate', async () => {
    await expect(bootstrapDatabase()).resolves.toBeUndefined();
    expect(await verifyAisTimeSeries()).toBe(true);
  });
});
