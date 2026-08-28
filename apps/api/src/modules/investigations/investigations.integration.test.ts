import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { connectMongo, disconnectMongo } from '../../db/connection.js';
import { UserModel, RefreshTokenModel } from '../auth/model.js';
import { InvestigationModel } from './model.js';

/**
 * Investigations end to end against a REAL MongoDB — 06_BACKEND §6.4.2.
 * Covers the AOI/window guards, ownership isolation, winding normalisation on write, and
 * the scope-change warning.
 */
const app = createApp();

const OWNER = { email: 'owner@varuna.test', password: 'correct-horse-battery', name: 'Owner' };
const OTHER = { email: 'other@varuna.test', password: 'correct-horse-battery', name: 'Other' };

const AOI_OK = {
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

const BASE = {
  name: 'Ennore approach — Jan 2017',
  aoi: AOI_OK,
  windowStart: '2017-01-25T00:00:00Z',
  windowEnd: '2017-02-05T00:00:00Z',
};

async function signedInAgent(creds: typeof OWNER) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/register').send(creds);
  return agent;
}

describe('investigations (real MongoDB)', () => {
  beforeAll(async () => {
    await connectMongo();
  });

  beforeEach(async () => {
    await InvestigationModel.deleteMany({});
    await UserModel.deleteMany({ email: { $in: [OWNER.email, OTHER.email] } });
    await RefreshTokenModel.deleteMany({});
  });

  afterAll(async () => {
    await InvestigationModel.deleteMany({});
    await UserModel.deleteMany({ email: { $in: [OWNER.email, OTHER.email] } });
    await RefreshTokenModel.deleteMany({});
    await disconnectMongo();
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/investigations')).status).toBe(401);
    expect((await request(app).post('/api/v1/investigations').send(BASE)).status).toBe(401);
  });

  it('creates an investigation with a geodesic AOI area and an audit entry', async () => {
    const agent = await signedInAgent(OWNER);
    const res = await agent.post('/api/v1/investigations').send(BASE);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(BASE.name);
    expect(res.body.status).toBe('DRAFT');
    // 0.4° × 0.4° near 13°N ≈ 1,920 km² — a real geodesic figure, not degrees.
    expect(res.body.aoiAreaKm2).toBeGreaterThan(1800);
    expect(res.body.aoiAreaKm2).toBeLessThan(2000);

    const audit = await agent.get(`/api/v1/investigations/${res.body._id}/audit`);
    expect(audit.status).toBe(200);
    expect(
      audit.body.items.some((i: { action: string }) => i.action === 'INVESTIGATION_CREATE'),
    ).toBe(true);
  });

  it('rejects an AOI over 50,000 km², naming the actual area', async () => {
    const agent = await signedInAgent(OWNER);
    const huge = {
      ...BASE,
      aoi: {
        type: 'Polygon',
        coordinates: [
          [
            [70, 5],
            [75, 5],
            [75, 10],
            [70, 10],
            [70, 5],
          ],
        ],
      },
    };
    const res = await agent.post('/api/v1/investigations').send(huge);
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/km²/);
    expect(res.body.detail).toMatch(/Reduce it by at least/);
    expect(await InvestigationModel.countDocuments()).toBe(0);
  });

  it('rejects a window longer than 30 days and an inverted window', async () => {
    const agent = await signedInAgent(OWNER);
    const tooLong = await agent
      .post('/api/v1/investigations')
      .send({ ...BASE, windowEnd: '2017-03-30T00:00:00Z' });
    expect(tooLong.status).toBe(400);

    const inverted = await agent
      .post('/api/v1/investigations')
      .send({ ...BASE, windowStart: '2017-02-05T00:00:00Z', windowEnd: '2017-01-25T00:00:00Z' });
    expect(inverted.status).toBe(400);
  });

  it('normalises polygon winding on write (D-011 — MongoDB will not do it for us)', async () => {
    const agent = await signedInAgent(OWNER);
    const cw = {
      ...BASE,
      aoi: { type: 'Polygon', coordinates: [[...AOI_OK.coordinates[0]!].reverse()] },
    };
    const res = await agent.post('/api/v1/investigations').send(cw);
    expect(res.status).toBe(201);

    // Stored ring must be counter-clockwise (RFC 7946 right-hand rule).
    const ring = res.body.aoi.coordinates[0] as number[][];
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      s += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
    }
    expect(s / 2).toBeGreaterThan(0);
  });

  it('isolates investigations between users — a stranger gets 404, not 403', async () => {
    const owner = await signedInAgent(OWNER);
    const created = await owner.post('/api/v1/investigations').send(BASE);
    const id = created.body._id;

    const stranger = await signedInAgent(OTHER);
    // 404 rather than 403: the API must not confirm the id exists (06_BACKEND §6.4.2).
    expect((await stranger.get(`/api/v1/investigations/${id}`)).status).toBe(404);
    expect((await stranger.get(`/api/v1/investigations/${id}/summary`)).status).toBe(404);

    const list = await stranger.get('/api/v1/investigations');
    expect(list.body.items).toHaveLength(0);
  });

  it('warns that changing the AOI or window invalidates downstream results', async () => {
    const agent = await signedInAgent(OWNER);
    const created = await agent.post('/api/v1/investigations').send(BASE);

    const renamed = await agent
      .patch(`/api/v1/investigations/${created.body._id}`)
      .send({ name: 'Renamed only' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.warning).toBeUndefined();

    const rescoped = await agent
      .patch(`/api/v1/investigations/${created.body._id}`)
      .send({ windowEnd: '2017-02-01T00:00:00Z' });
    expect(rescoped.status).toBe(200);
    expect(rescoped.body.warning.code).toBe('SCOPE_CHANGED');
    expect(rescoped.body.warning.message).toMatch(/no longer valid/);
  });

  it('summary reports real counts, not invented progress', async () => {
    const agent = await signedInAgent(OWNER);
    const created = await agent.post('/api/v1/investigations').send(BASE);
    const summary = await agent.get(`/api/v1/investigations/${created.body._id}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.counts).toEqual({ scenes: 0, detections: 0 });
    expect(summary.body.stages.SCENES).toBe('PENDING');
  });

  it('soft-deletes rather than destroying the audit trail', async () => {
    const agent = await signedInAgent(OWNER);
    const created = await agent.post('/api/v1/investigations').send(BASE);
    const id = created.body._id;

    expect((await agent.delete(`/api/v1/investigations/${id}`)).status).toBe(204);
    expect((await agent.get(`/api/v1/investigations/${id}`)).status).toBe(404);

    // The document still exists, flagged deleted.
    const raw = await InvestigationModel.findById(id).lean();
    expect(raw).toBeTruthy();
    expect(raw!.deletedAt).toBeInstanceOf(Date);
  });

  it('rejects a malformed id without touching the database', async () => {
    const agent = await signedInAgent(OWNER);
    expect((await agent.get('/api/v1/investigations/not-an-objectid')).status).toBe(400);
  });
});
