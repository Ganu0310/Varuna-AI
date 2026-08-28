import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { Polygon } from 'geojson';
import { createApp } from '../../app.js';
import { connectMongo, disconnectMongo } from '../../db/connection.js';
import { UserModel, RefreshTokenModel } from '../auth/model.js';
import { InvestigationModel } from '../investigations/model.js';
import { SpillDetectionModel } from './model.js';

/**
 * Detection review against a real MongoDB — 06_BACKEND §6.4.5.
 *
 * The property under test throughout: **an analyst can correct a detection, but cannot
 * erase what the detector said.** This system's output can be used to accuse a vessel
 * operator, so "what did the algorithm actually produce, before a human adjusted it?" must
 * stay answerable — including to someone challenging the finding.
 */
const app = createApp();

const LEAD = { email: 'rev-lead@varuna.test', password: 'correct-horse-battery', name: 'Lead' };
const STRANGER = { email: 'rev-out@varuna.test', password: 'correct-horse-battery', name: 'Out' };

const AOI = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [144.55, 13.3],
      [144.95, 13.3],
      [144.95, 13.6],
      [144.55, 13.6],
      [144.55, 13.3],
    ],
  ],
};

const MODEL_GEOMETRY: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [144.66, 13.44],
      [144.68, 13.44],
      [144.68, 13.46],
      [144.66, 13.46],
      [144.66, 13.44],
    ],
  ],
};

const CORRECTED_GEOMETRY: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [144.66, 13.44],
      [144.7, 13.44],
      [144.7, 13.47],
      [144.66, 13.47],
      [144.66, 13.44],
    ],
  ],
};

async function agentFor(creds: typeof LEAD) {
  const a = request.agent(app);
  await a.post('/api/v1/auth/register').send(creds);
  return a;
}

async function seedDetection(investigationId: string): Promise<string> {
  const doc = await SpillDetectionModel.create({
    sceneId: new Types.ObjectId(),
    investigationId: new Types.ObjectId(investigationId),
    geometry: MODEL_GEOMETRY,
    areaKm2: 4.9,
    perimeterKm: 8.9,
    model: {
      name: 'classical-darkspot',
      version: '1.0.0',
      artefactSha256: 'ed1867ad',
      inputBands: ['VV'],
      tileSize: 0,
      overlap: 0,
    },
    confidence: {
      meanOilProbability: 0.61,
      minOilProbability: 0.61,
      maxOilProbability: 0.61,
      lookAlikeCompetition: 0.24,
      windSuitability: 0.5,
      overall: 0.61,
    },
    classCounts: { sea_surface: 0, oil_spill: 0, look_alike: 0, ship: 0, land: 0 },
    maskKey: 'scenes/test/vv.tif',
    probabilityKey: 'scenes/test/vv.tif',
    reviewStatus: 'UNREVIEWED',
    provenance: {
      sourceType: 'DERIVED',
      provider: 'VARUNA',
      datasetId: 'classical-darkspot@1.0.0',
      externalId: 'detect:test:0',
      retrievedAt: new Date(),
      licence: 'internal',
      derivedFrom: [],
    },
  });
  return String(doc._id);
}

describe('detection review (real MongoDB)', () => {
  let investigationId: string;
  let agent: request.Agent;

  beforeAll(async () => {
    await connectMongo();
  });

  beforeEach(async () => {
    await SpillDetectionModel.deleteMany({});
    await InvestigationModel.deleteMany({});
    await UserModel.deleteMany({ email: { $in: [LEAD.email, STRANGER.email] } });
    await RefreshTokenModel.deleteMany({});

    agent = await agentFor(LEAD);
    const inv = await agent.post('/api/v1/investigations').send({
      name: 'Review test',
      aoi: AOI,
      windowStart: '2025-09-21T00:00:00Z',
      windowEnd: '2025-09-22T00:00:00Z',
    });
    investigationId = inv.body._id;
  });

  afterAll(async () => {
    await SpillDetectionModel.deleteMany({});
    await InvestigationModel.deleteMany({});
    await UserModel.deleteMany({ email: { $in: [LEAD.email, STRANGER.email] } });
    await RefreshTokenModel.deleteMany({});
    await disconnectMongo();
  });

  it('a fresh detection is UNREVIEWED and has exactly one version — the model output', async () => {
    const id = await seedDetection(investigationId);
    const det = await agent.get(`/api/v1/detections/${id}`);
    expect(det.status).toBe(200);
    expect(det.body.reviewStatus).toBe('UNREVIEWED');

    const v = await agent.get(`/api/v1/detections/${id}/versions`);
    expect(v.body.items).toHaveLength(1);
    expect(v.body.items[0]).toMatchObject({
      version: 0,
      action: 'MODEL_OUTPUT',
      isModelOutput: true,
    });
  });

  it('CONFIRM records the actor and time without touching the geometry', async () => {
    const id = await seedDetection(investigationId);
    const before = (await agent.get(`/api/v1/detections/${id}`)).body.geometry;

    const r = await agent.post(`/api/v1/detections/${id}/review`).send({ action: 'CONFIRM' });
    expect(r.status).toBe(200);
    expect(r.body.reviewStatus).toBe('CONFIRMED');
    expect(r.body.geometryChanged).toBe(false);

    const after = (await agent.get(`/api/v1/detections/${id}`)).body;
    expect(after.geometry).toEqual(before);
    expect(after.reviewHistory).toHaveLength(1);
    expect(after.reviewHistory[0].userId).toBeTruthy();
    expect(after.reviewHistory[0].at).toBeTruthy();
  });

  it('REJECT requires a reason — an unexplained removal is refused', async () => {
    const id = await seedDetection(investigationId);

    const bare = await agent.post(`/api/v1/detections/${id}/review`).send({ action: 'REJECT' });
    expect(bare.status).toBe(422);
    expect(bare.body.detail).toMatch(/State why/);

    // The detection is untouched by the refused attempt.
    expect((await agent.get(`/api/v1/detections/${id}`)).body.reviewStatus).toBe('UNREVIEWED');

    const withReason = await agent
      .post(`/api/v1/detections/${id}/review`)
      .send({ action: 'REJECT', note: 'Wind shadow behind the headland, not oil.' });
    expect(withReason.status).toBe(200);
    expect(withReason.body.reviewStatus).toBe('REJECTED');
  });

  it('EDIT creates a NEW VERSION and the model output remains retrievable', async () => {
    const id = await seedDetection(investigationId);
    const original = (await agent.get(`/api/v1/detections/${id}`)).body;

    const edit = await agent
      .post(`/api/v1/detections/${id}/review`)
      .send({ action: 'EDIT', geometry: CORRECTED_GEOMETRY, note: 'Extended to the east.' });
    expect(edit.status).toBe(200);
    expect(edit.body.geometryChanged).toBe(true);

    // The current geometry is the analyst's correction, with a re-measured geodesic area.
    const current = (await agent.get(`/api/v1/detections/${id}`)).body;
    expect(current.geometry.coordinates).toEqual(CORRECTED_GEOMETRY.coordinates);
    expect(current.areaKm2).toBeGreaterThan(original.areaKm2);
    expect(current.reviewStatus).toBe('EDITED');

    // THE POINT: version 0 still holds exactly what the detector produced.
    const versions = (await agent.get(`/api/v1/detections/${id}/versions`)).body;
    expect(versions.items).toHaveLength(2);
    const v0 = versions.items[0];
    expect(v0.isModelOutput).toBe(true);
    expect((v0.geometry as Polygon).coordinates).toEqual(MODEL_GEOMETRY.coordinates);
    expect(versions.note).toMatch(/never overwrite/i);
  });

  it('area is re-measured geodesically from the corrected outline, not carried over', async () => {
    const id = await seedDetection(investigationId);
    await agent
      .post(`/api/v1/detections/${id}/review`)
      .send({ action: 'EDIT', geometry: CORRECTED_GEOMETRY });

    const current = (await agent.get(`/api/v1/detections/${id}`)).body;
    // 0.04° x 0.03° near 13.4°N ≈ 14.4 km²; the seeded value was 4.9.
    expect(current.areaKm2).toBeGreaterThan(13);
    expect(current.areaKm2).toBeLessThan(16);
  });

  it('successive reviews accumulate versions in order', async () => {
    const id = await seedDetection(investigationId);
    await agent.post(`/api/v1/detections/${id}/review`).send({ action: 'CONFIRM' });
    await agent
      .post(`/api/v1/detections/${id}/review`)
      .send({ action: 'EDIT', geometry: CORRECTED_GEOMETRY });
    await agent
      .post(`/api/v1/detections/${id}/review`)
      .send({ action: 'REJECT', note: 'Superseded by a better acquisition.' });

    const versions = (await agent.get(`/api/v1/detections/${id}/versions`)).body.items;
    expect(versions.map((v: { action: string }) => v.action)).toEqual([
      'MODEL_OUTPUT',
      'CONFIRM',
      'EDIT',
      'REJECT',
    ]);
    // Still recoverable after three actions.
    expect((versions[0].geometry as Polygon).coordinates).toEqual(MODEL_GEOMETRY.coordinates);
  });

  it('geometry endpoint honours ETag and simplifies for display only', async () => {
    const id = await seedDetection(investigationId);

    const first = await agent.get(`/api/v1/detections/${id}/geometry`);
    expect(first.status).toBe(200);
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    const cached = await agent.get(`/api/v1/detections/${id}/geometry`).set('If-None-Match', etag);
    expect(cached.status).toBe(304);

    const simplified = await agent.get(`/api/v1/detections/${id}/geometry?simplify=z8`);
    expect(simplified.status).toBe(200);
    expect(simplified.body.simplifiedForZoom).toBe(8);
    // Simplification must not change the measured area.
    expect(simplified.body.areaKm2).toBe(first.body.areaKm2);
    expect(simplified.body.areaNote).toMatch(/full-resolution/);
  });

  it('a stranger cannot see or review the detection', async () => {
    const id = await seedDetection(investigationId);
    const stranger = await agentFor(STRANGER);

    expect((await stranger.get(`/api/v1/detections/${id}`)).status).toBe(404);
    expect((await stranger.get(`/api/v1/detections/${id}/versions`)).status).toBe(404);
    const attempt = await stranger
      .post(`/api/v1/detections/${id}/review`)
      .send({ action: 'CONFIRM' });
    expect(attempt.status).toBe(404);

    // Unchanged by the failed attempt.
    expect((await agent.get(`/api/v1/detections/${id}`)).body.reviewStatus).toBe('UNREVIEWED');
  });

  it('exposes a tile template pointing at the same raster the analysis used', async () => {
    const id = await seedDetection(investigationId);
    const t = await agent.get(`/api/v1/detections/${id}/tiles`);
    expect(t.status).toBe(200);
    expect(t.body.tileUrlTemplate).toContain('/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png');
    // The key is percent-encoded inside the query string, as it must be.
    expect(decodeURIComponent(t.body.tileUrlTemplate)).toContain('scenes/test/vv.tif');
    expect(t.body.source).toMatchObject({ key: 'scenes/test/vv.tif' });
    expect(t.body.note).toMatch(/analysis used the same pixels/);
  });
});
