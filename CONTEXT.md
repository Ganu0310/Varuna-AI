# 15 — Project Context (Living Status)

**Product:** VARUNA — SIH26143
**This file is updated continuously as work lands.** It is the single source of truth for
*where we are*. The plan is in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md); the specs
are docs 00–13.

---

## 15.0 Snapshot

| Field | Value |
|---|---|
| **Last updated** | 2026-08-28 |
| **Updated by** | Phase 1 pass (Claude) |
| **Current phase** | Phase 1 — Data-plane spine (code-complete; DB-integration verification pending Docker) |
| **Overall status** | 🟡 Phases 0–1 code done and green: **70 tests pass** (59 JS + 11 Python), typecheck / lint / format / real-data policy / token sync all clean. Geodesy known-answer suite agrees across Node (GeographicLib) and Python (pyproj) within 0.1%. Blocked on git + Docker install + accounts + demo incident. |
| **Days to submission** | (fill in) |
| **Biggest current risk** | **git and Docker not installed** (B-001/B-002) — blocks version control and DB-integration tests; MKLab request not submitted (B-003); demo incident not locked (B-004) |
| **Next milestone** | Install Docker → run `bootstrapDatabase()` against real Mongo (verify `ais_positions` time-series + winding `$geoWithin` behaviour), then Phase 2 (auth, RBAC, investigations, jobs, realtime) |

---

## 15.1 How to use and update this file

**Read it** at the start of every working session to know the state of play.

**Update it** whenever any of these happen — same PR as the change:

| When you… | Update section |
|---|---|
| Start / finish / block a phase or task | §15.3 Status board |
| Register an account or get a key working | §15.4 Environment & accounts |
| Acquire a dataset / verify incident coverage | §15.5 Data acquisition · §15.6 Demo incident |
| Hit or clear a blocker | §15.7 Active blockers |
| Make a non-trivial technical decision not already in the specs | §15.8 Decisions log (append-only) |
| Land any meaningful change | §15.9 Changelog (append-only, dated, newest on top) |
| Discover a question the team must answer | §15.10 Open questions |
| Change the risk picture | §15.11 Risk status |

**Rules**

- Always bump §15.0 `Last updated` + `Updated by` + `Current phase` + `Overall status`.
- §15.8 and §15.9 are **append-only** — never edit or delete past entries; add a new one that supersedes.
- Keep entries short. Link to PRs / commits / MLflow runs rather than pasting detail.
- Status legend: 🔴 not started · 🟡 in progress · 🟢 done · ⛔ blocked · ⚪ deferred / not applicable.

---

## 15.2 Where things live (fill in as created)

| Thing | Location | Status |
|---|---|---|
| Monorepo root | `e:\SIH` (pnpm workspaces; docs kept at root, not in `docs/`) | 🟢 |
| Shared contracts | `packages/shared/src/` — units, constants, 8 Zod schemas, geo-known-answers, 24 tests | 🟢 |
| Geodesy (CI gate) | `apps/api/src/geo/` (GeographicLib) + `services/ml/varuna_ml/geo/` (pyproj) ↔ `packages/shared/geo-known-answers.json` | 🟢 |
| Mongoose models | `apps/api/src/modules/*/model.ts` (11) + `db/models.ts` + `db/plugins/provenance.ts` + `db/schemas/geojson.ts` + `db/bootstrap.ts` | 🟢 code, DB-verify pending |
| Provenance enforcement | `db/plugins/provenance.ts` (L2), `middleware/provenanceGuard.ts` (L3), `apps/web/src/{lib/provenance.ts,components/DataObject.tsx}` (L4) | 🟢 |
| API | `apps/api/` — env.ts, middleware chain (+ provenanceGuard), RFC 9457 handler, health, 29 tests, boots | 🟢 skeleton |
| Worker | `apps/worker/` — bootstrap stub, no processors yet | 🟢 skeleton |
| Web | `apps/web/` — Vite+React shell, design tokens (css + ts mirror) | 🟢 skeleton |
| ML service | `services/ml/` — FastAPI, config, service-token guard, provenance mirror, health, 3 tests | 🟢 skeleton |
| docker-compose | `docker-compose.yml` + Dockerfiles (**untested — Docker not installed**) | 🟡 authored |
| CI pipeline | `.github/workflows/ci.yml` + `.gitleaks.toml` | 🟢 authored |
| Real-data policy check | `scripts/check-real-data-policy.mjs` (+ `.sh` wrapper) — 6 checks, passing | 🟢 |
| Demo staging script | `scripts/stage-demo.ts` — stub (exits 1, blocked on incident + Phases 4/7/8) | 🟡 stub |
| Token sync check | `scripts/tokens-sync-check.mjs` — passing (32 colours) | 🟢 |
| Dataset manifest | `data/manifests/dataset_manifest.yaml` — skeleton, sha256/retrieved_at PENDING | 🟡 skeleton |
| Model registry | object storage `models/{sha256}/` + `models` collection | 🔴 Phase 5 |
| MLflow | compose service | 🟢 authored |
| `.env.example` | repo root (full, from 11 §11.6) | 🟢 |

---

## 15.3 Status board

Update the status column and add a short note (owner, PR link, blocker) as work moves.

### Phases

| Phase | Title | Status | Note |
|---|---|---|---|
| 0 | Foundations, accounts, data acquisition kickoff | 🟡 | Code scaffold complete & green. Outstanding: account registrations, MKLab request, demo-incident verification, install git + Docker, cold `docker compose up` test. |
| 1 | Data-plane spine: models, provenance, geodesy | 🟢 code / 🟡 DB-verify | **Done:** 8 Zod contracts + branded units + constants; `provenancePlugin` (pre-validate rejects missing/incomplete/forbidden-sourceType — tested without DB); GeoJSON Mongoose sub-schemas with closed-ring + **right-hand-winding** validator (tested); all 11 Mongoose models (`modules/*/model.ts`) + `db/models.ts` barrel; `db/bootstrap.ts` (creates `ais_positions` time-series + all indexes, idempotent); `provenanceService.recordProvenance` (dedup on externalId, immutable) + `derivedProvenance`; `provenanceGuard` middleware (strips objects with invalid provenance → `__provenanceMissing` marker, `X-Provenance-Count`/`X-Provenance-Stripped` headers, severity-1 log — tested via supertest); wired into `app.ts` before routes. **Geo:** `apps/api/src/geo/` (geodesy via GeographicLib, envelope buffer+rewind, trackGeometry point-to-line); Python `varuna_ml/geo/` (pyproj geodesy + LAEA projections). **Known-answer geodesy suite is a CI gate** — same `packages/shared/geo-known-answers.json` asserted by both stacks, agree < 0.1%. FE `lib/provenance.ts` (`assertProvenance`) + `<DataObject>` boundary (deliberately-ugly PROVENANCE MISSING panel) + tests. **Pending (needs running Mongo):** run `bootstrapDatabase()` for real, verify `ais_positions` is timeseries, verify a wrongly-wound polygon's `$geoWithin` ≠ whole world, integration coverage. |
| 2 | Platform: auth, RBAC, investigations, jobs, realtime | 🟡 | Middleware chain skeleton in `app.ts` (requestId, pino-http, helmet/CSP, cors, json, cookie, sanitizeMongo, rate-limit, provenanceGuard, RFC 9457 handler). Models exist (investigations, jobs). Pending: auth/RBAC, investigations router/service, Mongo connect on boot, Redis/BullMQ/Socket.IO wiring, OpenAPI gen, RBAC matrix test. |
| 3 | Providers + live catalogue search | 🔴 | — |
| 4 | ML service + SAR preprocessing + scene ingest E2E (M1) | 🔴 | — |
| 5 | M1 oil-slick segmentation (M2, M3, M11) | 🔴 | — |
| 6 | Detections module (BE + FE review) | 🔴 | — |
| 7 | Environmental data + M2 drift + origin field (M4, M5) | 🔴 | — |
| 8 | AIS ingestion + track reconstruction (M6, M7) | 🔴 | — |
| 9 | M3 attribution scoring + correlation + candidates (M8) | 🔴 | — |
| 10 | Workspace UI shell: map, stores, timeline, screens (M9, M12) | 🔴 | — |
| 11 | 3D surfaces: globe, slick relief, prism | 🔴 | — |
| 12 | Reporting & exports (M10) | 🔴 | — |
| 13 | Demo staging, integration, E2E, load, a11y, hardening, rehearsal | 🔴 | — |

### MVP items (01 §8.1)

| Item | Description | Status | Evidence |
|---|---|---|---|
| M1 | Real S-1 scene ingested + preprocessed + shown as real raster tiles | 🔴 | — |
| M2 | Trained segmentation model produces a slick mask on that real scene | 🔴 | — |
| M3 | Mask vectorised to a georeferenced polygon with real km² | 🔴 | — |
| M4 | Real wind + current fields fetched for that date/region | 🔴 | — |
| M5 | Backward drift → origin probability surface + release-time window | 🔴 | — |
| M6 | Real AIS for that region/window from a public historical archive | 🔴 | — |
| M7 | ≥ 5 candidate vessel trajectories reconstructed + rendered | 🔴 | — |
| M8 | Candidates ranked with full per-factor evidence breakdown | 🔴 | — |
| M9 | Timeline replay works, synchronised across layers | 🔴 | — |
| M10 | PDF dossier exports with methodology + uncertainty + provenance | 🔴 | — |
| M11 | Model eval metrics (IoU/Dice/F1) on a held-out real test split | 🔴 | — |
| M12 | Every screen passes the provenance check | 🔴 | — |

### Workstream health

| Workstream | Status | Current focus | Blockers |
|---|---|---|---|
| Frontend `[FE]` | 🟡 | Vite shell + design tokens done. Next: primitives, stores, MapRoot (Phase 10). | — |
| Backend `[BE]` | 🟡 | Phase 1 done: models + provenance plugin + guard + geodesy. Next: connect Mongo on boot + Phase 2 auth/investigations. | needs local MongoDB running for integration tests |
| ML / geo `[ML]` | 🟡 | Phase 1 geodesy done (pyproj + shapely installed, known-answer suite green). Next: Pydantic contract mirrors, then SAR preprocessing (Phase 4). | — |
| DevOps / infra `[DevOps]` | 🟡 | Monorepo, CI, compose, policy checks authored. Next: verify cold `docker compose up`. | **Docker & git not installed** |
| Data `[Data]` | 🔴 | Not started. Next: submit MKLab request, verify demo-incident coverage. | — |

---

## 15.4 Environment & accounts (11 §11.11)

| # | Service | Registered | Credential in `.env` | Smoke test passed | Notes |
|---|---|---|---|---|---|
| A1 | Copernicus Data Space Ecosystem (CDSE) | 🔴 | 🔴 | 🔴 | OAuth client + token exchange |
| A2 | Microsoft Planetary Computer | 🔴 | ⚪ (anon ok) | 🔴 | STAC query works anonymously |
| A3 | NASA Earthdata Login | 🔴 | 🔴 | 🔴 | **accept dataset EULAs** in profile |
| A4 | Copernicus Marine Service (CMEMS) | 🔴 | 🔴 | 🔴 | `copernicusmarine subset` test |
| A5 | Copernicus Climate Data Store (ERA5) | 🔴 | 🔴 | 🔴 | **accept ERA5 licence on the dataset page** |
| A6 | Global Fishing Watch API | 🔴 | 🔴 | 🔴 | ⚠️ approval can take days — request now |
| A7 | AISStream.io | 🔴 | 🔴 | 🔴 | key issued instantly; server-side only |
| A8 | MongoDB (local replica set `rs0`) | 🔴 | 🔴 | 🔴 | Atlas M0 optional (512 MB cap) |
| A9 | Object storage — MinIO local / R2 hosted | 🔴 | 🔴 | 🔴 | bucket `varuna` created |
| A10 | Redis — local / Upstash | 🔴 | 🔴 | 🔴 | **verify `maxmemory-policy noeviction`** |
| A11 | Sentry | 🔴 | 🔴 | 🔴 | one project React, one Node |

**Hygiene**

- [ ] `.env` created from `.env.example`, confirmed in `.gitignore`
- [ ] gitleaks pre-commit hook installed
- [ ] JWT secrets generated with `openssl rand -base64 48` (not typed by hand)
- [ ] Every teammate has their own dev credentials (no shared personal accounts)
- [ ] All contributors signed the Real-Data Policy acknowledgement (13 §13.11): _(list names)_

---

## 15.5 Data acquisition (10 §10.8)

| Dataset / input | Needed for | Status | Notes |
|---|---|---|---|
| MKLab/CERTH Oil Spill Detection Dataset | M1 training (primary) | 🔴 | **request form submitted:** _(date)_ · approved: _(date)_ |
| SOS / Deep-SAR Oil Spill datasets | M1 cross-sensor / fallback | 🔴 | queue in parallel with MKLab |
| Sentinel-1 scenes (demo incident + prior clear date) | M1 detection, M11 | 🔴 | via MPC RTC preferred |
| CMEMS currents (incident window) | M2 drift | 🔴 | `GLOBAL_ANALYSISFORECAST_PHY_001_024` |
| ERA5 winds (incident window) | M2 drift + detectability gate | 🔴 | pre-fetch — CDS queues |
| Historical AIS slice (demo region/window) | M6, M7 | 🔴 | Marine Cadastre or Danish DMA |
| SRTM / Copernicus DEM (demo region) | SAR terrain correction | 🔴 | region-specific — after incident lock |
| GSHHG / OSM coastlines (demo region) | land masking | 🔴 | region-specific — after incident lock |
| ITU MID table | MMSI validation | 🟢 | vendored → `data/reference/mid-table.json` (+`.provenance.json`), 292 entries, sha256 recorded. **Community mirror — re-verify vs ITU before submission.** Re-fetch: `node scripts/data/fetch-reference.mjs mid-table` |
| Validated-incident ground truth | M3 labels + calibration | 🔴 | Phase 2 calibration — not MVP-blocking |

---

## 15.6 Demo incident decision (10 §10.6)

| Field | Value |
|---|---|
| **Selected incident** | _(not yet decided)_ |
| Date (UTC) | — |
| Location / AOI | — |
| Sentinel-1 coverage confirmed | 🔴 — product IDs: _(list)_ |
| Prior clear S-1 acquisition confirmed | 🔴 — product ID: _(one)_ |
| Free historical AIS coverage confirmed | 🔴 — source: _(Marine Cadastre / DMA / …)_ |
| Documented source / investigation reference | — |
| **Backup incident** | _(not yet decided)_ |
| Rationale | _(fill in — why this incident, per the 10 §10.6.2 selection criteria)_ |

> Reminder (10 §10.6): choose the incident by **AIS availability first**. Ideal is a Danish-
> or US-waters incident with free 1-minute AIS, then demonstrate the same pipeline on
> Ennore/Chennai for national relevance, being explicit about the AIS coverage difference.

### Sentinel-1 coverage checks (run 2026-08-28 via `scripts/data/search-scenes.mjs`, anonymous STAC — NO download)

| Candidate | Window checked | S-1 result | Free AIS | Verdict |
|---|---|---|---|---|
| **Ennore / Chennai** (collision ~28 Jan 2017) | 2017-01-25 → 02-08 | ✅ 1 scene `S1A_IW_GRDH_1SDV_20170129T003132…` 2017-01-29, **~100% AOI overlap**, VV+VH, IW desc | ⚠️ GFW only (Bay of Bengal) | Strong S-1; AIS is the open question — **verify GFW coverage for this bbox/date early** |
| **Danish straits** (example window) | 2023-08-12 → 08-18 | ✅ 9 scenes, best `…20230812T053316…` **~94% overlap**, dense revisit | ✅ DMA open, keyless | Best technical + data fit for building/validating the MVP |

Next: pick a specific documented Danish/US discharge incident with a confirmed source, re-run the check for its exact date, then decide. Backup still TBD.

---

## 15.7 Active blockers

| ID | Blocker | Blocks | Owner | Raised | Needed by | Status |
|---|---|---|---|---|---|---|
| B-001 | **Git not installed** on the dev machine (`git` not on PATH). No version control yet. | All — no commits, no branches, CI can't run against a repo | DevOps | 2026-08-28 | immediately | ⛔ Install Git for Windows, then `git init` at `e:\SIH` and make the first commit. |
| B-002 | **Docker Desktop not installed.** `docker` / `docker compose` unavailable. | Cold-start release criterion; local Mongo/Redis/MinIO/TiTiler; integration tests | DevOps | 2026-08-28 | before Phase 1 wiring (needs a running Mongo) | ⛔ Install Docker Desktop, then `docker compose up -d mongo redis minio`. |
| B-003 | MKLab/CERTH dataset request not yet submitted. | Phase 5 training | Data | 2026-08-28 | end of Week 2 | ⛔ Submit the request form (10 §10.2.1). |
| B-004 | Demo incident not selected; S-1 + free-AIS coverage unverified. | Phases 4/7/8/13, `stage:demo` | Data | 2026-08-28 | end of Week 1 | ⛔ See §15.6. |

When a blocker clears, move it to §15.9 Changelog with the resolution and set Status 🟢.

---

## 15.8 Decisions log (append-only)

Record decisions made **during the build** that are not already fixed by the specs, or that
resolve an ambiguity in them. One entry per decision. Never edit past entries.

| # | Date | Decision | Context / alternatives | Consequence | Supersedes |
|---|---|---|---|---|---|
| D-001 | 2026-08-28 | Working docs `IMPLEMENTATION_PLAN.md` (14) and `CONTEXT.md` (15) added to the suite; not yet linked from `00_INDEX.md`. | User asked for a detailed plan + a living context file. | Team tracks progress in CONTEXT.md; plan changes go through §14.14 change control. | — |
| D-002 | 2026-08-28 | Monorepo lives directly in `e:\SIH`; the numbered spec docs stay at repo root (not moved into `docs/` as IMPLEMENTATION_PLAN §14.2 sketched). | Moving 16 files would break the user's open IDE references and links between docs. | `.prettierignore` / `.gitleaks.toml` allow-list the `NN_*.md` pattern at root. §14.2's `docs/` is aspirational. | — |
| D-003 | 2026-08-28 | Task runner: `pnpm -r --stream` recursive scripts, **no Turborepo**. | Plan allowed "nx / npm scripts". Fewer moving parts for a hackathon; no binary download. | Root scripts (`build/dev/lint/typecheck/test`) fan out via pnpm. Add Turbo later only if CI caching is needed. | — |
| D-004 | 2026-08-28 | `check-real-data-policy` implemented in Node (`.mjs`), with a thin `.sh` wrapper calling it. | Reference impl in 13 §13.6 is bash; git-bash/WSL not present on the dev machine. | Same 6 checks, runs on Windows + Linux CI identically. Checks with nothing to inspect PASS (not a violation) until later phases populate them. | — |
| D-005 | 2026-08-28 | Local toolchain: Node 22.23 (plan targets 20 — `engines` set to `>=20.11`), Python 3.12.10 (plan targets 3.11 — `services/ml` pins `>=3.11`, CI uses 3.11). pnpm 9.15.9 installed via `npm i -g` (corepack blocked by `C:\Program Files` permissions). | Whatever was on the machine. | Watch for 3.12-only issues in the geospatial/ML stack at Phase 4/5; CI is the source of truth (3.11). | — |
| D-006 | 2026-08-28 | API is ESM + Express 5. `express-mongo-sanitize` replaced with a small custom `sanitizeMongo()` (body + params only). | Express 5 makes `req.query` read-only, breaking `express-mongo-sanitize`. | Query strings are validated by Zod at the boundary and never spread into a query object (enforced by a planned lint rule, §14.4). | — |
| D-007 | 2026-08-28 | Heavy Python deps (torch, rasterio, GDAL, OpenDrift, xarray…) deliberately **not** in `services/ml/pyproject.toml` yet — only FastAPI + pydantic + (Phase 1) numpy/pyproj/shapely. | Keep the skeleton installable fast; add per phase. | `pyproject.toml` comments list which deps land in which phase. | — |
| D-008 | 2026-08-28 | Geodesic **distance/length/area** on the Node side uses **`geographiclib-geodesic`** (Karney), not `@turf/distance`. Turf is kept only for topology (buffer, rewind, point-in-polygon, nearest-point-on-line). | 02_TRD §2.6.3 lists "Turf" for geodesic distance, but `@turf/distance` is spherical haversine (~0.5% off the WGS84 ellipsoid for 1°) — it could never agree with `pyproj.Geod` within the mandated 0.1%. GeographicLib is the same algorithm PROJ/pyproj use. | Cross-stack known-answer suite (`packages/shared/geo-known-answers.json`) passes < 0.1% on both stacks. Turf's spherical `area` is exposed as `approxPolygonAreaKm2` for the AOI size guard only. | refines 02_TRD §2.6.3 |
| D-009 | 2026-08-28 | `provenanceGuard` **strips** objects with invalid provenance (→ `__provenanceMissing` marker) and logs severity-1, rather than throwing a 500 for the whole response. | 02_TRD TR-P3 says "strips and logs ... rather than emitting it"; the FE `<DataObject>` then renders the loud panel for just that object. A whole-response 500 is harsher than the spec's intent. | `X-Provenance-Stripped` header signals it happened; the ProvenanceError→500 path in `errorHandler` remains for cases where a guard elsewhere decides to throw. | — |

---

## 15.9 Changelog (append-only, newest first)

### 2026-08-28 — Phase 1: data-plane spine (code-complete, DB-verify pending)
- **Geodesy — the CI gate.** `packages/shared/geo-known-answers.json` is the cross-stack contract (values from GeographicLib/Karney). Node side (`apps/api/src/geo/geodesy.ts`) uses `geographiclib-geodesic`; Python side (`services/ml/varuna_ml/geo/geodesy.py`) uses `pyproj.Geod` — same algorithm. Both test suites assert the same references within 0.1% (equator quarter, 1° meridian arc, Wellington→Salamanca 19959679.27 m, 1°×1° cell 12308.78 km²). `envelope.ts` (Turf buffer + rewind), `trackGeometry.ts` (point-to-polygon-edge distance — the thing MongoDB can't do), `projections.py` (local LAEA for morphology). Installed: `@turf/turf`, `geographiclib-geodesic`, `pyproj`, `shapely`.
- **Mongoose models.** `db/schemas/geojson.ts` — Point/LineString/Polygon sub-schemas with closed-ring + **right-hand-rule winding** validators (a CW polygon is rejected with a message citing the "matches the whole globe" bug). `db/plugins/provenance.ts` — `ProvenanceSchema` + `provenancePlugin` `pre('validate')` hook (rejects missing / incomplete / forbidden `sourceType`; `SOURCE_TYPES` imported from `@varuna/shared` so they can't drift). 11 models under `apps/api/src/modules/*/model.ts`: provenance-record (immutable), audit-log (append-only), investigation, job, satellite-scene, spill-detection, vessel, vessel-track, origin-estimate, candidate-vessel — provenance plugin applied to the 6 that store observed/derived data. `db/models.ts` barrel + `db/bootstrap.ts` (creates `ais_positions` **time-series** collection with `meta.mmsi`+`t` / `2dsphere` / `t` indexes, ensures all model indexes; idempotent; `verifyAisTimeSeries()`).
- **Provenance enforcement.** `modules/provenance/service.ts` — `recordProvenance()` (Zod-validated, dedup on externalId, writes immutable record) + `derivedProvenance()`. `middleware/provenanceGuard.ts` — patches `res.json`, deep-walks payloads, strips any object with invalid provenance → `{ _id, __provenanceMissing: true }` marker, sets `X-Provenance-Count` / `X-Provenance-Stripped`, logs severity-1. Wired into `app.ts` on `/api/v1` before routes.
- **Frontend.** `apps/web/src/lib/provenance.ts` (`assertProvenance` — throws on stripped markers / incomplete provenance, called by `apiFetch` before data reaches a component) + `components/DataObject.tsx` (deliberately-ugly red PROVENANCE MISSING panel) + `.provenance-missing` CSS + tests (jsdom + @testing-library/react added).
- **Verified green:** typecheck 4/4, **59 JS tests** (shared 24, api 29, web 6), **11 Python tests** (health 3, geodesy 8), lint 0 errors, prettier, real-data policy (6/6), token sync. ESLint config: test files exempted from the `sourceType`-literal ban so they can assert `'MOCK'` is rejected.
- **Not yet verifiable (no running Mongo):** `ais_positions` actually created as time-series; a wrongly-wound polygon's `$geoWithin` really matching everything; ingest→… integration chain.

### 2026-08-28 — Data acquisition kickoff (what could be done without accounts)
- **Vendored** the ITU MMSI MID table → `data/reference/mid-table.json` (24 KB, 292 entries) + `mid-table.provenance.json`. Community mirror (`github.com/michaeljfazio/MIDs`), flagged for re-verification against ITU. Needed for `MMSI_INVALID` validation (Phase 8).
- **`scripts/data/search-scenes.mjs`** — anonymous Planetary Computer STAC search, no key, no download. Ran it for two candidate incidents: Ennore/Chennai (✅ 1 S-1 scene, ~100% overlap, 2017-01-29) and Danish straits (✅ 9 scenes, ~94% overlap). Results in §15.6.
- **`scripts/data/fetch-reference.mjs`** — re-fetch + checksum + provenance-sidecar the keyless reference data.
- `scripts/data/README.md` — acquisition matrix (what needs which credential; what cannot be scripted).
- **Still blocked:** MKLab dataset (manual form, B-003), all credentialed providers (accounts not created), incident-specific S-1/AIS/CMEMS/ERA5 (no incident locked, B-004).

### 2026-08-28 — Monorepo scaffold (Phase 0 code + partial Phase 1)
- **Root:** pnpm workspaces, `tsconfig.base.json` (strict, NodeNext), ESLint 9 flat config with VARUNA guardrails (ban fake-data imports, ban forbidden `sourceType` literals), Prettier, `.gitignore` / `.editorconfig` / `.nvmrc` / `.npmrc`, full `.env.example` (11 §11.6), `README.md`.
- **`packages/shared`:** `units.ts` (branded `Longitude`/`Latitude`/`Kilometres`/`SquareKm`/`Knots`/`DegreesTrue`/`UtcIso` + constructors), `constants.ts` (tiers, `MIN_MEASURED_FEATURES=6`, 12 attribution features summing to 1.00, provider chains, job queues, AIS sentinels, RBAC ranks), 8 Zod contracts (`provenance`, `geojson`, `investigation`, `satellite-scene`, `spill-detection`, `ais-position`, `vessel-track`, `origin-estimate`, `candidate-vessel`, `job`). **24 tests pass** (provenance has no fabricated sourceType; weights sum to 1; closed-ring validation; UTC-with-Z; coord ranges).
- **`apps/api`:** `env.ts` (Zod boot validation, `process.exit(1)` on missing required, `assertProviderChains` warns-not-exits), middleware chain per 06 §6.2 (`requestId` → `pino-http` → `helmet`/CSP → `cors` → `json` → `cookieParser` → `sanitizeMongo` → `rateLimit` → routes → errorHandler), typed errors (`ProviderUnavailable` with `consequence`, `ProvenanceError` = severity-1, `HttpError` family), RFC 9457 handler, health module. **4 tests pass**; **boots clean** in dev (pino-pretty, provider-chain warnings, `/health` 200).
- **`apps/worker`:** bootstrap stub listing the 6 queues; processors land Phases 4–12.
- **`apps/web`:** Vite + React 18 + TS shell; full design-token set `tokens.css` (04 §4.3.2) + typed mirror `tokens.ts`; `tokens-sync-check` passes (32 colours consistent).
- **`services/ml`:** FastAPI app, `config.py` (pydantic-settings), `security.py` (`X-Service-Token` guard), `provenance.py` (Pydantic mirror + `derived()` helper), health router. **pytest suite** (health + no-fabricated-sourceType); all `.py` compile.
- **infra:** `docker-compose.yml` (mongo replica set + init, redis `noeviction`, minio + createbuckets, titiler, mlflow, api, worker, web), Dockerfiles (api multi-stage, web nginx, ml slim), `nginx.conf`, `.dockerignore`. **Untested — Docker not installed (B-002).**
- **CI:** `.github/workflows/ci.yml` (node lint/format/typecheck/test/token-sync, real-data policy, gitleaks, python ruff/black/pytest) + `.gitleaks.toml` allow-list.
- **Policy:** `scripts/check-real-data-policy.mjs` (6 checks) — **PASS**. `data/manifests/dataset_manifest.yaml` skeleton (MKLab entry, sha256/retrieved_at `PENDING_DOWNLOAD`).
- **Green gates:** `pnpm typecheck` (4/4), `pnpm test` (28 tests), `pnpm lint` (0 errors), `pnpm format:check`, `check:real-data`, `check:tokens`, Python `py_compile`.
- **Next:** install Git + Docker (B-001/B-002); bring up Mongo; Phase 1 — Mongoose models + `provenancePlugin` + GeoJSON winding validator + `ais_positions` time-series bootstrap + geodesy known-answer suite (Turf + pyproj) + `provenanceGuard` + `<DataObject>`.

### 2026-08-28 — Planning
- Created `IMPLEMENTATION_PLAN.md` (14 phases, MVP + release-criteria traceability, testing strategy, risk register) and this `CONTEXT.md` living status file.

---

## 15.10 Open questions

| # | Question | Owner | Needed by | Answer |
|---|---|---|---|---|
| Q-001 | Which demo incident (and backup)? Depends on confirming S-1 **and** free AIS coverage together. | Data | end of Week 1 | — |
| Q-002 | GPU availability for M1 training (own machine / Colab / cloud spot)? | ML | Week 2 | — |
| Q-003 | Hosted demo target (Fly.io / Render / Railway) or local-only for the presentation? | DevOps | Week 8 | — |
| Q-004 | Do we run MongoDB Atlas M0 for a hosted showcase with a reduced AIS slice, or local-only? (11 A8 constraint) | BE | Week 8 | — |
| Q-005 | SNAP in-container vs rely entirely on MPC RTC for preprocessing? (RTC removes the SNAP dependency from the critical path — 07 §7.2.4) | ML | Phase 4 | — |
| Q-006 | Install Git for Windows + Docker Desktop on this machine, or develop on a different machine / WSL2? Blocks version control and the local datastore stack. | DevOps | immediately | — |

---

## 15.11 Risk status (mirror of IMPLEMENTATION_PLAN §14.12 — update as it changes)

| # | Risk | Status | Latest note |
|---|---|---|---|
| R1 | Look-alikes misclassified as oil | 🟡 open | design mitigations planned Phase 5/6; not yet built |
| R2 | AIS gaps/spoofing hide the vessel | 🟡 open | F5 dark-period feature planned Phase 8/9 |
| R3 | Drift error → wrong origin zone | 🟡 open | sampled-ensemble probability field planned Phase 7 |
| R4 | Insufficient labelled training data | 🟠 watch | hinges on MKLab approval — see B-001 / §15.5 |
| R5 | API quota exhaustion mid-demo | 🟡 open | `stage:demo` + quota tracking planned Phase 3/13 |
| R6 | Attribution misused as proof of guilt | 🟡 open | tier labels + mandatory uncertainty + INSUFFICIENT_EVIDENCE planned Phase 9/12 |
| R7 | MongoDB lacks polygon-distance functions | 🟡 open | Turf/Shapely compensation layer planned Phase 1 |
| R8 | Data volume (1 GB scenes, 10⁷ AIS rows/mo) | 🟡 open | COG + time-series + partitions planned Phase 1/4/8 |
| R9 | Timezone/CRS errors corrupting correlation | 🟡 open | known-answer geodesy CI gate planned Phase 1 |
| R10 | Judges assume the demo is faked | 🟡 open | live provenance inspector planned Phase 10/13 |

---

## 15.12 Demo-readiness checklist (fill in during Phase 13)

- [ ] `pnpm run stage:demo` pre-stages the real scene(s), AIS slice, currents, winds — checksums match originals
- [ ] Full pipeline runs live on pre-staged inputs (results **not** pre-computed) within ~12 min
- [ ] 08 §8.9 demo script rehearsed and timed
- [ ] Provenance inspector opens on every on-screen object
- [ ] Live catalogue search against a judge-chosen date works
- [ ] Honest-null journey (08 §8.3) demonstrable on request
- [ ] `INSUFFICIENT_EVIDENCE` case demonstrable
- [ ] PDF dossier opens to the Uncertainty + Provenance appendices
- [ ] Offline-safe: demo does not depend on provider uptime / quota
- [ ] All 15 docs current with the shipped build
