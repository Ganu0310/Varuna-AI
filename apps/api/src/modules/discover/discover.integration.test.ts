import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../app.js';
import { connectMongo, disconnectMongo } from '../../db/connection.js';
import { UserModel, RefreshTokenModel } from '../auth/model.js';
import { InvestigationModel } from '../investigations/model.js';
import { SatelliteSceneModel } from '../scenes/model.js';
import { SpillDetectionModel } from '../detections/model.js';
import { SweepStateModel, SweepOverpassModel } from '../sweep/model.js';

/**
 * Discover end to end against a REAL MongoDB — 06_BACKEND §6.4.10.
 *
 * Covers the two guarantees the design rests on: a sweep container never appears as an
 * ordinary investigation, and adopting a detection moves the SCENE (and every sibling
 * detection on it) rather than only the one clicked.
 */
const app = createApp();

const ANALYST = {
  email: 'discover-analyst@varuna.test',
  password: 'correct-horse-battery',
  name: 'A',
};

const REGION_AOI = {
  type: 'Polygon',
  coordinates: [
    [
      [34.6, 35.1],
      [35.1, 35.1],
      [35.1, 35.8],
      [34.6, 35.8],
      [34.6, 35.1],
    ],
  ],
};

async function signedInAgent() {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/register').send(ANALYST);
  return agent;
}

/** A minimal but schema-valid SatelliteScene + two SpillDetections under a sweep container —
 * the shape `sweepRegionTick`'s real ingest call would eventually produce, written directly
 * so this test does not need a live provider or the ML service. */
async function seedSweptScene(containerInvestigationId: Types.ObjectId, acquiredAt: Date) {
  const scene = await SatelliteSceneModel.create({
    investigationId: containerInvestigationId,
    platform: 'S1A',
    sensor: 'SAR-C',
    productId: `S1A_IW_GRDH_1SDV_${acquiredAt.toISOString().replace(/[-:]/g, '').slice(0, 15)}_test`,
    acquiredAt,
    footprint: REGION_AOI,
    crs: 'EPSG:4326',
    gsdMeters: 10,
    stacItem: { collection: 'sentinel-1-rtc', id: 'test' },
    status: 'READY',
    provenance: {
      sourceType: 'SATELLITE_SCENE',
      provider: 'PLANETARY_COMPUTER',
      datasetId: 'sentinel-1-rtc',
      externalId: 'test-item',
      retrievedAt: new Date(),
      licence: 'CC-BY-4.0',
    },
  });

  const detectionFixture = (rank: number) => ({
    sceneId: scene._id,
    investigationId: containerInvestigationId,
    geometry: REGION_AOI,
    areaKm2: 1.2,
    model: { name: 'classical-darkspot', version: '1.0.0', artefactSha256: 'test-sha' },
    maskKey: 'test-mask',
    probabilityKey: 'test-prob',
    provenance: {
      sourceType: 'DERIVED',
      provider: 'VARUNA',
      datasetId: 'classical-darkspot@1.0.0',
      externalId: `detect:test:${rank}`,
      retrievedAt: new Date(),
      licence: 'internal',
    },
  });

  const detections = await SpillDetectionModel.create([detectionFixture(1), detectionFixture(2)]);
  return { scene, detections };
}

describe('discover (real MongoDB)', () => {
  beforeAll(async () => {
    await connectMongo();
  });

  beforeEach(async () => {
    await InvestigationModel.deleteMany({});
    await SatelliteSceneModel.deleteMany({});
    await SpillDetectionModel.deleteMany({});
    await SweepStateModel.deleteMany({});
    await SweepOverpassModel.deleteMany({});
    await UserModel.deleteMany({ email: ANALYST.email });
    await RefreshTokenModel.deleteMany({});
  });

  afterAll(async () => {
    await disconnectMongo();
  });

  it('a sweep container never appears in the ordinary investigations list', async () => {
    const agent = await signedInAgent();
    const container = await InvestigationModel.create({
      name: 'Discover watch — test region',
      incidentReference: 'sweep:test-region',
      aoi: REGION_AOI,
      aoiAreaKm2: 100,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 30 * 86_400_000),
      status: 'DRAFT',
      kind: 'SWEEP_CONTAINER',
      createdBy: new Types.ObjectId(),
      members: [],
    });

    const list = await agent.get('/api/v1/investigations');
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { _id: string }) => i._id)).not.toContain(String(container._id));
  });

  it('lists a swept detection in its window, tagged with the right region', async () => {
    const agent = await signedInAgent();
    const container = await InvestigationModel.create({
      name: 'Discover watch — test region',
      aoi: REGION_AOI,
      aoiAreaKm2: 100,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 30 * 86_400_000),
      status: 'DRAFT',
      kind: 'SWEEP_CONTAINER',
      createdBy: new Types.ObjectId(),
      members: [],
    });
    await SweepStateModel.create({
      regionId: 'baniyas-syria',
      containerInvestigationId: container._id,
    });

    const acquiredAt = new Date('2024-06-01T12:00:00Z');
    const { detections } = await seedSweptScene(container._id, acquiredAt);

    const res = await agent
      .get('/api/v1/discover/detections')
      .query({ from: '2024-05-01T00:00:00Z', to: '2024-07-01T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((d: { regionId: string }) => d.regionId === 'baniyas-syria')).toBe(
      true,
    );
    expect(res.body.items.map((d: { _id: string }) => d._id).sort()).toEqual(
      detections.map((d) => String(d._id)).sort(),
    );
  });

  it('excludes a swept scene outside the requested window', async () => {
    const agent = await signedInAgent();
    const container = await InvestigationModel.create({
      name: 'Discover watch — test region',
      aoi: REGION_AOI,
      aoiAreaKm2: 100,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 30 * 86_400_000),
      status: 'DRAFT',
      kind: 'SWEEP_CONTAINER',
      createdBy: new Types.ObjectId(),
      members: [],
    });
    await SweepStateModel.create({
      regionId: 'baniyas-syria',
      containerInvestigationId: container._id,
    });
    await seedSweptScene(container._id, new Date('2020-01-01T00:00:00Z'));

    const res = await agent
      .get('/api/v1/discover/detections')
      .query({ from: '2024-05-01T00:00:00Z', to: '2024-07-01T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('adopting a detection creates a real investigation and moves the WHOLE scene', async () => {
    const agent = await signedInAgent();
    const container = await InvestigationModel.create({
      name: 'Discover watch — test region',
      aoi: REGION_AOI,
      aoiAreaKm2: 100,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 30 * 86_400_000),
      status: 'DRAFT',
      kind: 'SWEEP_CONTAINER',
      createdBy: new Types.ObjectId(),
      members: [],
    });
    await SweepStateModel.create({
      regionId: 'baniyas-syria',
      containerInvestigationId: container._id,
    });
    const { scene, detections } = await seedSweptScene(
      container._id,
      new Date('2024-06-01T12:00:00Z'),
    );

    const res = await agent
      .post(`/api/v1/discover/detections/${detections[0]!._id}/adopt`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.adoptedDetectionCount).toBe(2); // BOTH detections on the scene, not just one

    const newInvestigationId = res.body.investigationId as string;

    // The new investigation is a real, ordinary case.
    const opened = await agent.get(`/api/v1/investigations/${newInvestigationId}`);
    expect(opened.status).toBe(200);

    // The scene and both detections now belong to it, not the container.
    const movedScene = await SatelliteSceneModel.findById(scene._id).lean();
    expect(String(movedScene!.investigationId)).toBe(newInvestigationId);
    const movedDetections = await SpillDetectionModel.find({ sceneId: scene._id }).lean();
    expect(movedDetections.every((d) => String(d.investigationId) === newInvestigationId)).toBe(
      true,
    );

    // It STILL shows up under Discover, now marked as adopted.
    //
    // Discover selects by geography, so a detection does not stop being in Baniyas because it
    // changed owner - and hiding it would be the wrong answer anyway: the finding is real and
    // the region is still worth looking at. What must change is the offer. `adopted` carries
    // the investigation it now belongs to, so the page links to that case instead of offering
    // to create a second one from the same scene.
    const afterAdopt = await agent
      .get('/api/v1/discover/detections')
      .query({ from: '2024-05-01T00:00:00Z', to: '2024-07-01T00:00:00Z' });
    expect(afterAdopt.body.items).toHaveLength(2);
    for (const item of afterAdopt.body.items) {
      expect(item.adopted).toBe(true);
      expect(item.investigationId).toBe(newInvestigationId);
    }
  });

  it("does not leak another analyst's findings just because they fall in a watch region", async () => {
    const stranger = new Types.ObjectId();
    const theirCase = await InvestigationModel.create({
      name: "Someone else's case in Baniyas",
      aoi: REGION_AOI,
      aoiAreaKm2: 100,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 30 * 86_400_000),
      status: 'DRAFT',
      kind: 'CASE',
      createdBy: stranger,
      members: [],
    });
    await seedSweptScene(theirCase._id, new Date('2024-06-01T12:00:00Z'));

    // A signed-in analyst who is neither creator nor member sees nothing of it - the region is
    // public, the findings inside it are not.
    const agent = await signedInAgent();
    const res = await agent
      .get('/api/v1/discover/detections')
      .query({ from: '2024-05-01T00:00:00Z', to: '2024-07-01T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('reports findings that exist outside the requested window instead of showing a bare zero', async () => {
    const container = await InvestigationModel.create({
      name: 'Discover watch - outside window',
      aoi: REGION_AOI,
      aoiAreaKm2: 100,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 30 * 86_400_000),
      status: 'DRAFT',
      kind: 'SWEEP_CONTAINER',
      createdBy: new Types.ObjectId(),
      members: [],
    });
    await SweepStateModel.create({
      regionId: 'baniyas-syria',
      containerInvestigationId: container._id,
    });
    await seedSweptScene(container._id, new Date('2024-06-01T12:00:00Z'));

    const agent = await signedInAgent();
    // A window that deliberately misses the seeded scene by months.
    const res = await agent
      .get('/api/v1/discover/detections')
      .query({ from: '2024-01-01T00:00:00Z', to: '2024-03-01T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.outsidePeriod.count).toBe(2);
    expect(res.body.outsidePeriod.earliest).toBe('2024-06-01T12:00:00.000Z');
    expect(res.body.outsidePeriod.latest).toBe('2024-06-01T12:00:00.000Z');
  });

  it("lists the imagery the sweep saw, readable or not, with the provider's own reason", async () => {
    // The point of coverage: an overpass that produced nothing is still evidence the sky was
    // watched, and the reason it could not be used is the provider's wording, not ours.
    const agent = await signedInAgent();
    await SweepOverpassModel.create([
      {
        regionId: 'baniyas-syria',
        productId: 'S1A_RAW_IN_WINDOW',
        provider: 'PLANETARY_COMPUTER',
        stacCollection: 'sentinel-1-grd',
        acquiredAt: new Date('2024-06-02T00:00:00Z'),
        platform: 'S1A',
        footprint: REGION_AOI,
        ingestible: false,
        ingestibleReason: 'needs SNAP radiometric and terrain correction',
        seenAt: new Date(),
      },
      {
        regionId: 'baniyas-syria',
        productId: 'S1A_OUT_OF_WINDOW',
        provider: 'PLANETARY_COMPUTER',
        stacCollection: 'sentinel-1-grd',
        acquiredAt: new Date('2020-01-01T00:00:00Z'),
        ingestible: false,
        seenAt: new Date(),
      },
    ]);

    const res = await agent
      .get('/api/v1/discover/overpasses')
      .query({ from: '2024-05-01T00:00:00Z', to: '2024-07-01T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].productId).toBe('S1A_RAW_IN_WINDOW');
    expect(res.body.items[0].ingestible).toBe(false);
    expect(res.body.items[0].ingestibleReason).toMatch(/SNAP/);
  });

  it('filters coverage by region', async () => {
    const agent = await signedInAgent();
    await SweepOverpassModel.create([
      {
        regionId: 'baniyas-syria',
        productId: 'A',
        provider: 'PLANETARY_COMPUTER',
        stacCollection: 'sentinel-1-grd',
        acquiredAt: new Date('2024-06-02T00:00:00Z'),
        ingestible: false,
        seenAt: new Date(),
      },
      {
        regionId: 'guam-apra',
        productId: 'B',
        provider: 'PLANETARY_COMPUTER',
        stacCollection: 'sentinel-1-grd',
        acquiredAt: new Date('2024-06-02T00:00:00Z'),
        ingestible: false,
        seenAt: new Date(),
      },
    ]);

    const res = await agent
      .get('/api/v1/discover/overpasses')
      .query({ from: '2024-05-01T00:00:00Z', to: '2024-07-01T00:00:00Z', regionId: 'guam-apra' });

    expect(res.body.items.map((o: { productId: string }) => o.productId)).toEqual(['B']);
  });

  it('a manual sweep returns a job id, and a second press dedupes rather than double-running', async () => {
    const agent = await signedInAgent();

    const first = await agent.post('/api/v1/discover/sweep').send({ regionId: 'guam-apra' });
    expect([200, 202]).toContain(first.status);
    expect(first.body.jobId).toBeTruthy();
    expect(first.body.regionId).toBe('guam-apra');

    // Pressing again while the first is still queued must not start a second sweep.
    const second = await agent.post('/api/v1/discover/sweep').send({ regionId: 'guam-apra' });
    expect(second.body.jobId).toBe(first.body.jobId);
    expect(second.body.deduplicated).toBe(true);

    // And the person who pressed it can actually see it — an unscoped job is visible to its
    // creator, which is why the route attributes it to the caller, not the system account.
    const jobs = await agent.get('/api/v1/jobs').query({ limit: 20 });
    expect(jobs.body.items.some((j: { kind: string }) => j.kind === 'SWEEP_TICK')).toBe(true);
  });

  it('refuses a sweep of a region that does not exist', async () => {
    const agent = await signedInAgent();
    const res = await agent.post('/api/v1/discover/sweep').send({ regionId: 'not-a-region' });
    expect(res.status).toBe(404);
  });

  it('refuses to adopt a detection that is not a Discover result', async () => {
    const agent = await signedInAgent();
    const real = await InvestigationModel.create({
      name: 'A real case',
      aoi: REGION_AOI,
      aoiAreaKm2: 100,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 86_400_000),
      status: 'DRAFT',
      createdBy: new Types.ObjectId(),
      members: [],
    });
    const { detections } = await seedSweptScene(real._id, new Date());

    const res = await agent
      .post(`/api/v1/discover/detections/${detections[0]!._id}/adopt`)
      .send({});
    expect(res.status).toBe(400);
  });
});
