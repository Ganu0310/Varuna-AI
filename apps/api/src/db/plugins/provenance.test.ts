import { describe, it, expect } from 'vitest';
import { Schema, model } from 'mongoose';
import { provenancePlugin } from './provenance.js';

/**
 * Validation and `pre('validate')` middleware run WITHOUT a database connection, so this
 * suite exercises the real structural guarantee behind 13_REAL_DATA_POLICY §13.4 L2.
 */
const TestSchema = new Schema({ name: String });
TestSchema.plugin(provenancePlugin);
const TestModel = model('ProvenancePluginTest', TestSchema);

const goodProvenance = {
  sourceType: 'SATELLITE_SCENE',
  provider: 'Copernicus Data Space Ecosystem',
  datasetId: 'SENTINEL-1',
  externalId: 'S1A_IW_GRDH_1SDV_20230814T061247_...',
  retrievedAt: new Date('2026-02-14T09:20:31Z'),
  licence: 'Copernicus Sentinel Data 2023',
};

describe('provenancePlugin', () => {
  it('accepts a document with complete provenance', async () => {
    const doc = new TestModel({ name: 'ok', provenance: goodProvenance });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('rejects a document with no provenance', async () => {
    const doc = new TestModel({ name: 'no-prov' });
    await expect(doc.validate()).rejects.toThrow(/provenance is required/);
  });

  it('rejects incomplete provenance (missing externalId)', async () => {
    const doc = new TestModel({
      name: 'partial',
      provenance: { ...goodProvenance, externalId: '   ' },
    });
    await expect(doc.validate()).rejects.toThrow(/provenance is incomplete/);
  });

  it('rejects a forbidden sourceType', async () => {
    const doc = new TestModel({
      name: 'fake',
      provenance: { ...goodProvenance, sourceType: 'MOCK' },
    });
    await expect(doc.validate()).rejects.toThrow(/not an allowed value|is not a valid enum/);
  });
});
