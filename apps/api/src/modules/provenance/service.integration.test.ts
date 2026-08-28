import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../../db/connection.js';
import { recordProvenance, derivedProvenance } from './service.js';
import { ProvenanceRecordModel } from './model.js';
import { SatelliteSceneModel } from '../scenes/model.js';

/**
 * Provenance enforcement against a REAL MongoDB — 13_REAL_DATA_POLICY §13.4 L2.
 * Proves the guarantee survives an actual `save()`, not just in-memory validation.
 */
const realScene = {
  sourceType: 'SATELLITE_SCENE' as const,
  provider: 'Copernicus Data Space Ecosystem',
  datasetId: 'SENTINEL-1',
  externalId: 'S1A_IW_GRDH_1SDV_20170129T003132_20170129T003157_015039_01892E',
  retrievedAt: '2026-08-28T09:00:00Z',
  licence: 'Copernicus Sentinel Data 2017',
  derivedFrom: [],
};

const footprint = {
  type: 'Polygon' as const,
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

describe('provenance persistence (real MongoDB)', () => {
  beforeAll(async () => {
    await connectMongo();
    await ProvenanceRecordModel.deleteMany({}).catch(() => {});
    await SatelliteSceneModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.connection.db!.collection('provenance_records').deleteMany({});
    await SatelliteSceneModel.deleteMany({});
    await disconnectMongo();
  });

  it('recordProvenance writes an immutable record and de-duplicates on externalId', async () => {
    const id1 = await recordProvenance(realScene);
    const id2 = await recordProvenance(realScene);
    expect(id2).toBe(id1);
    expect(await ProvenanceRecordModel.countDocuments({ externalId: realScene.externalId })).toBe(
      1,
    );
  });

  it('provenance_records reject updates and deletes at the model layer', async () => {
    await expect(
      ProvenanceRecordModel.updateOne(
        { externalId: realScene.externalId },
        { provider: 'tampered' },
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      ProvenanceRecordModel.deleteOne({ externalId: realScene.externalId }),
    ).rejects.toThrow(/immutable/);
  });

  it('a scene WITH complete provenance saves', async () => {
    const doc = await SatelliteSceneModel.create({
      platform: 'SENTINEL-1A',
      sensor: 'SAR-C',
      productId: realScene.externalId,
      acquiredAt: new Date('2017-01-29T00:31:45Z'),
      footprint,
      crs: 'EPSG:32644',
      gsdMeters: 10,
      stacItem: { id: realScene.externalId },
      provenance: { ...realScene, retrievedAt: new Date(realScene.retrievedAt) },
    });
    expect(doc.productId).toBe(realScene.externalId);
  });

  it('a scene WITHOUT provenance is rejected before it reaches the database', async () => {
    await expect(
      SatelliteSceneModel.create({
        platform: 'SENTINEL-1A',
        sensor: 'SAR-C',
        productId: 'NO_PROVENANCE_SCENE',
        acquiredAt: new Date(),
        footprint,
        crs: 'EPSG:32644',
        gsdMeters: 10,
        stacItem: {},
      }),
    ).rejects.toThrow(/provenance is required/);

    expect(await SatelliteSceneModel.countDocuments({ productId: 'NO_PROVENANCE_SCENE' })).toBe(0);
  });

  // MongoDB itself accepts either winding (see D-011); this validator is the only thing
  // enforcing RFC 7946 §3.1.6 on what we store and export.
  it('a scene with a wrongly-wound footprint is rejected by our validator', async () => {
    const cw = {
      type: 'Polygon' as const,
      coordinates: [[...footprint.coordinates[0]!].reverse()],
    };
    await expect(
      SatelliteSceneModel.create({
        platform: 'SENTINEL-1A',
        sensor: 'SAR-C',
        productId: 'BAD_WINDING_SCENE',
        acquiredAt: new Date(),
        footprint: cw,
        crs: 'EPSG:32644',
        gsdMeters: 10,
        stacItem: {},
        provenance: { ...realScene, retrievedAt: new Date(realScene.retrievedAt) },
      }),
    ).rejects.toThrow(/right-hand rule/);
  });

  it('derivedProvenance carries the parent lineage', () => {
    const p = derivedProvenance('detection:1:mmsi:123456789', ['parentA', 'parentB']);
    expect(p.sourceType).toBe('DERIVED');
    expect(p.derivedFrom).toEqual(['parentA', 'parentB']);
    expect(p.licence).toBe('internal');
  });
});
