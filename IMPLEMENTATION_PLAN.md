# 14 — Implementation Plan

**Product:** VARUNA — Vessel Attribution through Remote-sensing & Unified Navigational Analytics
**Problem Statement:** SIH26143
**Document version:** 1.0
**Status:** Baseline for build — companion to [CONTEXT.md](CONTEXT.md) (living status)

> This document is the **build order**. The 13 spec documents say *what* to build and *why*.
> This says *in what sequence*, *by whom*, *with what exit criteria*, and *how each step
> traces back to an MVP item and a release criterion*.
>
> Progress against this plan is tracked in [CONTEXT.md](CONTEXT.md), which is updated
> continuously as work lands. This plan changes only when scope or sequencing changes.

---

## 14.0 How to read this document

| You are… | Read |
|---|---|
| Planning a sprint | §14.6 (phases) + §14.7 (critical path) + [CONTEXT.md](CONTEXT.md) status board |
| Picking up a task | The relevant phase in §14.6 — each task cites the exact spec section |
| Checking we are on track for the demo | §14.8 (MVP traceability) + §14.9 (release criteria) |
| Onboarding | §14.1 → §14.4, then your workstream's phases |

**Conventions**

- `[FE]` frontend · `[BE]` backend · `[ML]` ML/geo service · `[DevOps]` infra/CI/data · `[All]` cross-cutting.
- "Exit criteria" are binary and testable. A phase is not done until every box is checkable.
- Spec references use the doc number and section, e.g. `06_BACKEND §6.6.2`.
- Every phase inherits the **Real-Data Policy** ([13_REAL_DATA_POLICY.md](13_REAL_DATA_POLICY.md)) as a non-negotiable acceptance gate.

---

## 14.1 Guiding constraints (carried from the specs — do not relitigate)

| # | Constraint | Source |
|---|---|---|
| C1 | Zero mock/fake/synthetic/placeholder data anywhere — product, demo, screenshots, metrics, training. | 13 (all) |
| C2 | Every persisted observed/derived object has a required `provenance` sub-document; UI refuses to render without one. | 02 §2.7, 06 §6.3.1, 13 §13.4 |
| C3 | Any module that cannot get real data returns explicit `UNAVAILABLE` / `DEGRADED` with a reason — never a default value. | 02 TR-9, 03 §3.12, 07 §7.3.6 |
| C4 | Storage geometry is GeoJSON EPSG:4326 `[lon,lat]`, right-hand-wound. Measurement is geodesic or equal-area, never degrees. | 02 TR-2/TR-3, 06 §6.3.2 |
| C5 | All timestamps ISO-8601 UTC with explicit `Z`, everywhere internal. | 02 TR-1, 04 §4.2.2 (T4) |
| C6 | Nothing slow in a request: > ~10 s ⇒ queued job with id, progress stream, cancel, terminal state. | 02 TR-5, 03 §3.1 |
| C7 | The browser never holds a third-party provider credential; all provider calls proxied server-side. | 02 TR-7, 11 §11.9 |
| C8 | Scoring model M3 stays transparent/low-capacity; renormalise over **measured** features only; `INSUFFICIENT_EVIDENCE` is first-class with a 6-feature floor. | 02 §2.8.5, 07 §7.5.2, 12 F-14/F-16 |
| C9 | Model artefacts content-addressed (SHA-256); hash recorded in every inference result and report. | 02 TR-10, 07 §7.7 |
| C10 | MERN owns the product; Python is a compute sidecar behind an internal HTTP boundary with a service token, never public. | 03 §3.3.1, 06 §6.1 |
| C11 | Branded units (`Longitude`, `Latitude`, `Kilometres`, `SquareKm`, …). No bare `number` for distance/area/speed/bearing. | 02 §2.6.4, 05 §5.2 |
| C12 | Accessibility WCAG 2.1 AA on the workspace; no info by hue alone; full `prefers-reduced-motion`. | 01 NFR-15..17, 04 §4.10 |

---

## 14.2 Monorepo layout (target)

pnpm workspaces + Turborepo-style task graph. Created in Phase 0, filled in later phases.

```
varuna/
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json                   # or nx / npm scripts; task pipeline for CI
├── .env.example                 # 11 §11.6, complete
├── .github/workflows/ci.yml     # 03 §3.10 pipeline
├── docker-compose.yml           # 03 §3.9 — mongo(rs), redis, minio, titiler, ml, api, worker, web
├── scripts/
│   ├── check-real-data-policy.sh # 13 §13.6 (required PR status check)
│   ├── stage-demo.(ts|sh)        # 03 §3.9, 13 §13.10 — pnpm run stage:demo
│   └── tokens-sync-check.ts      # 04 §4.13 — tokens.css ↔ tokens.ts
├── packages/
│   └── shared/                   # Zod schemas + branded types + constants + known-answer fixtures
│       └── src/schemas/*.ts      # 02 §2.4 canonical contracts, mirrored to Pydantic
├── apps/
│   ├── web/                      # 05 FRONTEND (React 18 + Vite + MapLibre + deck.gl + R3F)
│   ├── api/                      # 06 BACKEND (Express 5 + Mongoose 8 + BullMQ + Socket.IO)
│   └── worker/                   # same image/code as api, different entrypoint (BullMQ consumers)
├── services/
│   └── ml/                       # 07 AIML (FastAPI + PyTorch + rasterio + OpenDrift), 03 §3.5.2 layout
├── data/                         # 10 §10.9.1 — raw/ processed/ manifests/ (git-ignored blobs)
└── docs/                         # 00–15 (this suite)
```

**Rule:** `apps/api` and `apps/worker` share a single build; `services/ml` is independent.
`packages/shared` is the only cross-language contract source (Zod → TS types + a generated
Pydantic mirror, checked in CI).

---

## 14.3 Workstreams & ownership

| Workstream | Owns | Primary docs |
|---|---|---|
| **[FE]** | `apps/web`, design tokens, map/3D/timeline, all screens, client provenance guard | 04, 05, 08 |
| **[BE]** | `apps/api`, `apps/worker`, Mongoose models, provider clients, queues, Socket.IO, reports, auth/RBAC/audit | 03, 06, 02 |
| **[ML]** | `services/ml`, M1 segmentation, M2 drift, M3 scoring, preprocessing, geodesy, model registry, MLflow | 07, 10 |
| **[DevOps]** | monorepo, docker-compose, CI, env validation, account/key register, `stage:demo`, load/perf harness, deploy | 03, 11, 13 |
| **[Data]** | dataset acquisition, demo-incident selection & coverage verification, provenance capture, ground-truth assembly | 10, 13 |

A team smaller than five: **[Data]** folds into **[ML]**, **[DevOps]** folds into **[BE]**.

---

## 14.4 Tooling baseline (Phase 0 sets this once)

| Concern | Choice | Notes |
|---|---|---|
| Package manager | pnpm ≥ 9 | workspaces; `pnpm run stage:demo` is a documented script |
| Node | 20 LTS | native fetch, test runner |
| Python | 3.11 | `services/ml` only; `uv` or `poetry` for deps |
| TS config | strict, `noUncheckedIndexedAccess`, path aliases to `@varuna/shared` | 02 §2.2 |
| Lint/format | ESLint + Prettier (JS/TS), Ruff + Black (Py) | custom lint rule: ban `$near` vs polygon (02 §2.6.4); ban bare-number geo params (05 §5.2) |
| Test | Vitest + Testing Library + Playwright (JS), pytest (Py), k6 (load), axe-core (a11y) | 02 §2.15 |
| Contracts | Zod in `packages/shared`; `zod-to-openapi` on the server; Pydantic mirror generated + diff-checked | 02 §2.2.2, 06 §6.4 |
| CI | GitHub Actions: `lint → typecheck → unit → geodesy known-answer → real-data policy → secret scan (gitleaks) → build images → integration (Testcontainers) → E2E (Playwright) → [model eval gate] → deploy` | 03 §3.10 |
| Error/obs | Sentry (client+server), pino → JSON, MLflow (self-hosted, in compose) | 02 §2.12 |
| Secrets | `env.ts` Zod-validated, `process.exit(1)` on missing required; `.env` git-ignored; gitleaks pre-commit | 11 §11.7, §11.9 |

---

## 14.5 Phase map at a glance

| Phase | Title | Depends on | Indicative window | Blocking for demo? |
|---|---|---|---|---|
| **0** | Foundations, accounts, data acquisition kickoff | — | Week 1 | ✅ |
| **1** | Data-plane spine: models, provenance, geodesy | 0 | Week 1–2 | ✅ |
| **2** | Platform: auth, RBAC, investigations, jobs, realtime | 1 | Week 2 | ✅ |
| **3** | Providers + live catalogue search | 2 | Week 2–3 | ✅ |
| **4** | ML service + SAR preprocessing + scene ingest E2E | 1, 3 | Week 3 | ✅ (M1) |
| **5** | M1 oil-slick segmentation (train + infer + vectorise + eval) | 0(data), 4 | Week 3–5 | ✅ (M2, M3, M11) |
| **6** | Detections module (BE + FE review workflow) | 4, 5 | Week 4–5 | ✅ |
| **7** | Environmental data + M2 backward drift + origin field | 4 | Week 4–6 | ✅ (M4, M5) |
| **8** | AIS ingestion + track reconstruction | 1, 2 | Week 4–6 | ✅ (M6, M7) |
| **9** | M3 attribution scoring + correlation job + candidates | 5, 7, 8 | Week 6–7 | ✅ (M8) |
| **10** | Workspace UI shell: map subsystem, stores, timeline, screens | 2, 6 | Week 5–8 (parallel) | ✅ (M9, M12) |
| **11** | 3D surfaces: globe, slick relief, space-time prism | 7, 8, 10 | Week 8–9 | ⚠️ prism is demo-valuable |
| **12** | Reporting & exports (PDF, GeoJSON, CSV, manifest) | 9, 10 | Week 8–9 | ✅ (M10) |
| **13** | Demo staging, integration, E2E, load, a11y, hardening, rehearsal | all | Week 9–10 | ✅ |

Phases 5, 7, 8, 10 run **in parallel** once their dependencies land — this is the whole
reason the workstreams are separated.

---

## 14.6 Phases in detail

### Phase 0 — Foundations, accounts, data acquisition kickoff

**Goal:** a clean-machine `docker compose up` reaches a running (empty) system; every
required account exists; the dataset request and demo-incident verification are in flight.

**Depends on:** nothing.

**Workstreams:** [DevOps] lead, [All] support.

**Tasks**

- [ ] `[DevOps]` Scaffold the monorepo per §14.2: pnpm workspaces, TS base config, ESLint/Prettier, Ruff/Black, Husky + gitleaks pre-commit.
- [ ] `[DevOps]` `docker-compose.yml` with `mongo:7` (replica set `rs0`, required for transactions), `redis:7-alpine` (`--maxmemory-policy noeviction` — 11 A10 constraint), `minio` + `createbuckets`, `titiler`, plus service stubs `ml`, `api`, `worker`, `web`. (03 §3.9)
- [ ] `[DevOps]` `.env.example` — the complete file from 11 §11.6, every key with a non-functional placeholder.
- [ ] `[BE]` `apps/api/src/env.ts` — Zod schema from 11 §11.7; `assertProviderChains()` warns (does not exit) on empty chains.
- [ ] `[DevOps]` `.github/workflows/ci.yml` skeleton running: install → lint → typecheck → `scripts/check-real-data-policy.sh` → gitleaks. (13 §13.6 script authored now, even if some checks are no-ops until later.)
- [ ] `[DevOps]` `packages/shared` package created; wire the Pydantic-mirror generation + diff check into CI (no schemas yet).
- [ ] `[DevOps]` MLflow service added to compose (self-hosted, zero-key — 11 C6).
- [ ] `[Data]` **Submit the MKLab/CERTH Oil Spill Detection Dataset request form** (10 §10.2.1). This is the single hardest blocker to unblock late. Queue the SOS / Deep-SAR secondary in parallel.
- [ ] `[DevOps]` Register every Tier-A account and run each doc's "tested" step from the 11 §11.11 checklist: CDSE (OAuth client + token exchange), Planetary Computer (anon STAC query), NASA Earthdata (register + **accept EULAs**), CMEMS, CDS/ERA5 (**accept the ERA5 licence on the dataset page**), GFW (**request early — days to approve**), AISStream, MongoDB (local rs), MinIO, Redis (verify noeviction), Sentry.
- [ ] `[Data]` Shortlist 3 demo incidents (10 §10.6.2) and **verify Sentinel-1 coverage AND free historical AIS coverage** for each (Danish- or US-waters first per 10 §10.6 recommendation; Ennore/Chennai for national relevance). Record findings in [CONTEXT.md](CONTEXT.md).
- [ ] `[Data]` Download small AIS samples (Marine Cadastre + Danish DMA) and confirm schemas against the 10 §10.4.6 field reference.
- [ ] `[All]` Every contributor signs the 13 §13.11 acknowledgement (record in [CONTEXT.md](CONTEXT.md)).

**Deliverables:** running compose stack; green skeleton CI; `.env.example`; account register with "tested" ticks in [CONTEXT.md](CONTEXT.md); demo-incident decision memo.

**Exit criteria**

- [ ] `git clone && cp .env.example .env && docker compose up` on a clean machine brings up all containers healthy (services may return 501/empty — that is fine).
- [ ] CI runs and passes on an empty PR.
- [ ] All Tier-A credentials obtained and each provider's smoke test in 11 §11.11 passes, **or** the gap is logged in [CONTEXT.md](CONTEXT.md) with an owner and date.
- [ ] One demo incident selected with **both** S-1 and free AIS coverage confirmed; a backup incident identified.
- [ ] MKLab request submitted (timestamp recorded).

---

### Phase 1 — Data-plane spine: models, provenance, geodesy

**Goal:** the schema and correctness foundation everything else writes through. If this is
wrong, every number downstream is wrong.

**Depends on:** Phase 0.

**Workstreams:** [BE] lead, [ML] for the pyproj half of geodesy, [FE] for the client guard.

**Tasks**

- [ ] `[BE]` `packages/shared/src/schemas`: implement every canonical contract from 02 §2.4 in Zod — `Provenance`, `SatelliteScene`, `SpillDetection`, `AisPosition`, `VesselTrack`, `OriginEstimate`, `CandidateVessel`. No `MOCK`/`SYNTHETIC`/`TEST`/`DEMO` in any enum (13 §13.4 L1).
- [ ] `[BE]` Branded unit types + constructors in `packages/shared` (`Longitude`, `Latitude`, `Kilometres`, `Metres`, `SquareKm`, `Knots`, `DegreesTrue`, `UtcIso`) with range checks. (05 §5.2)
- [ ] `[BE]` Generate the Pydantic mirror for `services/ml`; CI diff check fails on drift.
- [ ] `[BE]` Mongoose: `provenancePlugin` + `ProvenanceSchema` with `pre('validate')` (06 §6.3.1); `PointSchema` / `PolygonSchema` / `LineStringSchema` with **closed-ring + right-hand-rule validators** (06 §6.3.2); `@turf/rewind` normaliser on write.
- [ ] `[BE]` All collections + indexes from 02 §2.5.1. Migration/bootstrap script that **creates `ais_positions` as a time-series collection** (`timeField:'t'`, `metaField:'meta'`, `granularity:'seconds'`) with the three indexes from 06 §6.3.3 — this cannot be done via model sync.
- [ ] `[BE]` `provenance_records` collection (immutable) + `provenanceService.record()` returning an id; `audit_log` collection (append-only) + `audit()` helper.
- [ ] `[BE]` `provenanceGuard` response middleware: strip + log + raise `ProvenanceError` (severity-1) for provenance-required types lacking provenance. (06 §6.2, 13 §13.4 L3)
- [ ] `[BE]` `lib/`: `mongo.ts`, `redis.ts`, `s3.ts` (signed URL helper, 15-min TTL), `logger.ts` (pino + redaction list from 11 KEY-5), `mlClient.ts` (X-Service-Token).
- [ ] `[BE]` `geo/units.ts`, `geo/envelope.ts` (`turf.buffer` + `turf.rewind`), `geo/trackGeometry.ts` (`pointToLineDistance`, `nearestPointOnLine`, `length`).
- [ ] `[ML]` `geo/geodesy.py`, `geo/projections.py` (WGS84 `pyproj.Geod` area/perimeter; local equal-area for morphology/intersection).
- [ ] `[All]` **Known-answer geodesy suite** in both Vitest and pytest: fixed reference distances/areas (London→New York 5,570 km ±5 km; 1°×1° equatorial cell ≈ 12,308 km²; more). CI gate: the two stacks must agree within 0.1%. (02 §2.6.4, §2.15)
- [ ] `[BE]` Polygon-winding test: a wrongly-wound polygon is rejected/rewound, and an explicit test asserts `$geoWithin` on it does **not** match the whole world. (06 §6.11, 12 F-10)
- [ ] `[FE]` `lib/provenance.ts` (`assertProvenance`) + `<DataObject>` boundary component rendering the deliberately-ugly `PROVENANCE MISSING` state. (05 §5.7, 13 §13.4 L4)
- [ ] `[DevOps]` Flesh out `check-real-data-policy.sh` checks 1, 2, 6 (dep scan, forbidden `sourceType` literals, provenancePlugin applied to the six models).

**Exit criteria**

- [ ] Every 02 §2.4 contract exists in Zod, exported from `@varuna/shared`, with a passing round-trip test.
- [ ] Pydantic mirror generated; CI drift check green.
- [ ] `ais_positions` verified as time-series (`db.getCollectionInfos`) with all three indexes.
- [ ] Saving any provenance-required model **without** complete provenance throws at `pre('validate')`; a unit test proves it.
- [ ] Geodesy known-answer suite passes in **both** stacks within 0.1%; wired as a CI gate.
- [ ] Winding test proves the "matches the whole planet" bug is caught.
- [ ] `<DataObject>` renders the error state for an unprovenanced object (component test).
- [ ] Geodesy + `provenanceService` + `geo/` at 100% unit coverage (02 §2.15).

---

### Phase 2 — Platform: auth, RBAC, investigations, jobs, realtime

**Goal:** a user can register, log in, create an investigation with a validated AOI/window,
and the job + WebSocket plumbing exists for later phases to hang work on.

**Depends on:** Phase 1.

**Workstreams:** [BE] lead, [FE] for auth + investigation-list + create-wizard screens.

**Tasks**

- [ ] `[BE]` Middleware chain exactly in the order of 06 §6.2: `requestId → pino-http → helmet(CSP) → cors → json(2mb) → cookieParser → mongoSanitize → rateLimit → authenticate → router(rbac+validate) → provenanceGuard → errorHandler`.
- [ ] `[BE]` Auth module (06 §6.4.1): `register`, `login`, `refresh`, `logout`, `me`. Argon2id (`memoryCost ≥ 19456`, `timeCost ≥ 2`); JWT access 15 min + refresh 7 d rotated-on-use, SHA-256-hashed server-side, reuse ⇒ revoke; both cookies `httpOnly; Secure; SameSite=Strict`. (02 SEC-1/2, 06 §6.9)
- [ ] `[BE]` `rbac(role)` middleware (`viewer|analyst|lead|admin`, deny by default) + resource-level `canAccessInvestigation(user, id)` on every scoped route. (02 SEC-3)
- [ ] `[BE]` `validate(schema)` Zod boundary middleware, `.strict()` (unknown keys rejected). RFC 9457 `application/problem+json` error handler with `requestId`, plus typed branches for `ZodError`, `ProviderUnavailable`, `ProvenanceError`. (06 §6.10)
- [ ] `[BE]` Investigations module (06 §6.4.2): CRUD, `/summary`, `/members`, `/audit`, `/comments`. AOI area via `turf.area` → reject > 50,000 km² with the actual figure in `detail`; window capped at 30 days; `reportedIncidentAt` seeds the release-window prior. Immutable id + audit entry on create. AOI/window PATCH invalidates downstream results and says so.
- [ ] `[BE]` `jobs` collection mirror + BullMQ queue definitions for all six queues (03 §3.6): `ingest, inference, drift, ais-import, scoring, report` with per-queue retry/backoff/concurrency from the 03 §3.6 table, deterministic `jobKey` idempotency, DLQ + admin alert. Job lifecycle `QUEUED→RUNNING→(COMPLETED|FAILED|CANCELLED)` + `RETRYING`.
- [ ] `[BE]` Jobs API (06 §6.4.10): list/get/cancel/retry. Admin API stubs: users/role, quotas, providers, audit, `/health`, `/health/deep`.
- [ ] `[BE]` Socket.IO (06 §6.7): handshake JWT verify; namespaces `/jobs`, `/investigations`, `/ais`; room join with membership check; worker→API progress bridge over Redis pub/sub.
- [ ] `[BE]` Rate limits: global 100/min/IP, auth 10/min/IP, job creation 20/h/user, catalogue 60/h/user. (06 §6.9)
- [ ] `[BE]` `zod-to-openapi` → served spec; CI OpenAPI diff check. (06 §6.11)
- [ ] `[BE]` RBAC matrix test: every route × every role. (06 §6.11)
- [ ] `[FE]` Screens: `/login`, `/register` (05 §5.5.1); `/investigations` list (virtualised, URL-reflected filters, prefetch-on-hover — 05 §5.5.3); `/investigations/new` 4-step wizard with **live geodesic AOI readout** and **live catalogue preview before creation** (05 §5.5.4).
- [ ] `[FE]` `api/client.ts` wrapper: `credentials:'include'`, `X-Request-Id`, problem+json parsing, 401 → auth store, `assertProvenance(data)` before return. (05 §5.6.1)
- [ ] `[FE]` `SocketProvider` mapping job-completion events → `queryClient.invalidateQueries` (05 §5.8).

**Exit criteria**

- [ ] Register → login → `me` round-trips; refresh rotation works; reused refresh token is revoked (test).
- [ ] Every route is behind `rbac` + (where scoped) `canAccessInvestigation`; RBAC matrix test green.
- [ ] Creating an investigation with a 60,000 km² AOI is rejected with the real area in the error; a 45-day window is rejected.
- [ ] A no-op test job flows `QUEUED→RUNNING→COMPLETED` with progress events arriving on the investigation room; duplicate enqueue with the same `jobKey` is a no-op.
- [ ] OpenAPI spec served; diff check wired.
- [ ] Create-wizard step 4 shows a real catalogue count (uses Phase 3 endpoint once available; stub until then behind a flag).
- [ ] axe-core: zero critical/serious on `/login`, `/investigations`, `/investigations/new`.

---

### Phase 3 — Providers + live catalogue search

**Goal:** the analyst searches real satellite catalogues and sees real product IDs, with
per-provider status visible.

**Depends on:** Phase 2.

**Workstreams:** [BE] lead, [FE] for the catalogue panel.

**Tasks**

- [ ] `[BE]` `ProviderClient` base (06 §6.5): circuit breaker (5 failures / 60 s reset), retry (3× exp, factor 2, retry on transient + 429), Redis-backed `QuotaTracker` (11 §11.8, soft limits table), never logs secrets.
- [ ] `[BE]` `CdseClient` with OAuth2 client-credentials + Redis token cache (60 s safety margin, 06 §6.5.2); `PlanetaryComputerClient` (anon STAC + `planetary-computer` SAS signing); `AsfClient` (Earthdata bearer).
- [ ] `[BE]` Provider chains config (06 §6.5.1): `SATELLITE_CATALOGUE`, `SATELLITE_DOWNLOAD` (MPC RTC first), `OCEAN_CURRENTS`, `WIND`, `AIS_HISTORICAL`, `AIS_LIVE`. **Chain semantics:** `ProviderUnavailable` advances; a data-level "no results" does **not** advance. Exhaustion ⇒ structured problem+json stating the **consequence** (06 §6.5.1).
- [ ] `[BE]` Catalogue module (06 §6.4.3): `GET /catalogue/search` fans out to the chain in parallel, normalises heterogeneous STAC/OData → one shape, dedupes by `productId`, returns `items[]` + `providerStatus[]` (per-provider OK / CIRCUIT_OPEN / latency / count). `GET /catalogue/providers` health. Nothing persisted.
- [ ] `[BE]` Admin provider-health endpoint returns circuit state, quota consumed, p95 latency, last success. (02 §2.12, 06 §6.4.10)
- [ ] `[BE]` Fixtures: capture **real** CDSE + MPC + ASF search responses into `__fixtures__/real/` each with a `.provenance.json` sibling (13 §13.7). CI check 3 now enforceable.
- [ ] `[FE]` Catalogue panel (05 §5.5.5): results table (platform, mode, polarisation, acquiredAt UTC, footprint overlap %, cloud cover for optical); **hover a row → highlight its footprint on the map**; provider-status strip; zero-results is a clear, non-error empty state (04 §4.11).
- [ ] `[FE]` Wire the create-wizard step-4 preview to the real endpoint.

**Exit criteria**

- [ ] A live `GET /catalogue/search` over the demo AOI/window returns real Sentinel-1 product IDs from at least one provider; `providerStatus` reflects reality.
- [ ] Killing the primary provider (fault injection) advances the chain and surfaces a banner; a genuinely empty AOI returns an empty list, not a fallback.
- [ ] Chain exhaustion returns problem+json with `attempted[]` and a `consequence` string.
- [ ] Quota counter increments in Redis and is visible in the admin panel; 80% threshold warns.
- [ ] No provider secret appears in any log (redaction test) or in any client bundle (Vite build check).

---

### Phase 4 — ML service + SAR preprocessing + scene ingest E2E

**Goal:** select a real scene → ingest job runs → COG + processing manifest in object
storage → `SatelliteScene` persisted `READY` → real raster tiles render on the map. **This
is MVP item M1.**

**Depends on:** Phase 1 (contracts), Phase 3 (resolve productId).

**Workstreams:** [ML] lead, [BE] for the job + scenes module, [FE] for the SAR layer.

**Tasks**

- [ ] `[ML]` FastAPI app (03 §3.5.2 layout): `main.py` with `X-Service-Token` auth, `config.py` (pydantic-settings), `provenance.py` (every response carries provenance), `routers/health.py` returning `{status, gpu, modelLoaded, forcingCacheAge}`.
- [ ] `[ML]` `sar/preprocess.py`: SNAP `gpt` graph chain (03 §2.8.1 / 07 §7.2.4 steps 1–8) **or** MPC RTC passthrough (manifest records `preprocessing: 'MPC_RTC'` + provider metadata). Every step recorded in the processing manifest.
- [ ] `[ML]` `sar/cog.py` (`rio cogeo create`, deflate, 512 blocks, overviews), `sar/landmask.py` (GSHHG/OSM coastline — vendored per 11 B6), `geo/` reused from Phase 1.
- [ ] `[ML]` `POST /preprocess` → `{ cogKeys, manifest, crs, gsdMeters, checksum }`. Rejects a scene it cannot open/georeference (no CRS/transform/acquisition time) — never defaults. (01 A4, 03 §3.12)
- [ ] `[ML]` `POST /download` (or fold into preprocess) using the `SATELLITE_DOWNLOAD` chain (MPC RTC first).
- [ ] `[BE]` Scenes module (06 §6.4.4): `POST /scenes/ingest` (202 + jobId, **idempotent on productId**), `POST /scenes/upload` (multipart GeoTIFF; extension → magic bytes → `gdalinfo` open → CRS + transform + acquisition time present, else reject — 06 §6.9 SEC-7), list/get, `GET /scenes/:id/tiles` (signed TiTiler URL template + bounds + zoom + defaultRescale), `/quicklook`, delete (blocked if detections reference it).
- [ ] `[BE]` `ingestScene` job (06 §6.6.1): resolve → download → `mlClient.preprocess` → `provenanceService.record({sourceType:'SATELLITE_SCENE', …, checksum})` → `SatelliteScene.findOneAndUpdate({productId}, …, {upsert})` `status:'READY'` → progress events at each stage.
- [ ] `[BE]` TiTiler proxy route `/tiles/...` with signed, expiring URLs (02 SEC-11).
- [ ] `[DevOps]` Object-storage layout under `s3://varuna/scenes/{productId}/…` per 03 §3.7.1.
- [ ] `[FE]` `map/layers/sarRasterLayer` — deck.gl `TileLayer` + `BitmapLayer` pointing at the signed TiTiler template; user-controlled rescale window + opacity slider (05 §5.4.4). Provenance chip on the layer.
- [ ] `[BE/ML]` Integration test (Testcontainers Mongo+Redis+MinIO): ingest one **real cached** demo scene end to end.

**Exit criteria (== MVP M1)**

- [ ] From the catalogue panel, selecting a real Sentinel-1 product and clicking Ingest runs a job to `COMPLETED` with visible stages.
- [ ] `SatelliteScene` doc exists with `status:'READY'`, full `stacItem` verbatim, a processing manifest key, and a valid `provenance` record whose `externalId` is the real product ID.
- [ ] The map shows the **real SAR raster** served tile-by-tile from the COG (not a screenshot); rescale + opacity work.
- [ ] Re-running the same ingest is a no-op (no duplicate download, no duplicate doc). (01 NFR-10)
- [ ] A non-georeferenced upload is rejected with the 04 §4.11 wording.
- [ ] Ingest integration test green in CI.

---

### Phase 5 — M1 oil-slick segmentation

**Goal:** a trained 5-class model produces a slick mask on a real scene; the mask becomes a
georeferenced polygon with real km² and morphology; held-out metrics meet MVP targets.
**MVP items M2, M3, M11.**

**Depends on:** Phase 0 (MKLab dataset approved — or secondary datasets in use), Phase 4 (COG pipeline).

**Workstreams:** [ML] lead, [Data] for label QA.

**Tasks**

- [ ] `[Data/ML]` Dataset acquisition (10 §10.2): MKLab/CERTH primary; SOS / Deep-SAR secondary; verify provenance for any mirror (10 §10.2.3) or **reject**.
- [ ] `[ML]` `data/manifests/dataset_manifest.yaml` (07 §7.4.5) + `validate_manifest()` — training refuses to start on any incomplete entry or declared non-real content. Wire CI check 5 (13 §13.6).
- [ ] `[ML]` Dataset loader: 3-channel input `[VV_dB, VH_dB, VV−VH]`, **per-scene robust scaling** (2nd/98th pct over valid water — 07 §7.2.5), 256×256 tiles / stride 192. **Split by scene and geography, never by random tile**, 70/15/15 (07 §7.2.12).
- [ ] `[ML]` Augmentation: label-preserving only (hflip, vflip, rot90, random crop, ±10% brightness jitter, sensor-consistent speckle). Forbidden list enforced by manifest cross-check. (07 §7.4.4, 13 §13.3.3)
- [ ] `[ML]` `models/architectures.py`: U-Net (ResNet-34), U-Net++ (ResNet-34), DeepLabV3+ (ResNet-50), SegFormer-B2 — via `segmentation_models_pytorch` / `transformers`. First-conv adapted 3→3 by weight averaging.
- [ ] `[ML]` `OilSegLoss` = 0.5·Dice + 0.5·Focal(γ=2), inverse-frequency class weights (mean-1, clip 12). (07 §7.2.7)
- [ ] `[ML]` Training protocol (07 §7.2.8): AdamW `3e-4` / wd `1e-4`, cosine + 3-epoch warmup, batch 16 AMP fp16, 120 epochs early-stop on val oil-IoU (patience 15), encoder frozen 3 epochs, grad clip 1.0, **3 seeds per architecture**, MLflow logs params/metrics/dataset-manifest-hash/git-SHA/artefact-SHA-256.
- [ ] `[ML]` Evaluation (07 §7.2.12): oil IoU, oil Dice/F1, oil precision, **oil recall** (threshold tuned to favour recall), mean IoU (5 classes), **look-alike→oil confusion rate**, boundary F1 (2 px), per-scene detection rate. **Never report pixel accuracy.** Report mean ± std over seeds.
- [ ] `[ML]` Pick the shipped architecture by evaluation (oil-IoU **and** latency budget < 4 min GPU / < 20 min CPU — 01 NFR-3), not by assertion.
- [ ] `[ML]` `models/inference.py`: tiled inference with **cosine (Hann) window blending**, AMP; write argmax classmap COG **and** full per-class probability COG. (07 §7.2.9, 12 F-03)
- [ ] `[ML]` `models/postprocess.py` (07 §7.2.10): morphological open (3×3) + close (7×7), min-area 0.05 km² (**geodesic**), min mean oil prob 0.60; `rasterio.features.shapes` → polygons; `simplify(tol=20 m)` + `rewind`.
- [ ] `[ML]` `geo/morphology.py` `compute_morphology()` (07 §7.2.10): minimum rotated rectangle → major/minor axis km, elongation ratio, orientation bearing (mod 180), convexity, centroid — on a local equal-area projection.
- [ ] `[ML]` `wind_suitability(u10)` piecewise trapezoid (07 §7.2.3) and `detection_confidence()` four-term model (07 §7.2.11) — all four terms returned separately.
- [ ] `[ML]` `models/registry.py` — content-addressed by weights SHA-256; `register_model()` writes metrics-on-real-test-split, dataset manifest hash, git SHA, `realDataOnly:true`. (07 §7.7, C9)
- [ ] `[ML]` `POST /segment` and `POST /vectorise` per the 07 §7.8 contract; every response carries provenance and `modelSha`.
- [ ] `[DevOps]` **CI model-evaluation gate** (03 §3.10): a model may not be promoted if oil-IoU on the held-out real test split drops below the committed threshold, or look-alike→oil confusion rises above its threshold, versus the deployed model.

**Exit criteria (== MVP M2, M3, M11)**

- [ ] `validate_manifest()` passes for the real dataset; CI check 5 green.
- [ ] All four architectures trained under the identical protocol; comparison table (mean ± std over 3 seeds) recorded in MLflow and [CONTEXT.md](CONTEXT.md).
- [ ] Shipped model meets MVP targets on the **held-out, geographically-disjoint real test split**: oil IoU ≥ 0.55, oil Dice/F1 ≥ 0.70, oil recall ≥ 0.75, mean IoU ≥ 0.60, look-alike→oil FP rate ≤ 0.20. (01 §9.1)
- [ ] Inference on one real Sentinel-1 IW GRD scene < 4 min (T4-class GPU) / < 20 min (CPU).
- [ ] `/segment` on a real ingested scene returns polygons with **geodesic** km² area, morphology, four-term confidence, `maskKey` + `probabilityKey` COGs, `modelSha`.
- [ ] No tile seams in the output mask (visual + boundary-F1 check).
- [ ] Model registered content-addressed; the SHA appears in the `/segment` response.
- [ ] Model-eval CI gate active and blocking.

---

### Phase 6 — Detections module (BE + FE review workflow)

**Goal:** run detection from the UI, see slick polygons on the map, review them
(confirm/reject/edit) with the model output kept immutable.

**Depends on:** Phase 4, Phase 5.

**Workstreams:** [BE] + [FE] jointly.

**Tasks**

- [ ] `[BE]` Detections module (06 §6.4.5): `POST /detections/run` (202 + jobId), list, get, `GET /detections/:id/geometry` (`?simplify=z{zoom}`, `ETag` + `If-None-Match`), `POST /detections/:id/review` (`CONFIRM|REJECT|EDIT`, reason required for reject, geometry for edit — **new version, never mutate model output**), `/versions`, `/probability-tiles` (signed TiTiler template for the probability raster).
- [ ] `[BE]` Detection job: enqueue on `inference` queue → `mlClient.segment(cogKeys)` → persist `SpillDetection` with `provenance.derivedFrom = [scene.provenance, modelArtefactSha]`, `reviewStatus:'UNREVIEWED'`. Progress stages `TILING→INFERENCE→BLENDING→POSTPROCESS→VECTORISE` (08 §8.2 step 3).
- [ ] `[BE]` Fetch **real wind at acquisition time/location** (ERA5/GFS) for the `windSuitability` term — via the `WIND` chain; degrade-labelled if unavailable.
- [ ] `[FE]` Slick polygon layer (05 §5.4.4): `--oil-500` fill 0.22, 2 px stroke + 1 px dark halo (second `PathLayer` beneath), **hatch pattern when `reviewStatus = UNREVIEWED`**.
- [ ] `[FE]` Detections panel list (area km² geodesic, confidence, review status, morphology); select → fly-to.
- [ ] `[FE]` Detection review screen (05 §5.5.6): header (area, confidence breakdown, model name + version + **artefact hash in mono**); four-bar confidence panel each with raw value + `<MethodologyNote>`; probability overlay blend slider; morphology with the major axis drawn on the map; review actions; **edit creates a new version, original immutable, both in history**; `<ImageryComparator>` vs the previous acquisition over the same footprint.
- [ ] `[FE]` `<MethodologyNote id>` component (version-stamped, reused verbatim in the PDF later).
- [ ] `[BE/FE]` Extend the Testcontainers integration test through detect on the cached real scene.

**Exit criteria**

- [ ] `Run detection` on the demo scene produces polygon(s) on the map, hatched as unreviewed, with geodesic area.
- [ ] Confidence panel shows **four separate terms** including wind suitability computed from real ERA5/GFS wind at acquisition.
- [ ] Confirm/Reject/Edit each write a new immutable version with actor + timestamp; the original model output is still retrievable via `/versions`.
- [ ] Before/after comparator shows two real acquisitions with their true timestamps pinned.
- [ ] `geometry` endpoint honours `ETag` and `?simplify=z{zoom}`.
- [ ] axe-core green on the detection review screen.

---

### Phase 7 — Environmental data + M2 backward drift + origin field

**Goal:** back-track the reviewed slick over real currents + winds to an **origin
probability surface** with 50/90 contours and a **release-time window**. Degrade loudly
when forcing is missing. **MVP items M4, M5.**

**Depends on:** Phase 4 (ML service), Phase 6 (a reviewed detection to seed from).

**Workstreams:** [ML] lead, [BE] for the origin module + job, [FE] for the origin panel + layers.

**Tasks**

- [ ] `[ML]` `drift/forcing.py`: `copernicusmarine` subset for CMEMS `GLOBAL_ANALYSISFORECAST_PHY_001_024` (`uo`/`vo`, surface, hourly, 1/12°); `cdsapi` for ERA5 `10m_u/v_component_of_wind` (0.25°, hourly); NOAA GFS fallback (no key). Space+time interpolation. Local cache with provenance (`OCEAN_MODEL` / `ATMOSPHERIC_MODEL`).
- [ ] `[ML]` `drift/backtrack.py`: **OpenDrift** `OceanDrift` / `OpenOil` with negative `time_step` (backward). Per-particle sampled `α ~ U(0.02,0.04)`, `θ ~ U(0°,20°)` (hemisphere sign), `K_h = 10 m²/s`, `dt = 15 min`, horizon 24 h default (configurable to 72 h), 5,000 particles seeded by rejection sampling in the slick polygon. Hand-rolled Euler stepper (07 §7.3.3) retained **only** as a test cross-check.
- [ ] `[ML]` `drift/kde.py`: Gaussian KDE per time frame → normalised density grid → GeoTIFF frame + 50%/90% cumulative contour polygons + weighted centroid. (07 §7.3.4)
- [ ] `[ML]` `estimate_release_window()` (07 §7.3.5): `elapsed = majorAxisKm / median_drift_speed`; `window = [t_obs − 1.5·elapsed, t_obs − 0.4·elapsed]`; **hard lower bound = acquisition time of the most recent prior scene over the same footprint with no detection**; `status: WIDE` when drift speed too low.
- [ ] `[ML]` Degradation (07 §7.3.6): both forcings ⇒ `OK`; winds missing ⇒ `DEGRADED` (`α=0`); currents missing ⇒ `DEGRADED` → `FOOTPRINT_PROXIMITY` (slick buffered 40 km, explicitly labelled not-a-drift-result); region/date outside all coverage ⇒ `UNAVAILABLE`. Degraded runs widen downstream CIs and **do not** adjust tier thresholds.
- [ ] `[ML]` `POST /backtrack` per 07 §7.8 → `{status, frames[], support50, support90, releaseWindow, forcingProvenance, params}`.
- [ ] `[BE]` Origin module (06 §6.4.6): `POST /origin/run` (`horizonHours?`, `particleCount?`, `windDriftRange?`, `deflectionRange?`), `GET /origin/:id` (incl. `status`, `degradationReason`, forcing provenance), `/frames`, `/support`, `/particles?format=binary`.
- [ ] `[BE]` Drift job on the `drift` queue → `mlClient.backtrack` → persist `OriginEstimate` with forcing provenance + `params` + `derivedFrom`. Progress `FETCH_CURRENTS→FETCH_WINDS→SEEDING→INTEGRATING→KDE→CONTOURING`.
- [ ] `[BE]` Store KDE frames as GeoTIFF under `s3://varuna/origin/{id}/frames/{iso}.tif`; particles as parquet.
- [ ] `[FE]` Layers (05 §5.4.4): `origin-field` `BitmapLayer` per frame (violet `--origin-*` ramp, additive, frame chosen by time cursor), `drift-particles` `ScatterplotLayer` (5,000 pts as `Float32Array`, 1 px), 50%/90% contour lines.
- [ ] `[FE]` Origin panel (05 §5.5.5): method, **named forcing sources with provenance chips**, release window, parameters, "re-run with different horizon". Persistent amber `<DegradationBanner>` when `status != OK`, with the 08 §8.2-step-5 wording.
- [ ] `[FE]` Timeline gains the **release-window band** (interval, with a darker "most likely" sub-band) — never a line. (04 §4.7.4)
- [ ] `[ML]` Cross-check test: OpenDrift vs hand-rolled stepper agree within tolerance on a fixed synthetic forcing field (this is a *numerical* cross-check, not fabricated observation data).

**Exit criteria (== MVP M4, M5)**

- [ ] `POST /origin/run` on the reviewed demo detection fetches **real** CMEMS currents + ERA5/GFS winds for that date/region (provenance recorded) and produces a KDE origin surface with 50%/90% support polygons and a centroid.
- [ ] A **release-time window** is produced as an interval with a most-likely sub-interval; the prior-clear-scene bound is applied when such a scene exists.
- [ ] The map renders the origin field + particle cloud; the timeline shows the release-window band.
- [ ] Forcing-missing path: the run completes in `DEGRADED`/`FOOTPRINT_PROXIMITY` with a non-dismissible banner and the report-facing reason string — it does **not** invent a current field.
- [ ] Drift (5,000 particles × 24 h) completes < 90 s. (01 NFR-4)
- [ ] OpenDrift↔stepper cross-check within tolerance.

---

### Phase 8 — AIS ingestion + track reconstruction

**Goal:** pull real historical AIS for the demo region/window, normalise, validate, dedupe,
store in the time-series collection; reconstruct ≥ 5 candidate tracks with quality flags.
**MVP items M6, M7.**

**Depends on:** Phase 1 (time-series collection), Phase 2 (jobs).

**Workstreams:** [BE] lead, [FE] for the AIS panel + layers.

**Tasks**

- [ ] `[BE]` AIS provider clients (03 §3.5.1 `providers/ais/*`): `marineCadastre` (bulk CSV, no key), `dmaDk` (daily CSV, no key), `kystverket`, `gfw` (bearer), `aisStream` (WebSocket — **server-side bridge worker only**, 11 A7 security note). Chain `AIS_HISTORICAL = [LOCAL_ARCHIVE, MARINE_CADASTRE, DMA_DK, KYSTVERKET, GFW]`.
- [ ] `[BE]` Normalisation to the 02 §2.4.4 canonical schema; **map AIS sentinels to `null`** (`SOG 102.3`, `COG 360.0`, `HDG 511`) — never store as numbers (10 §10.4.6). UTC timestamps.
- [ ] `[BE]` Validation (01 FR-4.3): MMSI 9-digit + MID country prefix (ITU table, vendored 11 B8); lat/lon bounds; SOG/COG plausibility; duplicate detection via Redis seen-set keyed `${mmsi}:${tSec}:${lat5}:${lon5}` (06 §6.3.3).
- [ ] `[BE]` `POST /ais/import` (202 + jobId) on the `ais-import` queue; `POST /ais/upload` (CSV, UI-driven column mapping, **rejects rather than coerces** bad rows); inserts into `ais_positions` time-series with an `ingestBatchId` + provenance (`AIS_ARCHIVE` / `AIS_API` / `AIS_STREAM` / `USER_UPLOAD`).
- [ ] `[BE]` `queryEnvelope(envelope, from, to)` (06 §6.4.7): `$geoWithin` + `t` range, projection to needed fields, **hint chosen from the envelope area-to-duration ratio** (compound `{meta.mmsi,t}` for small box / long window; `2dsphere` for large box) — the choice is logged for verification against real query plans.
- [ ] `[BE]` `trackService.reconstruct()` (06 §6.6.3): sort per MMSI; kinematic outlier gate (implied speed > 45 kn ⇒ drop, flag `POSITION_JUMP`, **count removed**); gap-aware segmentation at > 20 min (flag `AIS_GAP`, record gap entry/exit/straight-line/implied-speed); `LOW_SAMPLING` if median interval > 600 s; `MMSI_INVALID` / `MMSI_DUPLICATE` / `STATIC_MISMATCH`; `completeness` 0–1. Persist `VesselTrack` with provenance.
- [ ] `[BE]` Dark-period detection (01 FR-4.6): duration + entry/exit points + whether it overlaps the origin zone.
- [ ] `[BE]` Static/registry join (`GET /ais/vessel/:mmsi`): name, IMO, callsign, ship type + label, flag from MID, dimensions. `vessels` collection with Atlas Search on name.
- [ ] `[BE]` `GET /ais/coverage` — the **honesty endpoint**: source, recordCount, first/last, bbox covered, median interval.
- [ ] `[BE]` `GET /ais/tracks?format=binary` — the packed buffer format from 05 §5.6.3; `?simplify=z{zoom}`.
- [ ] `[FE]` `workers/aisDecoder.worker.ts` — binary buffer → `Float64Array`/`Float32Array`, zero per-point allocation; handed to deck.gl as binary attributes. (05 §5.6.3, 12 F-25)
- [ ] `[FE]` Layers (05 §5.4.4): `ais-tracks` `PathLayer` (binary positions + `startIndices`, categorical colour, **dashed segments for gaps** via a second layer with `PathStyleExtension`); `vessel-positions` `IconLayer` (heading-triangle atlas, `getAngle:cog`, size by length) with `positionAt()` interpolation + **the gap guardrail** (returns `null` inside a gap > 20 min; interpolated markers 70% opacity hollow, real fixes solid — 05 §5.4.5, 12 F-21).
- [ ] `[FE]` AIS panel (05 §5.5.5): import controls; **coverage summary shown first**; vessel list with `<AisQualityStrip>` + `<VesselIdentityCard>`.
- [ ] `[DevOps]` k6 load test: envelope query at 10⁷ stored positions asserts p95 < 400 ms (01 NFR-2, 06 §6.11). Use a **real** AIS slice as the load corpus.

**Exit criteria (== MVP M6, M7)**

- [ ] `POST /ais/import` pulls a **real** archive slice (Marine Cadastre or Danish DMA) for the demo region/window into the time-series collection with provenance and a record count.
- [ ] AIS sentinels are stored as `null`; a test proves a `102.3` SOG never enters kinematic filtering.
- [ ] ≥ 5 vessel tracks reconstructed and rendered, with quality flags, gap dashes, and `removedOutlierCount` surfaced per vessel.
- [ ] A vessel that went dark inside the release window is flagged with duration + entry/exit + origin-zone overlap.
- [ ] `GET /ais/coverage` returns a truthful evidence-base summary.
- [ ] Timeline replay renders vessels via `positionAt()`; no vessel is drawn inside a > 20 min gap.
- [ ] k6: envelope query p95 < 400 ms at 10⁷ positions.
- [ ] Map holds ≥ 50 fps with a real 250k-point AIS slice (Playwright trace). (01 NFR-1)

---

### Phase 9 — M3 attribution scoring + correlation job + candidates

**Goal:** rank candidate vessels with the full 12-feature evidence breakdown, calibrated
confidence, CI, tiers, and the enforced `INSUFFICIENT_EVIDENCE` path. **MVP item M8.**

**Depends on:** Phase 5 (detection + morphology), Phase 7 (origin field + release window), Phase 8 (tracks).

**Workstreams:** [ML] lead, [BE] for the correlate job + candidates API, [FE] for the ranking + evidence screens.

**Tasks**

- [ ] `[ML]` `attribution/features.py` — the **twelve** features from 07 §7.6 with exact units, normalisation curves, default weights, and `applicable()` predicates. Key ones: `spatial_proximity` `exp(-d/8)`; `temporal_alignment` (applicable only when `release_window_status == OK`); `track_intersection`; `heading_alignment` `cos²(Δ)` (applicable only when `elongation_ratio ≥ 2.5`, else `NOT_APPLICABLE`); `ais_dark_period` `min(min/90,1)`; `speed_consistency` trapezoid 4–14 kn; `vessel_type_prior` (unknown ⇒ `MISSING`, never excludes); `origin_density_at_track`; `draught_change` (often `MISSING`, never imputed); `slick_axis_continuity`; `manoeuvre_anomaly`; `prior_incident_history` (weight 0.01).
- [ ] `[ML]` `attribution/model.py` `score_candidate()` (07 §7.5.2): additive over normalised features; **denominator sums weights of MEASURED features only**; `calibrate()` (isotonic, identity + `UNCALIBRATED` below 30 validated incidents); `tier_for()` (`STRONG ≥ 70`, `MODERATE ≥ 50`, `WEAK ≥ 30`, else `INSUFFICIENT_EVIDENCE`); **`measured < 6` forces `INSUFFICIENT_EVIDENCE` regardless of score**. Emit per-feature `Contribution` with raw value + unit + normalised + weight + contribution + status + `evidenceRefs`.
- [ ] `[ML]` `attribution/bootstrap.py` `bootstrap_ci()` (07 §7.5.3): 500 iters resampling drift-ensemble members + perturbing **interpolated** positions by sampling-interval error. **Real fixes never perturbed.** 5th/95th percentiles.
- [ ] `[ML]` `attribution/calibration.py` `fit_calibrator()` — isotonic, `MIN_CALIBRATION_SAMPLES = 30`.
- [ ] `[ML]` `POST /score` per 07 §7.8 → `{candidates[]}` each with features, contributions, CI, tier, `modelVersion`, `calibrated`. Provenance on the response.
- [ ] `[ML]` M3 evaluation harness (07 §7.6.3): Top-1/3/5 containment, MRR, ECE, per-feature ablation, robustness-to-degradation, abstention rate — run against assembled validated incidents (07 §7.4.3, 10 §10.6). Publish the ablation table for the report appendix.
- [ ] `[BE]` `correlate` job (06 §6.6.2): build envelope `turf.rewind(turf.buffer(support90, bufferKm))` (`15 km` if origin `OK`, `40 km` if degraded); `from/to = releaseWindow ± 3 h`; `aisService.queryEnvelope`; **if zero positions ⇒ return `{candidates:[], reason:'NO_AIS_COVERAGE', sourcesQueried}`** (not an empty success); `trackService.reconstruct`; `VesselTrack.insertMany`; `mlClient.score`; persist `CandidateVessel` with `rank`, `provenance.derivedFrom = [detection, origin]`, `weightProfileId` (default `DEFAULT_V1`). Progress `ENVELOPE→AIS_QUERY→TRACKS→SCORING→PERSISTING`.
- [ ] `[BE]` Candidates API (06 §6.4.8): list (ranked), get (full evidence), `/evidence/:featureKey` (source records behind one feature), `POST /candidates/reweight` (**synchronous, < 3 s**, re-ranked list, profile persisted + recorded for the report), `/exclude` (reason required, audit-logged) + restore, `/weight-profiles`.
- [ ] `[FE]` Candidate ranking screen (05 §5.5.7): ranked rows (rank, MMSI mono, name, score `71 ±6`, tier); **hover → highlight track, others fade to 0.25**; **click → inline `<EvidenceWaterfall>` + camera flies to fit track + origin support**; `Weights ▾` editor (12 sliders sum 100, live FLIP re-ranking, reset-to-default, permanent "recorded in report" note); excluded hidden-but-counted; **top-tier `INSUFFICIENT_EVIDENCE` ⇒ full-width explanatory panel instead of a ranking**.
- [ ] `[FE]` `<EvidenceWaterfall>` (04 §4.7.2): bars sorted by |contribution|; **raw measured value always beside the contribution**; `NOT MEASURED` / `NOT APPLICABLE` rows **rendered, not hidden**, hatched; every row click-through to source records; permanent renormalisation note.
- [ ] `[FE]` `<ConfidenceBadge>` four-channel encoding (04 §4.7.3): position + label + `71 ±6` interval + colour (fourth). `STRONG` shows the fixed "not a determination of responsibility" sentence in-component.
- [ ] `[FE]` Evidence detail screen (05 §5.5.8): vessel identity col; expandable feature rows (definition + normalisation curve with this vessel's value marked + raw computation + source records); source-records mono table (`t,lat,lon,sog,cog,navStatus,source`) where clicking a row moves the time cursor + flies the map.
- [ ] `[BE/ML]` Extend the Testcontainers integration test through **score** — the full `ingest → detect → correlate` chain on one cached real scene. (06 §6.11)

**Exit criteria (== MVP M8)**

- [ ] `POST /candidates/score` on the demo investigation produces a ranked list with per-feature contributions, `scoreCI`, tiers, and `calibrated` flag.
- [ ] Renormalisation proven: a candidate with missing `draught_change` is **not** penalised as if it scored zero (unit test on `score_candidate`).
- [ ] The 6-measured-feature floor forces `INSUFFICIENT_EVIDENCE` in a constructed real-data case; the UI leads with the explanatory panel.
- [ ] `NO_AIS_COVERAGE` returns the sources-queried list, not an empty-looking success.
- [ ] Every number in the waterfall drills down to real AIS fixes with UTC timestamps.
- [ ] `reweight` returns a re-ranked list in < 3 s and the profile is recorded.
- [ ] Scoring + ranking for 200 candidates < 3 s (01 NFR-5).
- [ ] Full `ingest→detect→correlate` integration test green in CI.

---

### Phase 10 — Workspace UI shell: map subsystem, stores, timeline, screens

**Goal:** the persistent-map workspace with synchronised time, layer stack, selection
cross-linking, and every non-3D screen — the frame all prior phases plug into. **MVP items
M9, M12.** Runs in parallel with Phases 6–9 from Week 5.

**Depends on:** Phase 2 (auth/investigations), grows as Phases 6–9 land.

**Workstreams:** [FE] lead.

**Tasks**

- [ ] `[FE]` `design/tokens.css` (04 §4.3.2 full token set) + `design/tokens.ts` typed export for deck.gl/Three; `scripts/tokens-sync-check.ts` in CI (04 §4.13).
- [ ] `[FE]` Typography system (04 §4.2): Space Grotesk / IBM Plex Sans / IBM Plex Mono, subsetted, `font-display:swap`, preconnect. Type scale tokens. Enforce T1–T9 (tabular-nums everywhere numeric; mono for all identifiers/coords/timestamps; 5-dp coords with hemisphere letters; `2023-08-14 06:12:47 Z` timestamps; explicit units; `71 ±6` uncertainty; caps only for taxonomy tokens).
- [ ] `[FE]` `design/primitives` (04 §4.8.1): Button, IconButton, Input/Select/Combobox (label always visible, reserved error space), NumericField, CoordinateField (DD/DMS/DDM → DD on blur), DateTimeRange (UTC only, blocks over max), Toggle/Checkbox/Radio, Slider (mono value bubble), Tabs (roving tabindex), Tooltip (400 ms, never sole source), Popover/Drawer/Modal (focus trap, Esc, restore focus), Toast (polite/assertive), Skeleton, EmptyState (always says why + what next).
- [ ] `[FE]` `motion.ts` presets (04 §4.5.2) + full `prefers-reduced-motion` handling (decorative → instant; data animation → stepped with visible controls).
- [ ] `[FE]` `state/`: `useMapStore`, `useTimeStore` (04 §5.3.2 contract), `useLayerStore` (persisted per investigation), `useSelectionStore` (the cross-cutting `Selection` union — 05 §5.3.2), `useUiStore`. `useShallow` selectors.
- [ ] `[FE]` **The animation channel** (05 §5.3.3, 12 F-24): `timeChannel = { cursor }` plain object; `requestAnimationFrame` loop in `DeckOverlay` calls `overlay.setProps()` directly at 60 Hz; React store synced at 4 Hz for text panels only.
- [ ] `[FE]` `map/MapRoot.tsx` — **one MapLibre instance at the app root, never unmounts** (05 §5.4.1, 12 F-23); local dark style JSON, no mandatory token. `map/DeckOverlay.tsx` — `MapboxOverlay` **interleaved** mode.
- [ ] `[FE]` `map/layers/` — pure-function factory registry (05 §5.4.3): `buildLayers(LayerInputs)` returning the full fixed-order stack from 04 §4.7.1 (basemap → bathymetry → SAR raster → land mask → AOI → origin field → drift particles → slick polygon → AIS tracks → vessel positions → candidate highlights → labels). No layer reads a store directly. Each layer has a toggle, opacity slider, legend, **provenance chip**; a layer without provenance cannot be added.
- [ ] `[FE]` `map/interactions/` — picking/hover throttled 30 Hz writing `useSelectionStore.hover` (one small write, no layer rebuild); DOM hover card (not a WebGL tooltip); draw tools for AOI + geometry edit; **keyboard map mode** (`M`) with the 05 §5.4.7 key table + parallel accessible feature list.
- [ ] `[FE]` `map/camera.ts` — `flyToFeature`, `fitBounds`, presets (Plan / Elevation / Isometric).
- [ ] `[FE]` `<TimeScrubber>` (04 §4.7.4): UTC mono ticks; release window as a **band**; playback 1×/10×/60×/300×; `←/→` step-by-fix, `⇧←/⇧→` step-by-hour; drives every time-aware layer through `useTimeStore` + the animation channel.
- [ ] `[FE]` Domain components (04 §4.8.2) not built earlier: `<ProvenanceChip>`, `<UncertaintyBand>`, `<LayerStackControl>`, `<JobConsole>` (live list, stage, %, elapsed, cancel, **verbatim failure reason**), `<ImageryComparator>`, `<DegradationBanner>`.
- [ ] `[FE]` Screens: Landing `/` (05 §5.5.2 — globe code-split, GSAP scrollytelling on a small static map, live `GET /api/v1/public/demo-incident` waterfall, all 3D/GSAP skipped under reduced motion); Workspace `/investigations/:id` (05 §5.5.5 — left rail with count badges + status dots, floating map controls, rail-driven evidence panel, `⌘\` `⌘K` `Space` `←/→` `1–9` `M` `?` shortcuts); Jobs console `/investigations/:id/jobs`; Report preview `/investigations/:id/report` (Phase 12).
- [ ] `[FE]` `api/generated/` types from the server OpenAPI spec + TanStack Query hooks per module (05 §5.1); query-key + cache policy table from 05 §5.6.2; WebSocket-driven `invalidateQueries` (05 §5.8).
- [ ] `[FE]` Route-level code splitting (deck.gl, R3F, GSAP all lazy); `content-visibility:auto` on off-screen panel sections; virtualised lists.
- [ ] `[FE]` Accessibility (04 §4.10): 2 px `--border-focus` rings never removed; parallel virtualised "Feature list" mirroring visible layers; live regions (polite progress, assertive failure); 44×44 px targets; functional to 200% zoom; abbreviations expanded on first use.
- [ ] `[DevOps]` CI perf budgets (05 §5.9): initial JS ≤ 280 kB gzip, workspace chunk ≤ 220 kB gzip, LCP ≤ 2.0 s, CLS ≤ 0.02, INP ≤ 200 ms; `vite-bundle-visualizer`.

**Exit criteria (== MVP M9, M12)**

- [ ] Navigating rail items and routes **never remounts the map**; camera and tiles persist.
- [ ] Timeline playback at 300× with a real 250k-point AIS slice holds ≥ 50 fps; React re-renders ≤ ~4×/s during playback (profiler).
- [ ] Scrubbing moves every time-aware layer (SAR frame N/A, origin frame, particles, vessel positions, candidate highlight) from one shared store.
- [ ] Selecting a candidate row highlights its track, opens the evidence drawer, filters the timeline, and moves the camera — all via `useSelectionStore`.
- [ ] Every layer in the stack shows a provenance chip; attempting to add a layer without provenance is refused.
- [ ] **Every workspace screen passes the provenance audit** — nothing renders without a source (M12).
- [ ] `prefers-reduced-motion`: decorative motion off, data animation becomes stepped with a visible step control, no information lost.
- [ ] axe-core: zero critical/serious on every route; keyboard-only pass + screen-reader pass on the workspace recorded.
- [ ] CI perf budgets enforced and green.

---

### Phase 11 — 3D surfaces: globe, slick relief, space-time prism

**Goal:** the three justified 3D surfaces from 04 §4.6, each encoding data, within the
2-WebGL-context budget.

**Depends on:** Phase 10 (map + deck context), Phase 7 (origin frames), Phase 8 (tracks).

**Workstreams:** [FE] lead.

**Tasks**

- [ ] `[FE]` **Surface A — Orbital Globe** (`three/Globe/`, 04 §4.6.1): R3F sphere + custom night/day/Fresnel shader, backface atmosphere shell, `InstancedMesh` incident markers at real lat/lon (radius by slick area, colour by tier), selected-incident Bézier arc, 15° graticule, **real solar-position terminator for the incident UTC timestamp**, damped auto-orbit 0.06 rad/s halting on input. 45 fps limiter; `<Canvas frameloop="demand">` when static. Reduced motion ⇒ one static frame at incident longitude. **Unmounts when the workspace mounts.**
- [ ] `[FE]` **Surface B — Slick Relief** (`three/SlickRelief/`, 04 §4.6.2): MapLibre 3D terrain from a `raster-dem`-encoded tile source derived from the calibrated sigma-nought COG (TiTiler generates DEM-encoded tiles). Vertical exaggeration slider 0–40× (default 12×, value always shown), pitch 0–70° with snap-to-0, greyscale ramp identical to 2D, slick polygon draped `--oil-500` 0.25 + 2 px stroke. **Non-dismissible caption:** `Vertical exaggeration 12× — relief encodes SAR backscatter (σ⁰ dB), not sea-surface height.` (04 §4.6.2 honesty guardrail, 12 F-28)
- [ ] `[FE]` **Surface C — Space-Time Prism** (`three/Prism/`, 04 §4.6.3, route `/investigations/:id/prism`): rendered **in the same deck.gl context** as the map (no second context). Base `TileLayer` at z=0; Z axis = time, labelled hourly; vessel tracks as 3D `PathLayer` (`getPath → [lon,lat,tToZ(t)]`); origin field as 5–9 `BitmapLayer` slices at model timestamps (additive, `--origin-*`); intersection markers where a track passes within 50% support of a slice, with a leader line to its evidence row; camera orbit+dolly with Plan/Elevation/Isometric presets; `Sync with map` toggle.
- [ ] `[FE]` 3D budget rules (04 §4.6.4): total WebGL contexts = 2 (map+deck, globe) — never more; any 3D surface → static frame on `visibilitychange` hidden; no 3D asset > 1.5 MB, textures `.ktx2`/basis; software-renderer detection ⇒ static fallback + notice.

**Exit criteria**

- [ ] The globe rotates to and marks the real demo-incident location; the terminator matches the incident's UTC solar position.
- [ ] Slick relief shows the backscatter depression of the slick; the exaggeration caption is present and cannot be dismissed.
- [ ] In the prism, the top candidate's helix visibly passes **through** a bright origin slice while a competitor's passes through the same column at a different height. (08 §8.2 step 5, 12 F-27)
- [ ] Never more than 2 WebGL contexts (assert in a test); hidden tab drops 3D to a static frame.
- [ ] Software-renderer path shows the static fallback with a notice.
- [ ] Reduced motion honoured on all three surfaces.

---

### Phase 12 — Reporting & exports

**Goal:** a complete PDF dossier (with mandatory Uncertainty + Provenance sections) plus
machine-readable exports and a reproducible run manifest. **MVP item M10.**

**Depends on:** Phase 9 (candidates/evidence), Phase 10 (components reused in the report route).

**Workstreams:** [BE] + [FE] jointly.

**Tasks**

- [ ] `[FE]` `/investigations/:id/report` route (05 §5.5.10): renders the **exact DOM Playwright converts to PDF**, in **light theme**, at A4 width, reusing the same `<EvidenceWaterfall>`, `<ConfidenceBadge>`, `<MethodologyNote>`, maps, charts. Section checklist; **`Uncertainty & Limitations` and `Data Provenance` cannot be deselected** (shown locked with an explanation). Sets `data-report-ready="true"` only after every tile/chart/font has settled.
- [ ] `[FE]` Report content (01 FR-1 F1): incident summary, scene metadata, detection maps, morphology, drift methodology + parameters, AIS source + coverage, candidate table, per-candidate evidence pages, **uncertainty statement**, **full data-provenance appendix (the lineage DAG from 13 §13.5.1)**, methodology version hashes, model artefact SHA-256, weight-profile hash, pipeline version, git SHA.
- [ ] `[BE]` `POST /reports/generate` (06 §6.4.9): **API rejects a payload that omits `UNCERTAINTY` or `PROVENANCE`**; 202 + jobId.
- [ ] `[BE]` `generateReport` job (06 §6.8): `final = uniq([...sections, 'UNCERTAINTY', 'PROVENANCE'])` (enforced again here); short-lived read-only report token; pre-warmed Playwright `browserPool` (2 concurrency); `page.pdf({format:'A4', printBackground, margins, footerTemplate})`; write to `s3://varuna/reports/{id}/dossier.pdf`; persist `Report` with `pipelineVersion`, `modelVersions`, `weightProfileId`, `generatedBy/At`.
- [ ] `[BE]` Exports (06 §6.4.9): `/exports/geojson` (detections + tracks + origin support + candidates), `/exports/csv` (candidates + per-feature contributions), `/manifest` (full run manifest pinning scene IDs, model hash, params, data-source versions — 01 NFR-19, 12 F-34). `/download` redirects to a signed 15-min URL.
- [ ] `[FE]` Additional export buttons in the report panel.
- [ ] `[DevOps]` Report render budget: < 25 s (01 NFR / 02 §2.10).

**Exit criteria (== MVP M10)**

- [ ] `Generate PDF` on the demo investigation produces a complete PDF in object storage with a working signed download link.
- [ ] The PDF contains the Uncertainty and Data Provenance sections; a request omitting them is rejected at the API (test).
- [ ] The provenance appendix prints the lineage DAG back to Copernicus/CMEMS/ERA5/AIS product identifiers + model SHA.
- [ ] Report typography and evidence visualisations are pixel-identical to the on-screen components (visual-regression check, light + dark).
- [ ] GeoJSON + CSV + run-manifest exports download and validate; a second run from the manifest reproduces the same candidate ranking.
- [ ] Render completes < 25 s.

---

### Phase 13 — Demo staging, integration, E2E, load, a11y, hardening, rehearsal

**Goal:** the whole thing works end to end on the real demo incident, offline-safe, tested,
accessible, and rehearsed to the 12-minute script.

**Depends on:** all prior phases.

**Workstreams:** [All].

**Tasks**

- [ ] `[DevOps]` `pnpm run stage:demo` (03 §3.9, 13 §13.10): download the demo incident's **real** scene(s) (incident date **and** a prior clear date), **real** AIS slice, **real** CMEMS currents, **real** ERA5 winds into MinIO + MongoDB. Provenance records are the originals; checksums match. **The pipeline still runs for real during the demo** — only inputs are pre-staged, results are not pre-computed.
- [ ] `[BE]` `GET /api/v1/public/demo-incident` — real, cached, read-only reconstruction for the landing page waterfall.
- [ ] `[All]` Testcontainers integration: full `ingest → preprocess → detect → review → backtrack → ais-import → correlate → score → report` on the cached real scene, asserting provenance at every hop. (02 §2.15, 06 §6.11)
- [ ] `[FE/DevOps]` Playwright E2E: **Journey 1** (08 §8.2, the demo path M1–M10) and **Journey 2** (08 §8.3, the honest null result — no detection / no AIS / `INSUFFICIENT_EVIDENCE` branches). Against the real demo incident.
- [ ] `[DevOps]` k6 load: envelope query p95 < 400 ms at 10⁷ real positions; API p95 (non-job) < 250 ms (01 NFR-6); 50 concurrent investigations without degradation (01 NFR-7).
- [ ] `[DevOps]` `check-real-data-policy.sh` all 6 checks enforced as a **required** PR status check; gitleaks + `npm audit` + `pip-audit` blocking on high severity.
- [ ] `[FE]` Accessibility: axe-core zero critical/serious on every route in CI; manual keyboard-only pass + screen-reader pass on the workspace, both signed off.
- [ ] `[BE]` `/security-review` pass: RBAC matrix, upload validation chain, signed-URL TTLs, CSP, secret redaction, audit-log write-protection.
- [ ] `[All]` Cold-start test: fresh clone + `.env` from `.env.example` + `docker compose up` reaches a working system using only documented variables (01 §12.7, 03 §3.9).
- [ ] `[All]` Demo rehearsal against the 08 §8.9 script, timed; the judge-question contingency (open the provenance inspector on any object; offer a live catalogue search on a judge-chosen date) practised.
- [ ] `[All]` Final sync: all 15 docs current with the shipped build (01 §12.8).

**Exit criteria (release-ready)**

- [ ] All M1–M12 demonstrably working on the real demo incident, live, no gaps (§14.8).
- [ ] Model MVP metrics met on the held-out real test split; CI eval gate green.
- [ ] No code path can produce/ingest/render fabricated data — `check-real-data-policy.sh` green as a required check.
- [ ] Every screen passes the provenance audit.
- [ ] PDF renders completely with Uncertainty + Provenance sections.
- [ ] WCAG 2.1 AA on the primary workspace (axe + manual passes).
- [ ] Cold `docker compose up` on a clean machine reaches a working system from documented env vars only.
- [ ] All 15 documents current with the build.
- [ ] Demo rehearsed end to end within 12 minutes.

---

## 14.7 Critical path

```
Phase 0 (accounts + MKLab request + demo-incident coverage)
   └─► Phase 1 (contracts + provenance + geodesy)
          ├─► Phase 2 (platform) ──► Phase 3 (providers/catalogue) ──► Phase 4 (ingest, M1)
          │                                                              └─► Phase 5 (M1 model, M2/M3/M11)
          │                                                                     └─► Phase 6 (detections)
          ├─► Phase 8 (AIS, M6/M7) ───────────────────────────────────────────────────┐
          └─► Phase 4 ──► Phase 7 (drift, M4/M5) ─────────────────────────────────────┤
                                                                                      ▼
                                                                          Phase 9 (M3 scoring, M8)
   Phase 10 (workspace UI, M9/M12) runs parallel from Week 5, consuming 6/7/8/9 as they land
                                                                                      ▼
                                                              Phase 12 (reports, M10) ─► Phase 13 (hardening + demo)
   Phase 11 (3D) slots after 10 + 7 + 8
```

**The two things that sink the timeline if left late** (from 10 §10.8):

1. **MKLab/CERTH dataset approval** — submit Phase 0 day 1; if not approved by end of Week 2, switch the training plan to SOS / Deep-SAR secondary datasets and state the reduced set in the report (13 §13.8).
2. **Demo-incident coverage verification** — a candidate incident with S-1 but no free AIS (or vice versa) is not viable. Lock one incident with **both** confirmed by end of Week 1, plus a backup.

**Other hard dependencies**

- Phase 5 needs Phase 4's COG pipeline (real analysis-ready rasters to train/infer on).
- Phase 9 needs 5 + 7 + 8 all present (it is the join).
- Phase 12's report route reuses Phase 10 components — do not build a separate PDF template.
- GFW token approval can take days (11 A6) — not on the critical path (bulk archives need no key) but request in Week 1.

---

## 14.8 MVP traceability (01 §8.1 — M1…M12)

| MVP item | Definition of done | Delivered by | Verified in |
|---|---|---|---|
| **M1** | Real Sentinel-1 GRD ingested, preprocessed, shown as a real raster tile layer | Phase 4 | Phase 4 exit + Phase 13 E2E |
| **M2** | Trained segmentation model produces a slick mask on that real scene | Phase 5 | Phase 5 exit |
| **M3** | Mask vectorised to a georeferenced polygon with real km² | Phase 5 | Phase 5 exit |
| **M4** | Real wind + current fields fetched for that date/region | Phase 7 | Phase 7 exit |
| **M5** | Backward drift → origin probability surface + release-time window | Phase 7 | Phase 7 exit |
| **M6** | Real AIS for that region/window loaded from a public historical archive | Phase 8 | Phase 8 exit |
| **M7** | ≥ 5 candidate vessel trajectories reconstructed and rendered | Phase 8 | Phase 8 exit |
| **M8** | Candidates ranked with the full per-factor evidence breakdown | Phase 9 | Phase 9 exit |
| **M9** | Timeline replay works, synchronised across layers | Phase 10 | Phase 10 exit + Phase 13 E2E |
| **M10** | PDF dossier exports with methodology, uncertainty, provenance appendix | Phase 12 | Phase 12 exit |
| **M11** | Model eval metrics (IoU/Dice/F1) on a held-out real test split | Phase 5 | Phase 5 exit + CI eval gate |
| **M12** | Every screen passes the provenance check | Phases 1 + 10 | Phase 10 exit + Phase 13 audit |

---

## 14.9 Release-criteria traceability (01 §12)

| # | Criterion | Owned by phase |
|---|---|---|
| 1 | All M1–M12 working on a real incident, live | 13 |
| 2 | Model metrics meet MVP targets on a held-out real split | 5 (+ CI gate) |
| 3 | No code path can produce/ingest/render fabricated data (CI green) | 1, 13 (`check-real-data-policy.sh`) |
| 4 | Every screen passes the provenance audit | 10, 13 |
| 5 | PDF renders completely incl. uncertainty + provenance | 12 |
| 6 | Accessibility audit passes WCAG 2.1 AA on the workspace | 10, 13 |
| 7 | Cold `docker compose up` reaches a working system from documented env vars | 0, 13 |
| 8 | All 13 (now 15) documents current with the shipped build | 13 |

---

## 14.10 Testing strategy (condensed from 02 §2.15, 05 §5.11, 06 §6.11, 07 §7.2.12)

| Level | Tool | Gate |
|---|---|---|
| Unit (server) | Vitest | ≥ 80% services; **100% geodesy, scoring, provenance** |
| Unit (Python) | pytest | ≥ 80%; 100% coordinate transforms + drift stepper |
| Known-answer geodesy | Vitest + pytest | Both stacks agree within 0.1% — **CI gate** |
| Polygon winding | Vitest | Wrongly-wound polygon rejected; `$geoWithin` ≠ whole world |
| Component (client) | Testing Library | All evidence + provenance components |
| Contract | Zod round-trip + OpenAPI diff + Pydantic-mirror diff | Every endpoint / every schema |
| Integration | Testcontainers (Mongo+Redis+MinIO) | Full ingest→detect→correlate→score→report on one **real cached** scene |
| E2E | Playwright | MVP journey (M1–M10) + honest-null journey, real demo incident |
| Model eval | pytest + MLflow | Held-out real test split; **CI gate** vs deployed model |
| Load | k6 | Envelope query p95 < 400 ms at 10⁷ real positions |
| Accessibility | axe-core in Playwright | Zero critical/serious on every route — **release gate** |
| Real-data policy | `scripts/check-real-data-policy.sh` | 6 checks — **required PR status check** |
| Perf budgets | vite-bundle-visualizer + Playwright tracing | Bundle/LCP/CLS/INP thresholds |

**Fixtures are real.** Everything under `__fixtures__/real/` is a captured real provider
response with a sibling `.provenance.json`. No invented vessels, coordinates, or scores.
We simulate *transport/infrastructure failure*, never *observation content* (13 §13.7).

---

## 14.11 Definition of Done (per module — 02 §2.16)

A module is done when **all** hold:

- [ ] Its Zod/Pydantic contract is published in `packages/shared` (and the Pydantic mirror diff-checks clean).
- [ ] Its provenance path is implemented and tested (save without provenance throws; serialiser strips + alerts).
- [ ] Its failure mode returns `UNAVAILABLE` / `DEGRADED` with a machine-readable reason — never a default.
- [ ] Its performance budget from 02 §2.10 is **measured**, not assumed.
- [ ] It has an integration test running against **real cached data**.
- [ ] Spec docs touched by the work are updated in the same PR.
- [ ] `check-real-data-policy.sh` passes.

---

## 14.12 Risk register (carried from 01 §10 — status tracked in CONTEXT.md)

| # | Risk | Mitigation (built where) | Status |
|---|---|---|---|
| R1 | Look-alikes misclassified as oil | 5-class model + wind gate 3–10 m/s + ancillary context + confidence terms + human review — Phase 5, 6 | Open |
| R2 | AIS gaps/spoofing hide the vessel | Dark-period as **positive** feature F5 + MMSI checks + SAR ship class cross-check — Phase 8, 9 | Open |
| R3 | Drift error → wrong origin zone | Sampled α/θ ensemble → probability field + score CI — Phase 7 | Open |
| R4 | Insufficient labelled training data for region | Train on MKLab/CERTH + validated-incident SAR; transfer-learn; never synthesise — Phase 0, 5 | **Watch** (MKLab approval) |
| R5 | External API quota exhaustion mid-demo | `stage:demo` pre-stages real data locally; per-key quota tracking; provider fallback chains — Phase 3, 13 | Open |
| R6 | Attribution misused as proof of guilt | Tier labels + mandatory uncertainty in every export + no "guilty" copy + `INSUFFICIENT_EVIDENCE` first-class — Phase 9, 12 | Open |
| R7 | MongoDB lacks polygon-distance functions | Turf/Shapely compute layer, results persisted back as indexed GeoJSON — Phase 1 | Open |
| R8 | Data volume (1 GB scenes; 10⁷ AIS rows/mo) | COG + HTTP range; time-series collection; monthly partitions; lifecycle rules — Phase 1, 4, 8 | Open |
| R9 | Timezone/CRS errors silently corrupting correlation | UTC + EPSG:4326 storage rule; equal-area for measurement only; known-answer geodesy CI gate — Phase 1 | Open |
| R10 | Judges assume the demo is faked | Live provenance inspector on every object; scene IDs + AIS counts on screen; offer a judge-chosen live catalogue search — Phase 10, 13 | Open |

---

## 14.13 What is explicitly deferred (Phase 2 / Phase 3 of the product — 01 §8.2/§8.3)

Not in the MVP build; labelled as such everywhere:

- Live AIS stream integration + standing-AOI monitoring + alerting (email/webhook/SMS)
- Multi-scene temporal slick tracking across consecutive overpasses
- Optical/SAR fusion for look-alike disambiguation
- Uncertainty calibration against a multi-incident validation set (ship `UNCALIBRATED` until 30+ labels)
- Collaborative multi-analyst investigation with presence
- Regional deployment (Indian EEZ, ISRO EOS-04 / RISAT, INCOIS currents)
- Model retraining loop fed by analyst corrections
- Cross-incident repeat-offender profiling

The AIS live bridge worker and `aisStream` client are **built** in Phase 8 (the server-side
plumbing) but only exercised for Phase-2 monitoring.

---

## 14.14 Change control

- This plan is versioned. Material changes to scope or phase ordering bump the version and
  are noted in [CONTEXT.md](CONTEXT.md) → Decisions log.
- Day-to-day progress, blockers, and decisions live in [CONTEXT.md](CONTEXT.md), not here.
- If reality diverges from a phase's exit criteria, update the criteria here **and** record
  why in the Decisions log — never silently drop a criterion.
