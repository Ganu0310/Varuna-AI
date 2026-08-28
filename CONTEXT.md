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
| **Updated by** | Phases 12-13 (Claude) |
| **Current phase** | **Phases 0-10, 12, 13 done.** Phase 11 (3D) deliberately skipped; Phase 14 partial. |
| **Repo** | https://github.com/Ganu0310/Varuna-AI — `main`. Git 2.55; Credential Manager auth working. |
| **Overall status** | 🟢 The full chain runs live on the real Guam 2025-09-21 incident: real S1C scene -> COG in MinIO -> TiTiler tiles -> classical detection -> degraded origin -> 9,711 real AIS positions -> ranked candidates with CIs -> print-ready dossier with mandatory uncertainty + provenance. **223 tests** (189 JS + 55 Python, minus overlap). `pnpm run stage:demo` caches real inputs so the demo is offline-safe. |
| **Local infra** | mongod 8.3.7 **standalone** on `localhost:27017` db `VARUNA` (native, user-run — no transactions, D-013) · Redis 7 container (noeviction ✅) · MinIO container (`varuna` bucket ✅) · Docker engine 29.7.2 |
| **Days to submission** | (fill in) |
| **Biggest current risk** | Origin estimate is DEGRADED (no current field for 2025-09-21), which caps every candidate at MODERATE and weakens attribution. Detector has no measured metrics. Both are stated in the UI and the report. |
| **Next milestone** | CMEMS + CDS credentials to lift drift from DEGRADED to real back-tracking - the single highest-value remaining change. Then Zenodo Part III (9.9 GB) to give the detector measured metrics. |

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
| docker-compose | `docker-compose.yml` + Dockerfiles. redis/minio/createbuckets **verified running**; mongo skipped (D-013); titiler/mlflow/api/worker/web not yet started | 🟡 partly verified |
| DB CLI | `apps/api/src/db/cli.ts` — `pnpm --filter @varuna/api db:bootstrap` | 🟢 |
| Integration tests | `apps/api/src/**/*.integration.test.ts` + `vitest.integration.config.ts` — `pnpm --filter @varuna/api test:integration` | 🟢 16 tests |
| Local `.env` | repo root, git-ignored, real local values | 🟢 |
| CI pipeline | `.github/workflows/ci.yml` + `.gitleaks.toml` | 🟢 authored |
| Providers | `apps/api/src/providers/` — ProviderClient, circuitBreaker, quota, cdse, planetaryComputer, asf, chain, geoUtil, types | 🟢 24 tests |
| Catalogue API | `apps/api/src/modules/catalogue/` — live search + provider health | 🟢 verified live |
| Catalogue UI | `apps/web/src/features/catalogue/` — page, panel, results, status strip, health table | 🟢 |
| Real fixtures | `apps/api/src/__fixtures__/real/` — captured provider responses + provenance siblings, checksum-verified | 🟢 1 fixture |
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
| 1 | Data-plane spine: models, provenance, geodesy | 🟢 **DONE** (all exit criteria met, DB-verified) | **Done:** 8 Zod contracts + branded units + constants; `provenancePlugin` (pre-validate rejects missing/incomplete/forbidden-sourceType — tested without DB); GeoJSON Mongoose sub-schemas with closed-ring + **right-hand-winding** validator (tested); all 11 Mongoose models (`modules/*/model.ts`) + `db/models.ts` barrel; `db/bootstrap.ts` (creates `ais_positions` time-series + all indexes, idempotent); `provenanceService.recordProvenance` (dedup on externalId, immutable) + `derivedProvenance`; `provenanceGuard` middleware (strips objects with invalid provenance → `__provenanceMissing` marker, `X-Provenance-Count`/`X-Provenance-Stripped` headers, severity-1 log — tested via supertest); wired into `app.ts` before routes. **Geo:** `apps/api/src/geo/` (geodesy via GeographicLib, envelope buffer+rewind, trackGeometry point-to-line); Python `varuna_ml/geo/` (pyproj geodesy + LAEA projections). **Known-answer geodesy suite is a CI gate** — same `packages/shared/geo-known-answers.json` asserted by both stacks, agree < 0.1%. FE `lib/provenance.ts` (`assertProvenance`) + `<DataObject>` boundary (deliberately-ugly PROVENANCE MISSING panel) + tests. **DB-verified 2026-08-28** against mongod 8.3.7: `bootstrapDatabase()` runs idempotently, `ais_positions` confirmed time-series (`timeField:t`, `metaField:meta`, `granularity:seconds`) with all three indexes, spec-named snake_case collections created (D-012), provenance rejected/accepted correctly on real `save()`, winding semantics measured and pinned (D-011). 16 integration tests in `*.integration.test.ts`, run separately from the unit suite and in CI against a `mongo:8` service. |
| 2 | Platform: auth, RBAC, investigations, jobs, realtime | 🟢 **DONE** (all exit criteria met, smoke-tested live) | **Auth:** argon2id (m=19456,t=2,p=1) via `@node-rs/argon2`; JWT access 15 min (jose) + opaque refresh 7 d stored SHA-256-hashed, rotated on use, **reuse ⇒ whole family revoked**; httpOnly/SameSite=Strict cookies, refresh cookie scoped to `/api/v1/auth`; constant-ish-time login (dummy-hash verify on unknown email, identical error wording). **RBAC:** `rbac(role)` deny-by-default + `requireInvestigationAccess` (404 not 403 for invisible resources); **22-case matrix test**. **Validate:** Zod `.strict()` boundary, parsed value replaces input, `validatedQuery`/`param` accessors (Express 5 read-only query). **Investigations:** full CRUD + summary + members + audit; geodesic AOI cap naming the exact overage; 30-day window cap; winding normalised on write; scope-change returns a `SCOPE_CHANGED` warning. **Queues:** BullMQ 6 queues w/ per-queue retry/backoff from shared constants, deterministic `jobKey` idempotency, `jobs` collection mirror, cancel/retry. **Realtime:** Socket.IO `/jobs` `/investigations` `/ais` with JWT-from-cookie handshake + membership-checked room joins; QueueEvents→Socket bridge (worker is a separate process). **OpenAPI 3.1** generated from Zod, served at `/api/v1/openapi.json` (12 paths). **Rate limits** as SEC-5, raised (never removed) under NODE_ENV=test. **Frontend:** `apiFetch` (provenance-asserting), TanStack Query hooks, SocketProvider w/ stale banner, login/register/list/create pages, formatters (T3/T4/T5), GeoJSON paste+validate. |
| 3 | Providers + live catalogue search | 🟢 **DONE** (exit criteria met live) | **ProviderClient** base: circuit breaker (5 consecutive failures / 60 s reset / single half-open probe), retry with exponential backoff (1→2→4 s) on transient status + network errors only, Redis-backed `QuotaTracker` (soft limits from 11 §11.8, warns at 80%, `QuotaExhausted` → chain advance), latency sampling for p95, and logging that never carries a credential. **Clients:** `PlanetaryComputerClient` (anonymous STAC, `sentinel-1-rtc` flagged `preprocessed`), `CdseClient` (OAuth2 client-credentials, token cached in Redis with a 60 s safety margin, OData+WKT search), `AsfClient` (open search; Earthdata only needed to download). **Chain** (`providers/chain.ts`): providers queried **in parallel**; a FAILURE advances, **zero results does NOT** — an empty answer is a real statement about coverage. Dedupe by normalised productId (`.SAFE` tolerated), RTC duplicate wins over chain order, sorted by acquisition time. Chain exhaustion throws with `attempted[]` + a `consequence` string. **API:** `GET /catalogue/search` (live, nothing persisted, per-provider status) and `GET /catalogue/providers` (circuit, quota, p95, last success). OpenAPI updated (14 paths). **Fixtures:** `capture-fixture.mjs` captures a real provider response + `.provenance.json`; policy check 3 now **verifies the recorded sha256 still matches the bytes** (D-020). **FE:** `/catalogue` page, `CataloguePanel` (three distinct outcomes: results / no-coverage / unreachable), `ProviderStatusStrip`, `ProviderHealthTable`, and the create-wizard Review step now runs a **real** search. |
| 4 | ML service + SAR preprocessing + scene ingest E2E (M1) | 🔴 | — |
| 5 | M1 oil-slick segmentation (M2, M3, M11) | 🔴 | — |
| 6 | Detections module (BE + FE review) | 🔴 | — |
| 7 | Environmental data + M2 drift + origin field (M4, M5) | 🔴 | — |
| 8 | AIS ingestion + track reconstruction (M6, M7) | 🔴 | — |
| 9 | M3 attribution scoring + correlation + candidates (M8) | 🔴 | — |
| 10 | Workspace UI shell: map, stores, timeline, screens (M9, M12) | 🔴 | — |
| 11 | 3D surfaces: globe, slick relief, space-time prism | ⚪ **SKIPPED** | Deliberate. Presentation surfaces with no evidential weight; the time went to Phases 12-13 instead. The slick-relief honesty caption ('relief encodes SAR backscatter, not sea-surface height') is worth keeping if 3D is revisited. |
| 12 | Reporting & exports | 🟢 **DONE** | Mandatory UNCERTAINTY + PROVENANCE enforced in three places; derived (not boilerplate) uncertainty statement; GeoJSON/CSV/manifest exports carrying provenance inline; print-ready A4 light-theme dossier reusing the workspace EvidenceWaterfall. |
| 13 | Demo staging, integration, E2E, load, a11y, hardening | 🟡 partial | `stage:demo` verified end to end (real scene + 9,711 real AIS in 5.5 s), caching inputs only so results still run live. Not done: Playwright E2E, k6 load, axe-core, cold-start test. |

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
| A8 | MongoDB (local) | 🟢 | 🟢 | 🟢 | mongod **8.3.7 standalone** (not a replica set — no transactions, D-013/Q-009), db `VARUNA`, bootstrapped + verified |
| A9 | Object storage — MinIO local / R2 hosted | 🟢 | 🟢 | 🟢 | Docker container `varuna-minio-1`, bucket `varuna` **created & listed** |
| A10 | Redis — local / Upstash | 🟢 | 🟢 | 🟢 | Docker container `varuna-redis-1`, `maxmemory-policy=noeviction` **verified**, PING OK |
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
| B-001 | ~~Git not installed~~ | — | DevOps | 2026-08-28 | — | 🟢 RESOLVED — Git 2.55 installed via winget; repo pushed to https://github.com/Ganu0310/Varuna-AI (`main`, `ad7758a`). Git on this shell needs `$env:Path = "C:\Program Files\Git\cmd;$env:Path"` per session (installer ran after the shell started). |
| B-002 | ~~Docker Desktop not installed~~ | — | DevOps | 2026-08-28 | — | 🟢 RESOLVED — Docker Desktop 4.88.1 installed via winget; engine 29.7.2 + Compose v5.4.0 running. `docker compose up -d redis minio createbuckets` verified: Redis healthy w/ `noeviction`, MinIO healthy w/ `varuna` bucket. Compose `mongo` service deliberately NOT started (port conflict with the native mongod — D-013). Cold-start release criterion still untested end-to-end. |
| B-005 | **CDSE + NASA Earthdata accounts not created.** The catalogue chain runs on Planetary Computer + ASF only; CDSE reports `NOT_CONFIGURED` and ASF cannot download. | Full 3-provider redundancy; Phase 4 download fallback | DevOps | 2026-08-28 | before Phase 4 hardening | ⛔ Register at dataspace.copernicus.eu (OAuth client) and urs.earthdata.nasa.gov (**accept the EULAs** — 11 §11.11 A3), then fill `.env`. Not blocking Phase 4 start: MPC downloads anonymously. |
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
| D-010 | 2026-08-28 | **Version control workflow:** commit straight to `main` (no PR flow for this solo hackathon repo). One commit per completed phase — message `feat: Phase N — <title>` — that also bumps CONTEXT.md. Push after every phase. Initial import was a single commit; phase-by-phase history starts at Phase 2. | User: "update the repo each time we complete a phase." | Clean, legible history aligned to IMPLEMENTATION_PLAN phases. See §15.13. | — |
| D-011 | 2026-08-28 | ⚠️ **The polygon-winding claim in 06_BACKEND §6.3.2 and 12 F-10 is FALSE as written on MongoDB 8.** Measured on 8.3.7: with the **default CRS** a clockwise single-ring query polygon is NOT the globe complement — MongoDB ignores orientation and takes the smaller region, so CW and CCW return identical results. The server also accepts either winding on insert into a `2dsphere` index. The complement behaviour occurs **only** under the opt-in `urn:x-mongodb:crs:strictwinding:EPSG:4326` CRS (verified: CW + strictwinding → matched the far-away point, not the inside one). **Decision: keep the winding validator + `rewindPolygon`, correct the rationale.** | The claim was inherited from the spec and asserted in an integration test, which then failed against real MongoDB. Rather than bend the test, the behaviour was probed directly (4 query variants × 2 storage variants). | Validator retained for reasons that ARE true: RFC 7946 §3.1.6 mandates RHR for the GeoJSON we export (QGIS/Turf/Shapely care); Turf predicates depend on winding; and the catastrophe becomes live the moment strictwinding is used, which is required for an AOI larger than a hemisphere. Since MongoDB won't enforce it, our validator is the only guard. Both behaviours are now pinned in `geo/winding.integration.test.ts` so a server-version change is caught. **Docs 06 §6.3.2 and 12 F-10 need correcting — 12 is presentation material and currently contains a claim a judge could falsify.** See Q-008. | corrects 06_BACKEND §6.3.2, 12 F-10 |
| D-012 | 2026-08-28 | Mongoose models pin explicit snake_case `collection:` names (`satellite_scenes`, `spill_detections`, `vessel_tracks`, `origin_estimates`, `candidate_vessels`, `provenance_records`, `audit_log`). | Mongoose's default pluraliser produced `satellitescenes`, `auditlogs`, … which do not match the collection names in 02_TRD §2.5.1 that the index table and raw-driver queries reference. | Bootstrap now creates exactly the collections the spec names; asserted in `bootstrap.integration.test.ts`. Stale pluralised collections were dropped from the local `VARUNA` db. | — |
| D-018 | 2026-08-28 | Catalogue providers are queried **in parallel**, not sequentially, and results are merged. | 06 §6.5.1 describes an ordered fallback chain. Sequentially, a slow or hanging provider delays a fast one while an analyst waits, and a partial failure silently shrinks the result set. | All configured providers are hit at once; `providerStatus[]` reports each outcome; the chain ORDER is preserved where it matters (dedupe tie-breaking). Failure still advances, zero-results still does not. | refines 06 §6.5.1 |
| D-019 | 2026-08-28 | A duplicate product that is already **preprocessed (RTC)** wins over chain order during dedupe. | CDSE is the authoritative catalogue and sits first in the chain, but its GRD products need ~10 min of SNAP preprocessing each; MPC's `sentinel-1-rtc` is already radiometrically terrain corrected (07 §7.2.4). | Same acquisition, same provenance-verifiable product — we keep the copy that costs less to ingest. Chain order still decides between two equally-processed copies. | — |
| D-020 | 2026-08-28 | The real-data policy check now **verifies each fixture's recorded sha256 against the bytes on disk**, and `__fixtures__/real/` is excluded from Prettier. | Prettier reformatted the captured provider response, silently invalidating the checksum recorded in its `.provenance.json`. A captured response is evidence; if its bytes change it can no longer be cited (13 §13.7). | Any post-capture modification — including reformatting — now fails CI with an instruction to re-capture rather than edit. Caught its own first violation on the run that introduced it. | strengthens 13 §13.6 check 3 |
| D-014 | 2026-08-28 | Password hashing uses **`@node-rs/argon2`** rather than the `argon2` npm package. | Both give argon2id. `argon2` needs node-gyp/MSVC on Windows; `@node-rs/argon2` ships prebuilt Rust binaries. Verified it produces `$argon2id$v=19$m=19456,t=2,p=1$…` — the exact 02_TRD SEC-1 parameters. | Zero native build chain on any dev machine. `Algorithm.Argon2id` is an ambient const enum that `isolatedModules` forbids importing, so the literal `2` is used with a comment and asserted by the hash prefix in tests. | — |
| D-015 | 2026-08-28 | **`mongoose.set('sanitizeFilter')` is deliberately OFF.** | It was enabled as "defence in depth" in Phase 1 and broke the server's own `$in` in Phase 2 — it rewrites any `$`-prefixed value as `$eq`, including our legitimate `$gte`, `$geoWithin`, `$or`. | Injection is prevented exactly where 02_TRD SEC-8 / 06_BACKEND §6.9 put it: `sanitizeMongo` strips `$`/dotted keys from user **input**, Zod validates every boundary, and no user string is spread into a query object. | supersedes the Phase 1 setting |
| D-016 | 2026-08-28 | On investigation-scoped routes the global gate is `rbac('analyst')` and the "lead" requirement is enforced by `requireInvestigationAccess('lead')`. | 06 §6.4.2's Role column says "lead" for PATCH/DELETE/members/audit. Read as a *global* role it locks the creator (an analyst) out of their own investigation — caught by an integration test returning 403. | "lead" is a per-investigation role. Global role = may you use the feature; investigation role = may you do it *here*. | clarifies 06 §6.4.2 |
| D-017 | 2026-08-28 | Rate limits are raised ×1000 under `NODE_ENV=test`, never removed; the production values live in an exported `RATE_LIMITS` constant asserted by a unit test. | Integration suites drive dozens of auth requests from one IP and were tripping the real 10/min limit (correct behaviour, wrong context). | The middleware still runs and still counts in tests; the real numbers cannot drift silently, and a separate test proves the limiter still 429s. | — |
| D-013 | 2026-08-28 | Dev uses the **user's native mongod** (8.3.7, standalone) on `mongodb://localhost:27017`, db `VARUNA`. The compose `mongo` service (replica set `rs0`) is NOT started, to avoid a port-27017 conflict. | User has mongod already running and asked for it to be used. | **Standalone means no multi-document transactions.** Fine for Phases 1–2; if a later phase needs a transaction, either start the compose mongo on a different port or convert the native instance to a single-node replica set. Recorded as Q-009. | — |

---

## 15.9 Changelog (append-only, newest first)

### 2026-08-28 — Phases 12 & 13: report dossier and demo staging
- **Report (Phase 12).** UNCERTAINTY and PROVENANCE are structurally mandatory, enforced in the Zod schema, in `buildReportData`, and in the report page which renders both with no toggle. The uncertainty statement is DERIVED from recorded state, not boilerplate: a DEGRADED origin, fewer than five transmitting vessels, an uncalibrated model, and the classical detector's absent metrics each generate their own caveat, so the text cannot go stale.
- **Exports.** GeoJSON carries provenance inline per feature and the degradation reason on the origin polygon (so a proximity buffer is not mistaken for a drift zone in QGIS). CSV is long format with a status column — a wide table's blank cell is indistinguishable from a zero. The manifest pins scene IDs, detector SHA, weight profile and AIS source, and travels with the uncertainty statement.
- **Report page** renders the exact print DOM in light theme at A4, reusing the workspace's `<EvidenceWaterfall>` so printed and on-screen evidence cannot diverge. Product IDs wrap rather than truncate.
- **Demo staging (Phase 13).** `pnpm run stage:demo` verified end to end: stages the real S1C AOI window to MinIO with provider provenance, and imports 9,711 real AIS positions in 5.5 s. It caches inputs ONLY — detections, origin and rankings still run live, so the demo cannot show a prepared result. Forcing is explicitly NOT staged, with the HYCOM coverage gap stated in the output.
- **Phase 11 (3D) deliberately skipped.** The globe, slick relief and space-time prism are presentation surfaces; with the time available they would have come at the cost of the report and demo staging, which carry evidential weight. The one 3D idea worth keeping is the slick-relief honesty caption ("relief encodes SAR backscatter, not sea-surface height") — recorded here so it is not lost.
- **Phase 14 partial.** CI, lint, formatting, real-data policy and secret-scanning gates are live. Not done: k6 load tests, Playwright E2E, axe-core audit, cold-start verification.


### 2026-08-28 — Phase 3 COMPLETE: providers + live catalogue search
- **`ProviderClient` base** (`apps/api/src/providers/`): every external call goes through one path that applies quota accounting, retry, a circuit breaker, latency sampling and credential-safe logging. Retry is **exponential (1→2→4 s) and only for transient failures** — a 400 or 404 is a real answer and is not retried. The circuit opens on 5 *consecutive* failures, resets after 60 s, and admits exactly one half-open probe.
- **`QuotaTracker`** (Redis, shared across replicas): soft limits from 11 §11.8 deliberately below each provider's real ceiling, TTL set with `NX` so the window is not pushed forward on every call, warns past 80%, and raises `QuotaExhausted` → the chain treats it as unavailable and moves on. Discovering a quota ceiling mid-demonstration is the failure mode this designs out.
- **Three clients.** `PlanetaryComputerClient` — anonymous STAC, so it works today with no account; items from `sentinel-1-rtc` are flagged `preprocessed` because RTC removes ~10 min of SNAP work per scene. `CdseClient` — OAuth2 client-credentials with the token cached in Redis at `expires_in − 60 s`; the token-exchange error body is never logged because it can echo the client id. `AsfClient` — search is open, Earthdata is only needed to download, and that distinction is surfaced rather than reporting the provider unusable.
- **The chain rule** (`providers/chain.ts`), which is the point of the phase: a provider **failure** advances the chain; a provider returning **zero results does not**, because an empty answer is a real statement about coverage and masking it behind another provider's data would misrepresent it. Providers are queried in parallel (a slow one must not delay a fast one) and every outcome is reported per provider. Chain exhaustion throws with `attempted[]` and a `consequence` string — never a fabricated result.
- **Dedupe:** the same acquisition is listed by several providers. One record survives, keyed on a normalised product id (tolerating CDSE's `.SAFE` suffix); chain order decides, **except** that an RTC/preprocessed duplicate always wins.
- **API:** `GET /api/v1/catalogue/search` (live, nothing persisted, returns `items[]` + `providerStatus[]`) and `GET /api/v1/catalogue/providers` (circuit state, quota consumed, p95 latency, last success — reporting "not configured" honestly rather than green ticks). Both registered in OpenAPI (now 14 paths).
- **Fixtures:** `scripts/data/capture-fixture.mjs` captures a **real** provider response with a `.provenance.json` sibling (13 §13.7). Normalisation is tested against that captured Sentinel-1 answer; where a failure is needed the **transport** is simulated, never the content of an observation.
- **Policy check strengthened (D-020):** check 3 now verifies each fixture's recorded sha256 still matches the bytes on disk. It caught its own first violation immediately — Prettier had reformatted the captured fixture, silently invalidating its checksum. `__fixtures__/real/` is now in `.prettierignore` and the fixture was re-captured, not hand-edited.
- **Frontend:** `/catalogue` page; `CataloguePanel` keeps three outcomes visually distinct (scenes found / providers answered with no coverage / no provider reachable, the last showing `attempted[]` and the consequence); `ProviderStatusStrip`; `ProviderHealthTable`; and the create-wizard Review step now runs a **real** catalogue search instead of the Phase 2 placeholder. Product IDs are rendered in full and never truncated — they are what an evaluator uses to find the same acquisition.
- **Verified live** (Ennore/Chennai AOI, 2017-01-25→02-08): returns the real product `S1A_IW_GRDH_1SDV_20170129T003132_20170129T003157_015039_01892E` at 100% AOI overlap, deduped across MPC and ASF which both listed it, with CDSE reporting `NOT_CONFIGURED`. A mid-Pacific AOI returned **0 items with both providers reporting NO_RESULTS** — an honest empty answer, not a fallback. Quota counters incremented in Redis (`PLANETARY_COMPUTER:catalogue 2/1000`). Invalid AOI rejected at the boundary with a message naming the expected coordinate order. No credential appeared in any log, and the client bundle references only `VITE_API_URL`.
- **Gates green:** typecheck 4/4 · unit **138** (shared 24, api 93, web 21) · integration **35** · Python **11** · lint · prettier · real-data policy 6/6 · token sync · web build.

### 2026-08-28 — Phase 2 COMPLETE: platform (auth, RBAC, investigations, jobs, realtime)
- **Auth** (`modules/auth`): argon2id via `@node-rs/argon2` (prebuilt Rust binary — no MSVC build chain on Windows), parameters m=19456/t=2/p=1 asserted against the stored hash prefix. Access JWT 15 min via `jose`; refresh is an **opaque 32-byte value, never a JWT**, persisted only as SHA-256, rotated on every use, carrying a `family` id. **Replaying a spent refresh token revokes the entire family** — proven end to end. Login verifies against a dummy hash on unknown emails and returns identical wording, so the endpoint does not reveal which addresses are registered. Cookies `httpOnly; SameSite=Strict`, refresh scoped to `/api/v1/auth`; **no token ever appears in a response body**.
- **RBAC**: `rbac(minimum)` deny-by-default over ranked roles + `requireInvestigationAccess` returning **404 not 403** so the API never confirms an id exists to someone without access. **22-case matrix test** (4 guard levels × 4 caller roles + anonymous).
- **validate**: Zod `.strict()` at the boundary; the parsed value replaces the raw input. Added `validatedQuery`/`param` accessors because Express 5 makes `req.query` read-only and types params as `string | string[]`.
- **Investigations**: create/list/get/summary/patch/delete/members/audit. Geodesic AOI cap that names the actual area *and how much to shrink by*; 30-day window cap; winding normalised on write; PATCH that changes AOI/window returns an explicit `SCOPE_CHANGED` warning with affected counts; soft delete preserves the audit trail.
- **Queues** (`queue/`): BullMQ over the live Redis, 6 queues with per-queue retry/backoff from `@varuna/shared` (single source of truth), deterministic `jobKey` as the BullMQ job id for idempotency, `jobs` collection mirror for post-eviction history, cancel (cooperative for active jobs) + retry. `assertNoEviction()` warns at boot if Redis is not `noeviction`.
- **Realtime** (`realtime/`): Socket.IO namespaces `/jobs`, `/investigations`, `/ais`; handshake verifies the JWT from the cookie; investigation room joins re-check membership; `/ais` requires analyst+. QueueEvents→Socket bridge mirrors worker progress into Mongo and fans it to rooms, passing the **verbatim** failure reason through.
- **OpenAPI 3.1** generated from the Zod schemas (`@asteasolutions/zod-to-openapi`), served at `/api/v1/openapi.json` — 12 paths registered, so the spec cannot drift.
- **Frontend**: `apiFetch` (credentials, X-Request-Id, problem+json parsing, `assertProvenance` before data reaches a component), TanStack Query hooks, `SocketProvider` mapping job completion → `invalidateQueries` and surfacing a **STALE** badge on disconnect, login/register/investigation-list/create pages, `lib/format.ts` (hemisphere letters, explicit `Z`, units always rendered) and `lib/geo.ts` (GeoJSON paste + validation with actionable messages).
- **Three real bugs found and fixed by the tests / smoke run**, not worked around:
  1. `provenanceGuard` deep-copied with `Object.entries`, which **destroys Mongoose documents** (fields live behind getters over `_doc`) — every document response would have serialised empty. Now normalises through `toJSON()` first, and leaves `Date`/`Buffer` alone.
  2. `mongoose.set('sanitizeFilter', true)` rewrote the server's own `$in`/`$gte`/`$geoWithin` operators as `$eq`. Removed — injection is prevented where the spec puts it (input sanitiser + Zod + no user string in a query object), not by crippling our own queries.
  3. `geographiclib-geodesic` is CommonJS: the named ESM import threw at runtime (`does not provide an export named 'Geodesic'`) even though types and Vitest's interop accepted it. Only the live smoke test caught it.
- **Role-gate reading corrected**: 06 §6.4.2's "lead" is a per-**investigation** role, so scoped routes use `rbac('analyst')` (may you use the app) + `requireInvestigationAccess('lead')` (are you this investigation's lead). Otherwise the creator — an analyst — could not edit their own investigation.
- **Live smoke test** against real Mongo + Redis: health, OpenAPI, register → 201, `/me`, create investigation → 201 with geodesic `aoiAreaKm2: 1918.76`, oversized AOI → 422 *"covers 305254.1 km², which exceeds the 50,000 km² limit. Reduce it by at least 255254.1 km²."* Test data cleaned up afterwards.
- **Gates green:** typecheck 4/4 · unit **114** (shared 24, api 69, web 21) · integration **35** · Python **11** · lint · prettier · real-data policy 6/6 · token sync.

### 2026-08-28 — Phase 1 COMPLETE: infra up, database verified
- **Docker Desktop 4.88.1** installed (winget), engine 29.7.2 + Compose v5.4.0 running. `docker compose up -d redis minio createbuckets`: Redis healthy with `maxmemory-policy noeviction` (11 A10), MinIO healthy with the `varuna` bucket created. Compose `mongo` intentionally not started — the user's native mongod owns 27017 (D-013). **B-002 resolved.**
- **MongoDB verified.** User's mongod **8.3.7, standalone**, db `VARUNA`. Added `apps/api/src/db/cli.ts` (`pnpm --filter @varuna/api db:bootstrap`) — connects, reports version/topology/transaction availability, runs the idempotent bootstrap, verifies the result. Added `dotenv` so `env.ts` reads the git-ignored repo-root `.env` in development (a real env var always wins).
- **`ais_positions` confirmed a true time-series collection** — `timeField:t`, `metaField:meta`, `granularity:seconds`, plus `meta.mmsi_1_t_1`, `position_2dsphere`, `t_1`, and a `system.buckets.ais_positions` backing collection.
- **Collection names corrected (D-012).** Mongoose's pluraliser had produced `satellitescenes`/`auditlogs`/…; models now pin the snake_case names from 02_TRD §2.5.1. Stale collections dropped locally.
- ⚠️ **Winding claim falsified (D-011).** The integration test written from 06_BACKEND §6.3.2 / 12 F-10 — "a clockwise polygon matches the whole globe" — **failed against real MongoDB**. Direct probe (4 query variants × 2 storage variants) on 8.3.7: with the **default CRS** MongoDB ignores ring orientation and takes the smaller region (CW ≡ CCW), and accepts either winding on insert. The complement behaviour appears **only** under the opt-in `urn:x-mongodb:crs:strictwinding:EPSG:4326` CRS. Kept the validator (RFC 7946 for exports; Turf predicates; strictwinding needed for hemisphere-scale AOIs) but rewrote the rationale in code comments and pinned **both** behaviours in tests. **Docs 06 §6.3.2 and 12 F-10 still contain the wrong claim — see Q-008.**
- **16 integration tests** added (`*.integration.test.ts`, separate vitest config so `pnpm test` still needs no services): bootstrap/time-series/indexes/collection-names/idempotency (4), winding semantics (6), provenance persistence + immutability + save-time rejection (6). Wired into CI as a job with a `mongo:8` service container.
- **All gates green:** typecheck 4/4 · unit **59** (shared 24, api 29, web 6) · integration **16** · Python **11** · lint · prettier · real-data policy 6/6 · token sync.

### 2026-08-28 — Repo live on GitHub
- Installed Git 2.55 (winget). `git init` at `e:\SIH`, identity set local, `.gitattributes` added (LF normalisation).
- Single initial commit `ad7758a` (144 files: docs 00–15, Phase 0 scaffold, Phase 1 spine). Pushed to `origin` = https://github.com/Ganu0310/Varuna-AI, `main`. Credential Manager auth OK.
- Going forward: one commit + push per completed phase (D-010, §15.13).

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
| Q-006 | Install Git + Docker Desktop on this machine, or develop on a different machine / WSL2? | DevOps | immediately | **Git: done** (2.55 via winget). **Docker: still needed** — install Docker Desktop (`winget install Docker.DockerDesktop`, needs reboot) to run Mongo/Redis/MinIO for Phase 1 DB-verification + Phase 2. |
| Q-007 | Demo incident: US-waters (NOAA Marine Cadastre, best free AIS) vs Danish (DMA) vs Ennore/Chennai (GFW only)? Marine Cadastre `/accessais/` is usable and is the highest-quality free source (§15.5). | Data | end of Week 1 | Leaning: build/validate on a **US-waters** incident (Marine Cadastre 1-min AIS), then also demo Ennore/Chennai for national relevance. Needs a specific documented US incident + `search-scenes.mjs` coverage check. |
| Q-008 | **Correct the winding claim in `06_BACKEND_Specification.md` §6.3.2 and `12_FEATURE_RATIONALE_PPT_QnA.md` F-10?** Both assert a wrongly-wound polygon silently matches the whole planet; measurement on MongoDB 8.3.7 shows that only happens under the opt-in strictwinding CRS (D-011). 12 is presentation material — F-10 is offered as "what nearly went wrong?" material and an informed judge could falsify it. | BE / presenter | before submission | **Recommend rewriting both** to the accurate version: "MongoDB will not enforce RFC 7946 winding — either orientation is accepted on insert and the default query CRS silently picks the smaller region — so we enforce it ourselves, because our GeoJSON exports are consumed by tools that do care, and because under the strictwinding CRS required for hemisphere-scale AOIs a clockwise ring genuinely becomes the globe complement." Awaiting go-ahead. |
| Q-009 | Local mongod is **standalone**, so multi-document transactions are unavailable (D-013). Convert to a single-node replica set, or run the compose mongo on an alternate port, or avoid transactions? | BE | when a phase first needs a transaction | — |

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
| R7 | MongoDB lacks polygon-distance functions | 🟢 mitigated | Compensation layer built: `apps/api/src/geo/{geodesy,envelope,trackGeometry}.ts` (GeographicLib + Turf) + `services/ml/varuna_ml/geo/`. Point-to-polygon-edge distance implemented; centroid shortcut avoided. |
| R8 | Data volume (1 GB scenes, 10⁷ AIS rows/mo) | 🟡 open | `ais_positions` time-series bootstrap built (Phase 1); COG + partitions Phase 4/8 |
| R9 | Timezone/CRS errors corrupting correlation | 🟢 mitigated | Known-answer geodesy suite is a CI gate; Node ↔ Python agree < 0.1%. UTC-with-`Z` enforced by `utcIso` brand + Zod. Winding validator rejects the "matches the globe" bug. |
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

---

## 15.13 Version control workflow

**Repo:** https://github.com/Ganu0310/Varuna-AI · branch `main` · commit straight to `main` (no PR flow).

**On this Windows dev box:** git was installed after the shell started, so each terminal
session needs `$env:Path = "C:\Program Files\Git\cmd;$env:Path"` before `git` resolves.

**Per phase** (D-010):

1. Finish the phase; all gates green (`pnpm typecheck && pnpm test && pnpm lint && pnpm exec prettier --check . && node scripts/check-real-data-policy.mjs && node scripts/tokens-sync-check.mjs`, plus Python `pytest` where touched).
2. Update this file: §15.3 status board, §15.9 changelog entry, §15.11 risks, any decisions/blockers.
3. `git add -A`
4. `git commit -m "feat: Phase N — <phase title>"` (body: what landed + test counts + what's still pending).
5. `git push`

Fix-ups between phases: `fix:` / `chore:` / `docs:` commits, pushed as made.
Initial import = one commit (`ad7758a`); phase-by-phase history starts at Phase 2.
