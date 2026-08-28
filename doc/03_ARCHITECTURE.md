# 03 — System Architecture

**Product:** VARUNA
**Problem Statement:** SIH26143
**Document version:** 1.0

---

## 3.1 Architectural principles

| # | Principle | Consequence in the design |
|---|---|---|
| 1 | **Right language for the domain** | Geospatial raster work and deep learning stay in Python. Business logic, orchestration and the API stay in Node. We do not force GDAL into Node, and we do not force auth/RBAC into Python. |
| 2 | **Nothing slow in a request** | Anything over ~10 s becomes a queued job with an ID, a progress stream, and a cancel path. |
| 3 | **Coarse filter in the database, exact geometry in code** | MongoDB reduces millions of AIS rows to hundreds; Turf/Shapely then compute exact geodesy and write the result back as indexed GeoJSON. |
| 4 | **Every artefact is addressable and reproducible** | Scenes, masks, probability rasters, origin grids and PDFs live in object storage under content-addressed keys; every derived document records the manifest that produced it. |
| 5 | **Provenance is structural, not documentation** | It is a required field, validated at the model layer, enforced at the serialiser, and rendered by the UI. It cannot be skipped. |
| 6 | **Degrade loudly** | Every module has an `UNAVAILABLE` / `DEGRADED` state that propagates to the UI and the PDF. No silent defaults. |
| 7 | **Stateless services, stateful stores** | API and worker containers hold no local state; scale horizontally. |

---

## 3.2 System context

```mermaid
---
id: e0dbda72-796b-4f6e-8ec2-5bd86f767e97
---
flowchart TB
  subgraph Users
    A1["Coast Guard officer"]
    A2["Environmental analyst"]
    A3["Researcher"]
    A4["Administrator"]
  end

  subgraph VARUNA["VARUNA Platform"]
    W["React Workspace<br/>(MapLibre + deck.gl + R3F)"]
    API["Node/Express API"]
    ML["Python ML &amp; Geo Service"]
    Q["BullMQ Workers"]
    DB[("MongoDB 7")]
    R[("Redis 7")]
    S3[("S3-compatible<br/>object storage")]
    T["TiTiler"]
  end

  subgraph External["External real-data providers"]
    E1["Copernicus Data Space<br/>Sentinel-1 / 2"]
    E2["Planetary Computer<br/>Sentinel-1 RTC"]
    E3["ASF DAAC<br/>(NASA Earthdata)"]
    E4["CMEMS<br/>ocean currents"]
    E5["ERA5 / GFS<br/>winds"]
    E6["Marine Cadastre / DMA / Kystverket<br/>historical AIS"]
    E7["Global Fishing Watch<br/>AIS API"]
    E8["AISStream<br/>live AIS"]
  end

  A1 & A2 & A3 & A4 --> W
  W <-->|"REST + WebSocket"| API
  W -->|"XYZ tiles"| T
  API <--> DB
  API <--> R
  API -->|"internal HTTP"| ML
  API --> S3
  Q --> ML
  Q --> DB
  Q --> S3
  R -.->|"job broker"| Q
  T --> S3
  ML --> S3
  API --> E1 & E4 & E5 & E6 & E7 & E8
  ML --> E1 & E2 & E3 & E4 & E5
```

---

## 3.3 Service topology

| Service | Container | Language | Scaling | Public |
|---|---|---|---|---|
| `varuna-web` | nginx serving static Vite build | — | CDN | Yes |
| `varuna-api` | Node 20 / Express 5 | TypeScript | Horizontal, stateless, N replicas | Yes (TLS) |
| `varuna-worker` | Node 20 / BullMQ consumer | TypeScript | Horizontal by queue depth | No |
| `varuna-ml` | Python 3.11 / FastAPI + Uvicorn | Python | Vertical (GPU) + horizontal for CPU tasks | No |
| `varuna-titiler` | TiTiler (Python) | Python | Horizontal, cache-fronted | Yes (signed) |
| `mongodb` | MongoDB 7 / Atlas | — | Managed replica set, shardable | No |
| `redis` | Redis 7 / Upstash | — | Managed | No |
| `minio` (dev only) | MinIO | — | Single node | Local |

### 3.3.1 Why the ML service is separate rather than embedded

1. **Dependency isolation.** GDAL, PyTorch, SNAP and OpenDrift are heavy, native, and
   version-sensitive. Coupling them to the API container would make every API deploy a
   500 MB+ rebuild.
2. **Independent scaling.** Inference needs a GPU; the API does not. They scale on
   different axes and different cost curves.
3. **Failure isolation.** A CUDA OOM or a GDAL segfault must not take down authentication.
4. **Language fit.** There is no credible Node equivalent of rasterio, Shapely or
   OpenDrift. Reimplementing them would be the single largest source of correctness bugs
   in the project.

This is still MERN: MongoDB, Express, React and Node own the product. Python is a
specialised compute sidecar behind an internal HTTP boundary, in the same way a MERN app
would call an image-processing service.

---

## 3.4 Data flow — end to end

```mermaid
---
id: 668bcd47-cd6d-4bf8-924e-5b86a23d56ba
---
sequenceDiagram
    autonumber
    actor An as Analyst
    participant W as React Workspace
    participant API as Express API
    participant R as Redis / BullMQ
    participant Wk as Worker
    participant ML as Python ML Service
    participant S3 as Object Storage
    participant DB as MongoDB
    participant P as External Providers

    An->>W: Draw AOI, set date window
    W->>API: POST /investigations
    API->>DB: insert investigation + audit
    API-->>W: 201 { investigationId }

    An->>W: Search scenes
    W->>API: GET /catalogue/search
    API->>P: STAC / OData query (CDSE, MPC)
    P-->>API: real scene records
    API-->>W: scene list + footprints

    An->>W: Ingest selected scene
    W->>API: POST /scenes/ingest
    API->>R: enqueue ingest job
    API-->>W: 202 { jobId }
    R->>Wk: dispatch
    Wk->>ML: POST /preprocess (productId)
    ML->>P: download scene
    ML->>ML: orbit, noise, calibrate, speckle, terrain-correct, dB
    ML->>S3: write COG + processing manifest
    ML-->>Wk: { cogKey, manifest, provenance }
    Wk->>DB: upsert satellite_scenes
    Wk-->>W: ws job:progress -> COMPLETED

    An->>W: Run detection
    W->>API: POST /detections/run
    API->>R: enqueue inference job
    R->>Wk: dispatch
    Wk->>ML: POST /segment (cogKey)
    ML->>S3: read COG windows
    ML->>ML: tile, infer, blend, post-process
    ML->>ML: polygonise + geodesic morphology
    ML->>S3: write class raster + probability raster
    ML-->>Wk: polygons + confidence + classCounts
    Wk->>DB: insert spill_detections
    Wk-->>W: ws job:progress -> COMPLETED

    An->>W: Estimate origin
    W->>API: POST /origin/run
    API->>R: enqueue drift job
    R->>Wk: dispatch
    Wk->>ML: POST /backtrack
    ML->>P: fetch CMEMS currents + ERA5/GFS winds
    ML->>ML: seed particles, integrate backwards, KDE
    ML->>S3: write origin grids (GeoTIFF frames)
    ML-->>Wk: releaseWindow + support50/90 + centroid
    Wk->>DB: insert origin_estimates

    Wk->>Wk: build search envelope (Turf buffer)
    Wk->>DB: $geoWithin + time-range query on ais_positions
    DB-->>Wk: raw positions
    Wk->>Wk: clean, segment, gap-detect, reconstruct tracks
    Wk->>DB: insert vessel_tracks

    Wk->>ML: POST /score (tracks + originField + detection)
    ML->>ML: 12 features, normalise, weight, calibrate, bootstrap CI
    ML-->>Wk: ranked candidates + per-feature contributions
    Wk->>DB: insert candidate_vessels
    Wk-->>W: ws job:progress -> COMPLETED

    An->>W: Review evidence, adjust weights, export
    W->>API: POST /reports/generate
    API->>R: enqueue report job
    Wk->>Wk: Playwright renders /report/:id route
    Wk->>S3: write PDF
    Wk-->>W: download URL
```

---

## 3.5 Component architecture

### 3.5.1 Express API internal layering

```
apps/api/src/
├── index.ts                  # bootstrap, graceful shutdown
├── env.ts                    # Zod-validated environment, fails fast
├── app.ts                    # express app, middleware chain
├── middleware/
│   ├── requestId.ts  auth.ts  rbac.ts  rateLimit.ts
│   ├── validate.ts           # Zod boundary validation
│   ├── errorHandler.ts       # RFC 9457 problem+json
│   └── provenanceGuard.ts    # strips + logs objects lacking provenance
├── modules/                  # one folder per bounded context
│   ├── auth/        { router, controller, service, model, schema }
│   ├── investigations/
│   ├── catalogue/
│   ├── scenes/
│   ├── detections/
│   ├── origin/
│   ├── ais/
│   ├── candidates/
│   ├── reports/
│   ├── jobs/
│   └── admin/
├── providers/                # one client per external data source
│   ├── ProviderClient.ts     # retry, backoff, circuit breaker, quota
│   ├── cdse.ts  planetaryComputer.ts  asf.ts
│   ├── cmems.ts  era5.ts  gfs.ts
│   └── ais/{marineCadastre,dmaDk,kystverket,gfw,aisStream}.ts
├── geo/                      # Turf wrappers with branded units
│   ├── units.ts  envelope.ts  trackGeometry.ts  knownAnswers.test.ts
├── queue/                    # BullMQ definitions + producers
├── realtime/                 # Socket.IO namespaces, rooms, auth
└── lib/                      # s3, mongo, redis, logger, mlClient
```

**Module contract:** every module exposes exactly `router.ts` (HTTP), `service.ts`
(business logic, no Express types), `model.ts` (Mongoose), and `schema.ts` (Zod, re-exported
from `packages/shared`). Controllers never touch Mongoose directly; services never touch
`req`/`res`.

### 3.5.2 Python ML service internals

```
services/ml/
├── main.py                   # FastAPI app, service-token auth
├── config.py                 # pydantic-settings
├── routers/
│   ├── preprocess.py         # SAR chain / RTC passthrough
│   ├── segment.py            # tiled inference
│   ├── vectorise.py          # mask -> polygons + morphology
│   ├── backtrack.py          # OpenDrift backward run
│   ├── score.py              # feature extraction + attribution model
│   └── health.py
├── sar/
│   ├── snap_graphs/*.xml     # SNAP gpt graph definitions
│   ├── preprocess.py  cog.py  landmask.py
├── models/
│   ├── architectures.py      # smp U-Net / U-Net++ / DeepLabV3+ / SegFormer
│   ├── inference.py          # tiling, cosine blending, AMP
│   ├── postprocess.py        # morphology, min-area, hole fill
│   └── registry.py           # content-addressed artefact loading
├── geo/
│   ├── polygonise.py  morphology.py  geodesy.py  projections.py
├── drift/
│   ├── forcing.py            # CMEMS + ERA5/GFS -> xarray
│   ├── backtrack.py          # OpenDrift wrapper
│   └── kde.py                # particle cloud -> probability surface
├── attribution/
│   ├── features.py           # the 12 evidence features
│   ├── model.py              # additive/logistic model + calibration
│   └── bootstrap.py          # confidence intervals
└── provenance.py             # every response carries provenance
```

### 3.5.3 React client structure

Full detail in [05_FRONTEND_Specification.md](05_FRONTEND_Specification.md). Topology:

```
apps/web/src/
├── app/            # router, providers, error boundaries
├── features/       # investigation, catalogue, detection, origin, ais,
│                   # candidates, evidence, reports, admin
├── map/            # MapLibre instance, deck.gl overlay, layer registry
├── three/          # R3F globe, slick relief, hero scene
├── design/         # tokens, primitives, motion presets
├── state/          # zustand stores: map, time, layers, selection, ui
├── api/            # typed client generated from OpenAPI + TanStack Query hooks
└── lib/            # units, formatters, geo helpers, provenance guard
```

---

## 3.6 Job queue architecture

```mermaid
---
id: cc0d6098-cbc3-4aff-9d3f-31f76e814bb8
---
flowchart LR
  API["API<br/>producer"] -->|add| Q1["queue: ingest"]
  API -->|add| Q2["queue: inference"]
  API -->|add| Q3["queue: drift"]
  API -->|add| Q4["queue: ais-import"]
  API -->|add| Q5["queue: scoring"]
  API -->|add| Q6["queue: report"]
  Q1 --> W1["worker pool<br/>io-bound, 8 concurrency"]
  Q2 --> W2["worker pool<br/>gpu-bound, 1-2 concurrency"]
  Q3 --> W3["worker pool<br/>cpu-bound, 4 concurrency"]
  Q4 --> W1
  Q5 --> W3
  Q6 --> W4["worker pool<br/>browser pool, 2 concurrency"]
  W1 & W2 & W3 & W4 --> DLQ["dead-letter queue<br/>+ admin alert"]
  W1 & W2 & W3 & W4 -.->|"progress events"| WS["Socket.IO"]
```

| Queue | Typical duration | Retries | Backoff | Concurrency |
|---|---|---|---|---|
| `ingest` | 2–15 min | 3 | exp, 30 s base | 8 |
| `inference` | 1–4 min (GPU) | 2 | exp, 60 s base | 1–2 per GPU |
| `drift` | 30–90 s | 3 | exp, 20 s base | 4 |
| `ais-import` | 1–20 min | 3 | exp, 30 s base | 8 |
| `scoring` | 1–3 s | 3 | exp, 5 s base | 8 |
| `report` | 10–25 s | 2 | exp, 15 s base | 2 |

**Job lifecycle:** `QUEUED → RUNNING → (COMPLETED | FAILED | CANCELLED)`. A `jobs`
document mirrors BullMQ state so the UI can query history after the Redis job is evicted.
Progress is emitted as `{ jobId, pct, stage, message }` on the investigation's Socket.IO
room.

**Idempotency:** each job carries a deterministic `jobKey` (e.g.
`ingest:${productId}`) used as the BullMQ job ID, so a duplicate enqueue is a no-op rather
than a second 1 GB download.

---

## 3.7 Storage architecture

### 3.7.1 Object storage layout

```
s3://varuna/
├── scenes/{productId}/
│   ├── raw/{originalFilename}
│   ├── cog/{polarisation}.tif           # analysis-ready, COG
│   ├── quicklook.png
│   └── manifest.json                    # processing manifest + provenance
├── detections/{detectionId}/
│   ├── classmap.tif                     # argmax class raster (COG)
│   ├── probability.tif                  # per-class probability stack (COG)
│   └── polygons.geojson
├── origin/{originEstimateId}/
│   ├── frames/{isoTimestamp}.tif        # KDE probability surface per step
│   ├── particles.parquet                # full ensemble trajectories
│   └── forcing_manifest.json
├── ais/archive/{source}/{yyyy-mm}/*.parquet
├── models/{sha256}/model.pt             # content-addressed artefacts
└── reports/{reportId}/dossier.pdf
```

**Rule:** the database stores *keys and metadata*, never blobs. Nothing in MongoDB exceeds
the 16 MB document limit, and large geometries are simplified per zoom level at read time.

### 3.7.2 Why Cloud-Optimised GeoTIFF

A Sentinel-1 IW GRD scene is roughly 1 GB. COG with internal tiling and overviews allows:
- **Windowed reads** — inference reads only the tiles it needs via HTTP range requests.
- **Direct tile serving** — TiTiler renders XYZ map tiles from the COG on the fly, so the
  map shows the *real raster*, never a screenshot or a pre-baked image.
- **No full download for display** — the browser never pulls the gigabyte.

---

## 3.8 Realtime architecture

| Namespace | Room | Events | Auth |
|---|---|---|---|
| `/jobs` | `job:{jobId}` | `job:progress`, `job:completed`, `job:failed` | JWT from cookie, verified in the Socket.IO handshake |
| `/investigations` | `inv:{investigationId}` | `investigation:update`, `detection:new`, `candidate:reranked`, `comment:new`, `presence:*` | JWT + membership check |
| `/ais` | `ais:{aoiHash}` | `ais:tick` (batched position updates) | JWT + role ≥ analyst |

The live AIS bridge is a dedicated worker holding one upstream AISStream WebSocket,
filtering by subscribed bounding boxes, batching at 1 Hz, and fanning out to rooms. The
browser never connects to the upstream provider — that would leak the API key.

---

## 3.9 Local development architecture

```yaml
# docker-compose.yml (abridged)
services:
  mongo:       # mongo:7, replica-set enabled (needed for transactions)
  redis:       # redis:7-alpine
  minio:       # object storage + console
  createbuckets: # one-shot: mc mb varuna
  titiler:     # ghcr.io/developmentseed/titiler
  ml:          # build ./services/ml, mounts ./data/models
  api:         # build ./apps/api, depends_on mongo/redis/minio/ml
  worker:      # same image as api, different command
  web:         # vite dev server, proxies /api and /ws
```

`docker compose up` must produce a fully working system on a clean machine using only the
variables in `.env.example`. This is a release criterion (PRD §12.7).

**Demo data pre-staging:** a documented `pnpm run stage:demo` script downloads the *real*
demo-incident scene and the *real* AIS archive slice once, into MinIO and MongoDB, so a
live demo never depends on provider uptime or quota. This is caching real data, not
fabricating it — the provenance records are the originals.

---

## 3.10 Deployment architecture

```mermaid
flowchart TB
  U["Users"] --> CDN["CDN / static host<br/>(Cloudflare Pages)"]
  U --> LB["TLS load balancer"]
  CDN --> WEB["varuna-web<br/>static build"]
  LB --> API1["varuna-api ×N"]
  LB --> TT["varuna-titiler ×2"]
  API1 --> ATLAS[("MongoDB Atlas<br/>replica set")]
  API1 --> UPS[("Redis")]
  API1 --> R2[("Cloudflare R2")]
  API1 -->|internal| MLS["varuna-ml<br/>(GPU node)"]
  WRK["varuna-worker ×M"] --> UPS
  WRK --> ATLAS
  WRK --> R2
  WRK -->|internal| MLS
  TT --> R2
```

| Environment | Purpose | Notes |
|---|---|---|
| `local` | Development | docker compose, MinIO, local Mongo |
| `staging` | Integration + demo rehearsal | Same topology, smaller instances, real providers |
| `production` | Deployment target | Managed Mongo/Redis, R2, GPU node for ML |

**CI/CD (GitHub Actions):**
`lint → typecheck → unit tests → geodesy known-answer tests → real-data policy check → secret scan → build images → integration tests (Testcontainers) → E2E (Playwright) → deploy`.
Model changes additionally run the evaluation gate: the build fails if oil-class IoU drops
below the committed threshold on the held-out real test split.

---

## 3.11 Scaling strategy

| Pressure | Symptom | Response |
|---|---|---|
| More concurrent users | API p95 rises | Add `varuna-api` replicas (stateless) |
| More scenes to process | `inference` queue depth grows | Add GPU workers; batch overnight; use MPC RTC to skip preprocessing |
| More AIS volume | Envelope queries slow | Shard `ais_positions` on `{meta.mmsi hashed, t}`; archive >24 months to Parquet |
| Large slick polygons | Payload size | Server-side simplification by zoom; vector tiles for detections |
| Many map viewers | Tile server load | Cache tiles at the CDN keyed by `{sceneId,z,x,y,rescale}`; TiTiler replicas |
| Provider rate limits | 429s | Circuit breaker + provider fallback chain + request coalescing in Redis |

---

## 3.12 Failure modes and behaviour

| Failure | Detection | Behaviour | User-visible result |
|---|---|---|---|
| Satellite provider down | Circuit breaker opens after 5 consecutive failures | Fall back to next provider in chain (CDSE → MPC → ASF) | Banner: "Primary catalogue unavailable, using Planetary Computer" |
| All satellite providers down | Chain exhausted | Return `UNAVAILABLE` | "Scene catalogue unavailable. Cached scenes remain usable." No fake results. |
| CMEMS/ERA5 unavailable for date | Fetch returns empty/404 | Origin estimate `status: DEGRADED`, `method: FOOTPRINT_PROXIMITY` | Explicit banner + the PDF states the degradation and its effect on confidence |
| No AIS coverage for region | Zero rows returned | Candidate list empty with `reason: NO_AIS_COVERAGE` | "No AIS records for this envelope from the configured sources." Never an empty-looking success. |
| GPU OOM during inference | Exception in ML service | Retry at reduced batch size, then CPU fallback | Progress message: "Retrying at lower batch size" |
| ML service unreachable | Health check + timeout | Job fails with retry; API stays up | Job card shows FAILED with reason and a retry button |
| Mongo primary failover | Driver reconnect | Retryable writes; job retried | Transient slowdown only |
| Redis loss | Connection error | Jobs in flight recovered from the `jobs` collection on restart; new jobs rejected with 503 | "Processing temporarily unavailable" |
| Quota exhausted on a provider key | Quota counter in Redis | Fall through the chain; admin alert | Admin sees the exhausted key; analyst sees the fallback banner |
| Corrupt / non-georeferenced upload | GDAL open fails or transform missing | Reject at ingest | "This file has no georeferencing or acquisition time and cannot be used." |

**The invariant across every row:** no failure path produces a plausible-looking wrong
number. Every one produces an explicit, labelled absence.

---

## 3.13 Security architecture

```mermaid
flowchart LR
  B["Browser"] -->|"TLS 1.3, httpOnly cookies"| LB["Load balancer / WAF"]
  LB --> API["Express API<br/>helmet, CSP, rate limit,<br/>Zod validation, RBAC"]
  API -->|"service token,<br/>private network only"| ML["Python ML"]
  API -->|"TLS + SCRAM"| DB[("MongoDB")]
  API -->|"TLS"| RD[("Redis")]
  API -->|"signed URLs, 15 min TTL"| S3[("Object storage")]
  API -->|"server-side only,<br/>keys never leave"| EXT["External providers"]
  B -.->|"never"| EXT
```

Trust boundaries: the browser is untrusted; the API is the only public trust anchor; the
ML service and datastores are private; provider credentials exist only in the API/worker
process environment.

---

## 3.14 Architecture Decision Records (condensed)

| ADR | Decision | Alternatives rejected | Reason |
|---|---|---|---|
| ADR-001 | MongoDB as primary store, with a Turf/Shapely compute layer | PostGIS | MERN mandate; compensated explicitly rather than silently (TRD §2.6) |
| ADR-002 | Separate Python ML/geo service | Node-only with ONNX + JS geometry | rasterio/Shapely/OpenDrift have no Node equivalent; reimplementation would be the top bug source |
| ADR-003 | MapLibre GL + deck.gl | Leaflet, plain Mapbox | Leaflet cannot render 10^5+ animated points; MapLibre avoids a mandatory token |
| ADR-004 | BullMQ over Redis | Agenda (Mongo-backed), in-process | Mature retries/backoff/DLQ/progress; Redis already needed for cache |
| ADR-005 | Time-series collection for AIS | Standard collection | Order-of-magnitude storage and scan improvement at 10^8+ documents |
| ADR-006 | COG + TiTiler for imagery | Pre-rendered PNG tiles | Serves the real raster; supports windowed inference; no duplicate storage |
| ADR-007 | Additive transparent scoring model | Gradient boosting / neural ranker | Explainability is a product requirement, not a nice-to-have; labels are too scarce to justify a complex model |
| ADR-008 | Lagrangian back-tracking for origin | Assume slick centroid = release point | Centroid assumption is a documented cause of false attribution |
| ADR-009 | Provenance as a required schema field | Provenance as documentation | Only a structural constraint can guarantee the no-fake-data policy |
| ADR-010 | Playwright-rendered PDF | PDFKit / LaTeX | Report typography must match the app exactly; the report route is already built |
| ADR-011 | Vite SPA, not Next.js | Next.js | No SEO or SSR benefit behind auth; SPA keeps the WebGL workstation simple |
| ADR-012 | Zod schemas shared client/server | Separate DTOs | One source of truth eliminates contract drift |
