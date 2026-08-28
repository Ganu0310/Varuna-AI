# 06 — Backend Specification

**Product:** VARUNA
**Stack:** Node.js 20 + Express 5 + TypeScript + Mongoose 8 + BullMQ + Socket.IO
**Document version:** 1.0

---

## 6.1 Responsibilities

The Node backend owns everything except heavy raster/geodesy/ML compute:

| Owns | Delegates to Python ML service |
|---|---|
| Authentication, RBAC, sessions | SAR preprocessing |
| Investigation lifecycle and membership | Segmentation inference |
| External provider clients and credentials | Mask vectorisation and morphology |
| Job orchestration, retry, cancellation | Lagrangian back-tracking |
| MongoDB persistence and query | Attribution feature extraction and scoring |
| Coarse spatial filtering | Geodesic area and equal-area intersection |
| Exact vector geometry via Turf.js | — |
| WebSocket fan-out | — |
| Report rendering (Playwright) | — |
| Audit log and provenance enforcement | — |

---

## 6.2 Middleware chain (order matters)

```ts
app.use(requestId());                  // X-Request-Id in, echoed out
app.use(pinoHttp({ logger }));
app.use(helmet({ contentSecurityPolicy: cspConfig }));
app.use(cors({ origin: env.PUBLIC_APP_URL, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(mongoSanitize());              // strips $ and . from user input
app.use(rateLimit(globalLimits));
app.use('/api/v1', authenticate);      // populates req.user, does not authorise
app.use('/api/v1', router);            // per-route rbac() + validate()
app.use(provenanceGuard);              // response-level enforcement
app.use(errorHandler);                 // RFC 9457 problem+json, last
```

---

## 6.3 Mongoose models

### 6.3.1 The provenance base plugin

```ts
// models/plugins/provenance.ts
export const ProvenanceSchema = new Schema({
  sourceType: {
    type: String, required: true,
    enum: ['SATELLITE_SCENE','AIS_ARCHIVE','AIS_API','AIS_STREAM','OCEAN_MODEL',
           'ATMOSPHERIC_MODEL','COASTLINE_VECTOR','VESSEL_REGISTRY',
           'HUMAN_ANNOTATION','DERIVED'],
  },
  provider:      { type: String, required: true },
  datasetId:     { type: String, required: true },
  externalId:    { type: String, required: true },
  retrievedAt:   { type: Date,   required: true },
  licence:       { type: String, required: true },
  accessUrl:     String,
  checksum:      String,
  derivedFrom:   [{ type: Schema.Types.ObjectId, ref: 'ProvenanceRecord' }],
  processingManifestId: String,
}, { _id: false });

export function provenancePlugin(schema: Schema) {
  schema.add({ provenance: { type: ProvenanceSchema, required: true } });
  schema.pre('validate', function (next) {
    const p = (this as any).provenance;
    if (!p) return next(new Error('provenance is required'));
    if (!p.provider?.trim() || !p.externalId?.trim() || !p.licence?.trim()) {
      return next(new Error('provenance is incomplete'));
    }
    next();
  });
}
```

Applied to: `SatelliteScene`, `SpillDetection`, `VesselTrack`, `OriginEstimate`,
`CandidateVessel`, `Vessel`. This is the structural guarantee behind
[13_REAL_DATA_POLICY](13_REAL_DATA_POLICY.md).

### 6.3.2 GeoJSON sub-schemas

```ts
const PointSchema = new Schema({
  type: { type: String, enum: ['Point'], required: true },
  coordinates: {                                  // [lon, lat]
    type: [Number], required: true,
    validate: {
      validator: (c: number[]) =>
        c.length === 2 && c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90,
      message: 'coordinates must be [longitude, latitude] within valid ranges',
    },
  },
}, { _id: false });

const PolygonSchema = new Schema({
  type: { type: String, enum: ['Polygon'], required: true },
  coordinates: {
    type: [[[Number]]], required: true,
    validate: {
      // MongoDB 2dsphere requires closed rings and right-hand-rule winding
      validator: (rings: number[][][]) => rings.every(isClosedRing) && isRightHandWound(rings),
      message: 'polygon rings must be closed and follow the right-hand rule',
    },
  },
}, { _id: false });
```

> **Why the winding validator matters:** MongoDB interprets a wrongly-wound polygon as the
> *complement* of the intended area — the entire globe minus your slick. A `$geoWithin`
> query would then match every AIS position on Earth. This has been a silent, catastrophic
> bug in many projects. We normalise winding with `@turf/rewind` on write and validate it
> on save.

### 6.3.3 Model definitions (abridged)

```ts
// SatelliteScene
const SatelliteSceneSchema = new Schema({
  investigationId: { type: ObjectId, ref: 'Investigation', index: true },
  platform:  { type: String, required: true },
  sensor:    { type: String, enum: ['SAR-C','MSI','OLI'], required: true },
  productId: { type: String, required: true, unique: true },
  mode: String,
  polarisations: [{ type: String, enum: ['VV','VH','HH','HV'] }],
  orbitDirection: { type: String, enum: ['ASCENDING','DESCENDING'] },
  relativeOrbit: Number,
  acquiredAt: { type: Date, required: true, index: true },
  footprint:  { type: PolygonSchema, required: true, index: '2dsphere' },
  crs: { type: String, required: true },
  gsdMeters: { type: Number, required: true },
  cloudCoverPct: Number,
  storage: { bucket: String, key: String, cogKey: String, sizeBytes: Number, checksum: String },
  stacItem: { type: Schema.Types.Mixed, required: true },   // verbatim provider record
  processing: {
    chain: [{ step: String, tool: String, params: Mixed, at: Date }],
    manifestKey: String,
  },
  status: { type: String, enum: ['CATALOGUED','DOWNLOADING','PREPROCESSING','READY','FAILED'],
            default: 'CATALOGUED', index: true },
  failureReason: String,
}, { timestamps: true });
SatelliteSceneSchema.plugin(provenancePlugin);
```

```ts
// AisPosition — TIME-SERIES collection, created explicitly, not via Mongoose model sync
await db.createCollection('ais_positions', {
  timeseries: { timeField: 't', metaField: 'meta', granularity: 'seconds' },
});
await db.collection('ais_positions').createIndex({ 'meta.mmsi': 1, t: 1 });
await db.collection('ais_positions').createIndex({ position: '2dsphere' });
await db.collection('ais_positions').createIndex({ t: 1 });
```

> Time-series collections do not support `updateOne` on arbitrary fields or unique indexes.
> AIS is append-only by nature, which fits; deduplication happens at ingest time using a
> Redis-backed seen-set keyed by `${mmsi}:${tSeconds}:${lat5}:${lon5}`.

```ts
// CandidateVessel
const FeatureContributionSchema = new Schema({
  key:        { type: String, required: true },
  rawValue:   Number,
  rawUnit:    String,
  normalised: Number,
  weight:     { type: Number, required: true },
  contribution: Number,
  status: { type: String, enum: ['MEASURED','MISSING','NOT_APPLICABLE'], required: true },
  evidenceRefs: [{ kind: String, id: String, at: Date }],
}, { _id: false });

const CandidateVesselSchema = new Schema({
  investigationId:  { type: ObjectId, ref: 'Investigation', required: true, index: true },
  detectionId:      { type: ObjectId, ref: 'SpillDetection', required: true },
  originEstimateId: { type: ObjectId, ref: 'OriginEstimate', required: true },
  trackId:          { type: ObjectId, ref: 'VesselTrack', required: true },
  mmsi:  { type: Number, required: true, index: true },
  score: { type: Number, required: true, min: 0, max: 100 },
  scoreCI: { type: [Number], validate: (v: number[]) => v.length === 2 },
  tier:  { type: String, enum: ['STRONG','MODERATE','WEAK','INSUFFICIENT_EVIDENCE'], required: true },
  rank:  { type: Number, required: true },
  features: { type: [FeatureContributionSchema], required: true },
  measuredFeatureCount: { type: Number, required: true },
  weightProfileId: { type: String, required: true },
  modelVersion:    { type: String, required: true },
  calibrated:      { type: Boolean, required: true },
  excluded: { by: ObjectId, at: Date, reason: String },
}, { timestamps: true });
CandidateVesselSchema.index({ investigationId: 1, rank: 1 });
CandidateVesselSchema.plugin(provenancePlugin);
```

---

## 6.4 API reference

All routes are under `/api/v1`. All responses are JSON. Errors are RFC 9457
`application/problem+json`. Collection responses are cursor-paginated:
`{ items: T[], nextCursor: string | null, total?: number }`.

### 6.4.1 Auth

| Method | Path | Body | Response | Role |
|---|---|---|---|---|
| POST | `/auth/register` | `{ email, password, name, orgInviteCode? }` | `201 { user }` + cookies | public |
| POST | `/auth/login` | `{ email, password }` | `200 { user }` + cookies | public |
| POST | `/auth/refresh` | — (refresh cookie) | `200 { user }` + rotated cookies | public |
| POST | `/auth/logout` | — | `204` | auth |
| GET | `/auth/me` | — | `200 { user, permissions }` | auth |

### 6.4.2 Investigations

| Method | Path | Notes | Role |
|---|---|---|---|
| GET | `/investigations` | `?status=&from=&to=&tier=&cursor=&limit=` | analyst |
| POST | `/investigations` | `{ name, description?, aoi: Polygon, windowStart, windowEnd, reportedIncidentAt? }` | analyst |
| GET | `/investigations/:id` | Full document + pipeline stage summary | member |
| PATCH | `/investigations/:id` | Partial update; AOI/window changes invalidate downstream results and say so | lead |
| DELETE | `/investigations/:id` | Soft delete, audit-logged | lead |
| GET | `/investigations/:id/summary` | Counts, stages, degradation states, provenance roll-up | member |
| POST | `/investigations/:id/members` | `{ userId, role }` | lead |
| GET | `/investigations/:id/audit` | Append-only log | lead |
| POST | `/investigations/:id/comments` | `{ body, anchor? }` | member |

**AOI validation:** area computed with `turf.area` → km²; rejected over 50,000 km² with
`problem+json` detail giving the actual area. Window capped at 30 days.

### 6.4.3 Catalogue (live provider search — nothing persisted)

| Method | Path | Query | Role |
|---|---|---|---|
| GET | `/catalogue/search` | `aoi` (GeoJSON, urlencoded) · `from` · `to` · `platforms` · `orbitDirection?` · `polarisation?` · `maxCloud?` · `provider?` | member |
| GET | `/catalogue/providers` | Health, quota consumed, last success per provider | member |

Behaviour: fans out to the configured provider chain (CDSE → Planetary Computer → ASF),
normalises heterogeneous STAC/OData records to one shape, dedupes by product ID,
returns per-provider status so a partial failure is visible rather than hidden.

```jsonc
// 200 response
{
  "items": [{
    "productId": "S1A_IW_GRDH_1SDV_20230814T061247_...",
    "provider": "CDSE",
    "platform": "SENTINEL-1A",
    "mode": "IW",
    "polarisations": ["VV","VH"],
    "orbitDirection": "DESCENDING",
    "acquiredAt": "2023-08-14T06:12:47Z",
    "footprint": { "type": "Polygon", "coordinates": [[...]] },
    "aoiOverlapPct": 87.4,
    "sizeBytes": 1073741824,
    "assets": { "VV": "...", "VH": "..." }
  }],
  "providerStatus": [
    { "provider": "CDSE", "status": "OK", "count": 14, "latencyMs": 812 },
    { "provider": "MPC",  "status": "OK", "count": 14, "latencyMs": 402 },
    { "provider": "ASF",  "status": "CIRCUIT_OPEN", "count": 0,
      "reason": "5 consecutive failures, retry at 2026-08-27T12:40:00Z" }
  ]
}
```

### 6.4.4 Scenes

| Method | Path | Notes |
|---|---|---|
| POST | `/scenes/ingest` | `{ investigationId, productId, provider }` → `202 { jobId }`. Idempotent on `productId`. |
| POST | `/scenes/upload` | multipart GeoTIFF. Rejects files without CRS, transform, or acquisition time. |
| GET | `/scenes?investigationId=` | List with status |
| GET | `/scenes/:id` | Full document incl. processing manifest |
| GET | `/scenes/:id/tiles` | `{ tileUrl, bounds, minzoom, maxzoom, defaultRescale }` — a signed TiTiler URL template |
| GET | `/scenes/:id/quicklook` | Redirect to a signed object-storage URL |
| DELETE | `/scenes/:id` | Removes derived artefacts; blocked if detections reference it |

### 6.4.5 Detections

| Method | Path | Notes |
|---|---|---|
| POST | `/detections/run` | `{ sceneId, modelId?, minAreaKm2?, minProbability? }` → `202 { jobId }` |
| GET | `/detections?investigationId=` | List |
| GET | `/detections/:id` | Full document |
| GET | `/detections/:id/geometry` | GeoJSON; `?simplify=z{zoom}` for zoom-appropriate simplification; `ETag` |
| POST | `/detections/:id/review` | `{ action: 'CONFIRM'\|'REJECT'\|'EDIT', note?, geometry? }` — creates a new version, never mutates the model output |
| GET | `/detections/:id/versions` | Full review history |
| GET | `/detections/:id/probability-tiles` | Signed TiTiler template for the probability raster |

### 6.4.6 Origin estimation

| Method | Path | Notes |
|---|---|---|
| POST | `/origin/run` | `{ detectionId, horizonHours?, particleCount?, windDriftRange?, deflectionRange? }` → `202 { jobId }` |
| GET | `/origin/:id` | Origin estimate incl. `status`, `degradationReason`, forcing provenance |
| GET | `/origin/:id/frames` | `[{ atTime, tileUrl, bounds }]` for the KDE surfaces |
| GET | `/origin/:id/support` | `{ support50, support90 }` as GeoJSON |
| GET | `/origin/:id/particles` | `?format=binary` — ensemble trajectories for the prism |

### 6.4.7 AIS

| Method | Path | Notes |
|---|---|---|
| POST | `/ais/import` | `{ investigationId, source, from, to, bbox }` → `202 { jobId }`. Pulls from the configured archive/API. |
| POST | `/ais/upload` | CSV upload; column mapping UI-driven; validated per row, rejects rather than coerces |
| GET | `/ais/positions` | `?bbox=&from=&to=&mmsi=&limit=` — raw fixes, paginated |
| GET | `/ais/tracks` | `?investigationId=&format=json\|binary&simplify=z{zoom}` |
| GET | `/ais/tracks/:mmsi` | Single reconstructed track with gaps and quality |
| GET | `/ais/coverage` | `{ source, recordCount, firstAt, lastAt, bboxCovered, medianIntervalSec }` — the honesty endpoint: tells the analyst what data actually exists |
| GET | `/ais/vessel/:mmsi` | Static data, flag from MID, registry join |

**The envelope query** (the core spatiotemporal join):

```ts
// modules/ais/service.ts
export async function queryEnvelope(
  envelope: Polygon,               // already buffered by Turf
  from: Date, to: Date,
): Promise<AisPositionLean[]> {
  return db.collection('ais_positions').find(
    {
      t: { $gte: from, $lte: to },
      position: { $geoWithin: { $geometry: envelope } },
    },
    {
      projection: { t: 1, 'meta.mmsi': 1, position: 1, sog: 1, cog: 1, navStatus: 1, _id: 0 },
      hint: { 'meta.mmsi': 1, t: 1 },
    },
  ).toArray();
}
```

> **Index note:** MongoDB will use either the time index or the `2dsphere` index, not both.
> Benchmarking on real data determines which selector is more restrictive for typical
> envelopes; for a 100 km × 24 h envelope in a busy strait the *time* predicate is usually
> more selective, so we hint the compound `{meta.mmsi, t}` index and let the geo predicate
> filter in memory. For a large bbox over a long window the `2dsphere` index wins. The
> service picks the hint from the envelope's area-to-duration ratio, and the choice is
> logged so it can be verified against real query plans.

### 6.4.8 Candidates

| Method | Path | Notes |
|---|---|---|
| POST | `/candidates/score` | `{ investigationId, detectionId, originEstimateId, weightProfileId? }` → `202 { jobId }` |
| GET | `/candidates?investigationId=` | Ranked list |
| GET | `/candidates/:id` | Full evidence |
| GET | `/candidates/:id/evidence/:featureKey` | Source records behind one feature |
| POST | `/candidates/reweight` | `{ investigationId, weights: Record<string, number> }` — synchronous, < 3 s, returns re-ranked list; the profile is persisted and recorded in the report |
| POST | `/candidates/:id/exclude` | `{ reason }` — required, audit-logged |
| DELETE | `/candidates/:id/exclude` | Restore |
| GET | `/candidates/weight-profiles` | Default + saved profiles |

### 6.4.9 Reports

| Method | Path | Notes |
|---|---|---|
| POST | `/reports/generate` | `{ investigationId, sections[], format: 'PDF' }` → `202 { jobId }`. `UNCERTAINTY` and `PROVENANCE` sections cannot be omitted — the API rejects a payload that excludes them. |
| GET | `/reports?investigationId=` | List |
| GET | `/reports/:id` | Metadata incl. embedded version hashes |
| GET | `/reports/:id/download` | Redirect to a signed URL, 15 min TTL |
| GET | `/reports/:id/exports/geojson` | Bundle: detections, tracks, origin support, candidates |
| GET | `/reports/:id/exports/csv` | Candidates + per-feature contributions |
| GET | `/reports/:id/manifest` | Full run manifest for reproduction |

### 6.4.10 Jobs and admin

| Method | Path | Role |
|---|---|---|
| GET | `/jobs?investigationId=&status=` | member |
| GET | `/jobs/:id` | member |
| POST | `/jobs/:id/cancel` | member |
| POST | `/jobs/:id/retry` | analyst |
| GET | `/admin/users`, `POST /admin/users/:id/role` | admin |
| GET | `/admin/quotas` | Per-provider consumption | admin |
| GET | `/admin/providers` | Circuit-breaker state, latency, last success | admin |
| GET | `/admin/audit` | Filterable append-only log | admin |
| GET | `/health`, `/health/deep` | public / internal |

---

## 6.5 Provider client architecture

```ts
// providers/ProviderClient.ts
export abstract class ProviderClient {
  abstract readonly name: string;
  abstract readonly quotaKey: string;

  private breaker = new CircuitBreaker({ threshold: 5, resetMs: 60_000 });

  protected async request<T>(fn: () => Promise<T>, cost = 1): Promise<T> {
    if (this.breaker.isOpen()) {
      throw new ProviderUnavailable(this.name, 'CIRCUIT_OPEN', this.breaker.retryAt());
    }
    await this.quota.consume(this.quotaKey, cost);       // Redis counter, throws if exhausted
    try {
      const result = await retry(fn, {
        retries: 3, factor: 2, minTimeout: 1000,
        retryOn: (e) => isTransient(e) || e.status === 429,
      });
      this.breaker.recordSuccess();
      return result;
    } catch (e) {
      this.breaker.recordFailure();
      throw e;
    }
  }
}
```

### 6.5.1 Provider chains

```ts
export const CHAINS = {
  SATELLITE_CATALOGUE: ['CDSE', 'PLANETARY_COMPUTER', 'ASF'],
  SATELLITE_DOWNLOAD:  ['PLANETARY_COMPUTER', 'CDSE', 'ASF'],   // MPC RTC first: pre-processed
  OCEAN_CURRENTS:      ['CMEMS', 'HYCOM'],
  WIND:                ['ERA5', 'GFS'],
  AIS_HISTORICAL:      ['LOCAL_ARCHIVE', 'MARINE_CADASTRE', 'DMA_DK', 'KYSTVERKET', 'GFW'],
  AIS_LIVE:            ['AISSTREAM'],
} as const;
```

**Chain semantics:** try each in order; a `ProviderUnavailable` moves to the next; a
data-level "no results" does **not** move to the next (an empty result is a real answer).
Chain exhaustion returns:

```jsonc
{
  "type": "https://varuna.dev/problems/data-unavailable",
  "title": "Ocean current data unavailable",
  "status": 503,
  "detail": "CMEMS returned no coverage for 2019-03-04 in this region; HYCOM request timed out.",
  "attempted": [
    { "provider": "CMEMS",  "outcome": "NO_COVERAGE" },
    { "provider": "HYCOM",  "outcome": "TIMEOUT" }
  ],
  "consequence": "Origin estimation will run in FOOTPRINT_PROXIMITY mode with reduced confidence."
}
```

Note that the error body states the **consequence**. That is a requirement, not a nicety —
the analyst must understand what the degradation means.

### 6.5.2 OAuth2 token handling (CDSE)

```ts
class CdseClient extends ProviderClient {
  private token: { value: string; expiresAt: number } | null = null;

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch(CDSE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.CDSE_CLIENT_ID,
        client_secret: env.CDSE_CLIENT_SECRET,
      }),
    });
    const json = await res.json();
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }
}
```

Tokens are cached in Redis (shared across replicas), never logged, and never returned in an
API response.

---

## 6.6 Job implementations

### 6.6.1 Scene ingest

```ts
export const ingestScene = async (job: Job<IngestPayload>) => {
  const { investigationId, productId, provider } = job.data;

  await job.updateProgress({ pct: 5, stage: 'RESOLVING', message: 'Locating product' });
  const item = await catalogueService.resolve(productId, provider);

  await job.updateProgress({ pct: 15, stage: 'DOWNLOADING' });
  const rawKey = await mlClient.download({ item, bucket: env.S3_BUCKET });

  await job.updateProgress({ pct: 45, stage: 'PREPROCESSING' });
  const pre = await mlClient.preprocess({ rawKey, sensor: item.sensor, mode: item.mode });
  // pre = { cogKeys, manifest, crs, gsdMeters, checksum }

  await job.updateProgress({ pct: 85, stage: 'PERSISTING' });
  const provenance = await provenanceService.record({
    sourceType: 'SATELLITE_SCENE',
    provider, datasetId: item.collection, externalId: productId,
    retrievedAt: new Date(), licence: item.licence,
    accessUrl: item.selfHref, checksum: pre.checksum,
  });

  await SatelliteScene.findOneAndUpdate(
    { productId },                                  // idempotency key
    { $set: { ...mapItem(item), ...pre, investigationId, provenance, status: 'READY' } },
    { upsert: true, new: true },
  );

  await job.updateProgress({ pct: 100, stage: 'COMPLETE' });
};
```

### 6.6.2 Correlation job (the heart of the system)

```ts
export const correlate = async (job: Job<CorrelatePayload>) => {
  const { investigationId, detectionId } = job.data;
  const detection = await SpillDetection.findById(detectionId).orFail();
  const origin    = await OriginEstimate.findOne({ detectionId }).orFail();

  // 1. Build the search envelope — Turf, because MongoDB cannot buffer
  await job.updateProgress({ pct: 10, stage: 'ENVELOPE' });
  const bufferKm = origin.status === 'OK' ? 15 : 40;   // wider when drift is degraded
  const envelope = turf.rewind(
    turf.buffer(origin.originField.support90, bufferKm, { units: 'kilometers' })!,
  ) as Polygon;

  const from = new Date(+origin.releaseWindow.earliest - 3 * 3600e3);
  const to   = new Date(+origin.releaseWindow.latest   + 3 * 3600e3);

  // 2. Coarse filter — MongoDB does what MongoDB is good at
  await job.updateProgress({ pct: 25, stage: 'AIS_QUERY' });
  const positions = await aisService.queryEnvelope(envelope, from, to);
  if (positions.length === 0) {
    await job.updateProgress({ pct: 100, stage: 'COMPLETE' });
    return { candidates: [], reason: 'NO_AIS_COVERAGE',
             sourcesQueried: await aisService.coverageFor(envelope, from, to) };
  }

  // 3. Reconstruct tracks — cleaning, gap detection, segmentation
  await job.updateProgress({ pct: 45, stage: 'TRACKS' });
  const tracks = await trackService.reconstruct(positions, {
    maxGapMinutes: 20, maxImpliedSpeedKn: 45, minPoints: 3,
  });
  await VesselTrack.insertMany(tracks.map(t => ({ ...t, investigationId })));

  // 4. Score — Python service owns the geodesy and the model
  await job.updateProgress({ pct: 70, stage: 'SCORING' });
  const scored = await mlClient.score({
    detection: detection.toObject(),
    origin: origin.toObject(),
    tracks: tracks.map(toScoringInput),
    weightProfileId: job.data.weightProfileId ?? 'DEFAULT_V1',
  });

  // 5. Persist
  await job.updateProgress({ pct: 90, stage: 'PERSISTING' });
  await CandidateVessel.insertMany(scored.candidates.map((c, i) => ({
    ...c, rank: i + 1, investigationId, detectionId,
    originEstimateId: origin._id,
    provenance: { sourceType: 'DERIVED', provider: 'VARUNA',
                  datasetId: 'attribution', externalId: `${detectionId}:${c.mmsi}`,
                  retrievedAt: new Date(), licence: 'internal',
                  derivedFrom: [detection.provenance, origin.provenance] },
  })));

  await job.updateProgress({ pct: 100, stage: 'COMPLETE' });
};
```

### 6.6.3 Track reconstruction

```ts
export function reconstruct(
  positions: AisPositionLean[],
  opts: { maxGapMinutes: number; maxImpliedSpeedKn: number; minPoints: number },
): ReconstructedTrack[] {
  const byMmsi = groupBy(positions, p => p.meta.mmsi);

  return Object.entries(byMmsi).flatMap(([mmsiStr, fixes]) => {
    const mmsi = Number(mmsiStr);
    const flags = new Set<QualityFlag>();

    if (!isValidMmsi(mmsi)) flags.add('MMSI_INVALID');

    const sorted = fixes.sort((a, b) => +a.t - +b.t);

    // Kinematic outlier removal — a "position jump" is physically impossible movement
    const kept: AisPositionLean[] = [];
    let removed = 0;
    for (const f of sorted) {
      const prev = kept[kept.length - 1];
      if (prev) {
        const dtH = (+f.t - +prev.t) / 3600e3;
        if (dtH > 0) {
          const distNm = turf.distance(toPt(prev), toPt(f), { units: 'kilometers' }) / 1.852;
          const implied = distNm / dtH;
          if (implied > opts.maxImpliedSpeedKn) { removed++; flags.add('POSITION_JUMP'); continue; }
        }
      }
      kept.push(f);
    }

    // Gap-aware segmentation
    const segments: Segment[] = [];
    const gaps: Gap[] = [];
    let current: AisPositionLean[] = [];
    for (let i = 0; i < kept.length; i++) {
      if (i > 0) {
        const gapMin = (+kept[i].t - +kept[i - 1].t) / 60000;
        if (gapMin > opts.maxGapMinutes) {
          if (current.length >= opts.minPoints) segments.push(toSegment(current));
          gaps.push(toGap(kept[i - 1], kept[i], gapMin));
          flags.add('AIS_GAP');
          current = [];
        }
      }
      current.push(kept[i]);
    }
    if (current.length >= opts.minPoints) segments.push(toSegment(current));

    const intervals = pairwiseIntervalsSec(kept);
    const medianInterval = median(intervals);
    if (medianInterval > 600) flags.add('LOW_SAMPLING');

    return [{
      mmsi, segments, gaps,
      quality: {
        flags: [...flags],
        completeness: computeCompleteness(kept, medianInterval),
        medianSamplingIntervalSec: medianInterval,
        removedOutlierCount: removed,
      },
    }];
  });
}
```

**Design note:** removed outliers are *counted and surfaced*, never silently dropped. An
analyst seeing `removedOutlierCount: 41` on one vessel learns something important about
that vessel's AIS integrity.

---

## 6.7 Realtime (Socket.IO)

```ts
io.use(async (socket, next) => {
  const token = parseCookie(socket.handshake.headers.cookie)?.access_token;
  const user = await verifyAccessToken(token);
  if (!user) return next(new Error('unauthorised'));
  socket.data.user = user;
  next();
});

io.of('/investigations').on('connection', (socket) => {
  socket.on('join', async (investigationId: string) => {
    if (!(await canAccessInvestigation(socket.data.user, investigationId))) return;
    socket.join(`inv:${investigationId}`);
    socket.emit('presence:sync', await presence.listFor(investigationId));
  });
});

// Worker → API bridge over a Redis pub/sub channel
queueEvents.on('progress', ({ jobId, data }) => {
  const meta = jobMetaCache.get(jobId);
  io.of('/investigations').to(`inv:${meta.investigationId}`)
    .emit('job:progress', { jobId, ...data });
});
```

Presence, comments, and candidate re-ranking all fan out on the same investigation room.

---

## 6.8 Report generation

```ts
export const generateReport = async (job: Job<ReportPayload>) => {
  const { investigationId, sections } = job.data;

  // Mandatory sections cannot be excluded — enforced here as well as at the API boundary
  const final = uniq([...sections, 'UNCERTAINTY', 'PROVENANCE']);

  const token = await issueReportToken(investigationId, '10m');   // short-lived, read-only
  const url = `${env.PUBLIC_APP_URL}/investigations/${investigationId}/report`
            + `?token=${token}&sections=${final.join(',')}&print=1`;

  const page = await browserPool.acquire();
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-report-ready="true"]', { timeout: 60_000 });
    const pdf = await page.pdf({
      format: 'A4', printBackground: true,
      margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' },
      displayHeaderFooter: true,
      footerTemplate: FOOTER_HTML,   // page numbers + investigation ID + generation time
    });
    const key = `reports/${job.id}/dossier.pdf`;
    await s3.putObject({ Bucket: env.S3_BUCKET, Key: key, Body: pdf,
                         ContentType: 'application/pdf' });
    await Report.create({
      investigationId, key, sections: final,
      pipelineVersion: PIPELINE_VERSION,
      modelVersions: await collectModelVersions(investigationId),
      weightProfileId: await activeWeightProfile(investigationId),
      generatedBy: job.data.userId, generatedAt: new Date(),
    });
    return { key };
  } finally {
    await browserPool.release(page);
  }
};
```

The report route renders the same React components as the app, in light theme, so the
typography and the evidence visualisations are identical to what the analyst reviewed on
screen. `data-report-ready="true"` is set only after every map tile, chart and font has
settled — this prevents half-rendered PDFs.

---

## 6.9 Security implementation

| Control | Implementation |
|---|---|
| Password hashing | `argon2.hash(pw, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })` |
| Access token | JWT, 15 min, `httpOnly; Secure; SameSite=Strict` cookie |
| Refresh token | 7 days, rotated on every use, SHA-256 hash stored in `refresh_tokens`, revoked on reuse detection (token-theft signal) |
| RBAC | `rbac('analyst')` middleware plus resource-level `canAccessInvestigation(user, id)` on every scoped route |
| Input validation | `validate(schema)` middleware using shared Zod schemas; `strict()` so unknown keys are rejected |
| NoSQL injection | `express-mongo-sanitize` plus typed query builders; user strings never become query objects |
| Rate limits | Global 100/min/IP; auth 10/min/IP; job creation 20/hour/user; catalogue search 60/hour/user |
| Upload validation | Extension → magic bytes → `gdalinfo` open → CRS and transform present → acquisition time present. Any failure rejects. |
| Signed URLs | All object reads via presigned URLs, 15 min TTL, never a public bucket |
| Secrets | `env.ts` Zod-validated at boot, `process.exit(1)` on any missing required key |
| Service auth | Python service requires `X-Service-Token`; bound to the internal network; not routable publicly |
| Audit | `audit()` helper called from every mutating service method; writes `{ actorId, action, entityType, entityId, before, after, at, requestId }` |

---

## 6.10 Error handling

```ts
// middleware/errorHandler.ts — RFC 9457
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.id;

  if (err instanceof ZodError) {
    return res.status(400).type('application/problem+json').json({
      type: 'https://varuna.dev/problems/validation',
      title: 'Request validation failed',
      status: 400, requestId,
      errors: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  if (err instanceof ProviderUnavailable) {
    return res.status(503).type('application/problem+json').json({
      type: 'https://varuna.dev/problems/data-unavailable',
      title: `${err.provider} unavailable`,
      status: 503, requestId,
      detail: err.detail, attempted: err.attempted, consequence: err.consequence,
    });
  }

  if (err instanceof ProvenanceError) {
    logger.error({ err, requestId }, 'PROVENANCE VIOLATION');   // paged, not just logged
    return res.status(500).type('application/problem+json').json({
      type: 'https://varuna.dev/problems/provenance',
      title: 'Data integrity violation',
      status: 500, requestId,
      detail: 'An object without a verifiable source was blocked from the response.',
    });
  }

  logger.error({ err, requestId }, 'Unhandled error');
  res.status(500).type('application/problem+json').json({
    type: 'about:blank', title: 'Internal server error', status: 500, requestId,
  });
}
```

Provenance violations are treated as **severity-1 integrity incidents**, not ordinary
errors: they are alerted on, because they indicate the no-fake-data guarantee has been
breached somewhere in the pipeline.

---

## 6.11 Testing

| Level | Tool | Focus |
|---|---|---|
| Unit | Vitest | Services with mocked repositories; 100% on `geo/`, `trackService`, `provenanceService` |
| Known-answer geodesy | Vitest | Fixed reference distances/areas; must match the Python service within 0.1% |
| Polygon winding | Vitest | Wrongly-wound polygon must be rejected or rewound — with an explicit test asserting a `$geoWithin` on it does *not* match the whole world |
| Integration | Testcontainers (Mongo + Redis + MinIO) | Full ingest → detect → correlate chain on one cached real scene |
| Contract | OpenAPI diff in CI | Spec cannot drift from implementation |
| Load | k6 | Envelope query at 10^7 stored positions; asserts the p95 < 400 ms budget |
| Security | `npm audit`, `gitleaks`, custom RBAC matrix test | Every route × every role |

**Fixtures:** every fixture is a captured real provider response stored under
`__fixtures__/real/` with a sibling `.provenance.json`. A CI script fails the build if any
fixture lacks one, or if `@faker-js/faker` appears in a runtime dependency tree.
