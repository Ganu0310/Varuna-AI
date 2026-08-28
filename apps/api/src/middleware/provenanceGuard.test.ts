import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { provenanceGuard } from './provenanceGuard.js';

function appWith(payload: unknown) {
  const app = express();
  app.use(provenanceGuard);
  app.get('/x', (_req, res) => res.json(payload));
  return app;
}

const validProvenance = {
  sourceType: 'AIS_ARCHIVE',
  provider: 'Danish Maritime Authority',
  datasetId: 'aisdata',
  externalId: 'aisdk-2023-08-14.csv',
  retrievedAt: '2026-02-14T09:20:31Z',
  licence: 'Open data',
};

describe('provenanceGuard', () => {
  it('passes through objects with valid provenance and counts them', async () => {
    const res = await request(appWith({ items: [{ _id: '1', provenance: validProvenance }] })).get(
      '/x',
    );
    expect(res.status).toBe(200);
    expect(res.body.items[0].provenance.provider).toBe('Danish Maritime Authority');
    expect(res.headers['x-provenance-count']).toBe('1');
    expect(res.headers['x-provenance-stripped']).toBeUndefined();
  });

  it('strips an object whose provenance is incomplete, replacing it with a marker', async () => {
    const bad = { _id: 'abc', mmsi: 123456789, provenance: { provider: 'x' } };
    const res = await request(appWith({ items: [bad] })).get('/x');
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toEqual({ _id: 'abc', __provenanceMissing: true });
    expect(res.body.items[0].mmsi).toBeUndefined();
    expect(res.headers['x-provenance-stripped']).toBe('1');
  });

  it('leaves plain objects (no provenance key) untouched', async () => {
    const res = await request(appWith({ name: 'varuna-api', version: 'v1' })).get('/x');
    expect(res.body).toEqual({ name: 'varuna-api', version: 'v1' });
    expect(res.headers['x-provenance-count']).toBe('0');
  });

  it('handles nested arrays of mixed valid/invalid objects', async () => {
    const res = await request(
      appWith({
        detection: { _id: 'd1', provenance: validProvenance },
        tracks: [
          { _id: 't1', provenance: validProvenance },
          { _id: 't2', provenance: { sourceType: 'NONSENSE' } },
        ],
      }),
    ).get('/x');
    expect(res.body.tracks[0].provenance).toBeDefined();
    expect(res.body.tracks[1]).toEqual({ _id: 't2', __provenanceMissing: true });
    expect(res.headers['x-provenance-count']).toBe('2');
    expect(res.headers['x-provenance-stripped']).toBe('1');
  });
});

describe('the `provenance` key is RESERVED', () => {
  it('an object using `provenance` for something else is stripped — as it should be', async () => {
    // This bit the report module: it exposed an APPENDIX (records + lineageNote) under the
    // key `provenance`, and the guard correctly refused it as a malformed provenance record,
    // blanking the whole response. The guard is right; the field was misnamed. Anything that
    // is not a provenance record must use a different key (the report now uses
    // `provenanceAppendix`).
    const appendix = {
      _id: 'r1',
      uncertainty: { overall: 'a ranking of leads' },
      provenance: { records: [], lineageNote: 'not a provenance record' },
    };
    const res = await request(appWith(appendix)).get('/x');
    expect(res.body).toEqual({ _id: 'r1', __provenanceMissing: true });
    expect(res.headers['x-provenance-stripped']).toBe('1');
  });

  it('the same payload survives once the appendix is renamed', async () => {
    const renamed = {
      _id: 'r1',
      uncertainty: { overall: 'a ranking of leads' },
      provenanceAppendix: { records: [], lineageNote: 'not a provenance record' },
    };
    const res = await request(appWith(renamed)).get('/x');
    expect(res.body.provenanceAppendix.lineageNote).toBe('not a provenance record');
    expect(res.headers['x-provenance-stripped']).toBeUndefined();
  });
});
