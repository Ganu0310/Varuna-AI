import { describe, it, expect } from 'vitest';
import { Provenance, SOURCE_TYPES, hasValidProvenance } from './provenance.js';

describe('Provenance schema — 13_REAL_DATA_POLICY §13.4', () => {
  it('has no fabricated-data source type', () => {
    for (const forbidden of ['MOCK', 'SYNTHETIC', 'FAKE', 'DEMO', 'TEST', 'PLACEHOLDER']) {
      expect(SOURCE_TYPES).not.toContain(forbidden);
    }
  });

  it('accepts a complete real provenance record', () => {
    const record = {
      sourceType: 'SATELLITE_SCENE',
      provider: 'Copernicus Data Space Ecosystem',
      datasetId: 'SENTINEL-1',
      externalId: 'S1A_IW_GRDH_1SDV_20230814T061247_20230814T061312_049823_05FD31_A1B2',
      retrievedAt: '2026-02-14T09:20:31Z',
      licence: 'Copernicus Sentinel Data 2023',
    };
    const parsed = Provenance.parse(record);
    expect(parsed.derivedFrom).toEqual([]);
    expect(hasValidProvenance({ provenance: parsed })).toBe(true);
  });

  it('rejects a record missing externalId, provider or licence', () => {
    const base = {
      sourceType: 'AIS_ARCHIVE' as const,
      provider: 'Danish Maritime Authority',
      datasetId: 'aisdata',
      externalId: 'aisdk-2023-08-14.csv',
      retrievedAt: '2026-02-14T09:20:31Z',
      licence: 'Open data',
    };
    expect(Provenance.safeParse({ ...base, externalId: '' }).success).toBe(false);
    expect(Provenance.safeParse({ ...base, provider: '   ' }).success).toBe(false);
    expect(Provenance.safeParse({ ...base, licence: undefined }).success).toBe(false);
  });

  it('hasValidProvenance is false for an object without provenance', () => {
    expect(hasValidProvenance({ _id: 'x' })).toBe(false);
    expect(hasValidProvenance(null)).toBe(false);
  });
});
