# VARUNA — Project Status Report

**For:** the team
**Date:** 2026-08-29
**Problem statement:** SIH26143 — Satellite Imagery + AIS Based Oil Spill Vessel Attribution System
**Repo:** https://github.com/Ganu0310/Varuna-AI · branch `main` · latest `cca9ef9`

---

## Contents

1. [The problem statement, restated plainly](#1-the-problem-statement-restated-plainly)
2. [Where we are, in one paragraph](#2-where-we-are-in-one-paragraph)
3. [The proof: one real incident, end to end](#3-the-proof-one-real-incident-end-to-end)
4. [What is built — phase by phase](#4-what-is-built--phase-by-phase)
5. [The twelve MVP items](#5-the-twelve-mvp-items)
6. [By the numbers](#6-by-the-numbers)
7. [What is NOT done — the honest gaps](#7-what-is-not-done--the-honest-gaps)
8. [The gap register, and what has closed since](#8-the-gap-register-and-what-has-closed-since)
9. [The three things that would move the needle most](#9-the-three-things-that-would-move-the-needle-most)
10. [How to run it yourself](#10-how-to-run-it-yourself)
11. [Housekeeping the team should pick up](#11-housekeeping-the-team-should-pick-up)

---

## 1. The problem statement, restated plainly

SIH26143 asks for a system that attributes an oil spill to the vessel that caused it, using
satellite imagery and AIS. The single most important thing to understand about it:

> **This is not a detection problem. It is a correlation problem.**

When a slick appears on the sea surface, three facts are usually knowable and one is not:

| Knowable | From | Not knowable without correlation |
|---|---|---|
| *Where* the slick is now | SAR satellite imagery | *Who* discharged it |
| *When* it was observed | Acquisition timestamp | *When* it was discharged |
| *Which vessels were in the area* | AIS broadcast records | *Which of them is plausibly responsible* |

Both datasets already exist and are largely free and public. They are almost never joined in
space **and** time by a system that shows its working. That join is the deliverable.

### Why the join is hard — five reasons that shaped every design decision

1. **Different physical domains.** Imagery is raster plus projected coordinates. AIS is a
   sparse, irregular, per-vessel time series. Joining them needs geodesy, resampling and
   interpolation — not a database join.
2. **The slick moves.** Where a slick is *observed* is not where it was *released*. Between
   release and overpass, wind and current translate and stretch it. **Correlating vessels
   against the observed footprint is a documented source of false attribution** — which is
   exactly why we back-track before we correlate, and why the system refuses to correlate
   without a back-track.
3. **Time is an interval, not an instant.** A SAR scene gives one timestamp. The release
   happened at some unknown time before it. Any honest system reasons over a *window*.
4. **AIS is adversarial.** Gaps, spoofed MMSIs, disabled transponders and duplicated
   identities are common precisely in the situations that matter. Most academic pipelines
   assume clean AIS. We do not.
5. **The systems that do this well are closed.** EMSA CleanSeaNet and KSAT are operational and
   unavailable to most of the world.

### What "done" looks like

> A single investigator, with a free satellite scene and free AIS records, should get from
> *"there is a slick here"* to *"here are the vessels that could have produced it, ranked,
> with the evidence and the uncertainty for each"* in under fifteen minutes — and be able to
> defend every number in that dossier to a regulator, a court, or a hostile
> cross-examination.

### The one rule everything else follows from

**The output is a ranked investigative lead, not a verdict.** Every design decision in the
codebase serves that: scores are labelled uncalibrated, unmeasured evidence is shown hatched
rather than hidden, a degraded origin estimate caps every candidate, "no AIS" returns an
explicit reason rather than an empty list, and the report cannot be generated without its
Uncertainty and Provenance sections.

Paired with the **real-data policy**: zero mock, fake, synthetic or placeholder data anywhere
— product, demo, screenshots, metrics, or model training. Every object carries a provenance
record; anything without one is stripped rather than displayed. This is enforced by CI, not
by discipline.

---

## 2. Where we are, in one paragraph

**The full chain runs live, end to end, on a real incident.** Real Sentinel-1C scene from a
real provider → COG in object storage → real map tiles → dark-slick detection → analyst review
→ backward drift back-tracking → 9,711 real NOAA AIS positions → reconstructed vessel tracks →
twelve-feature scoring with bootstrap confidence intervals → ranked candidates → a
print-ready PDF dossier with mandatory uncertainty and provenance, plus GeoJSON / CSV /
manifest exports. Built between **28 and 29 August 2026** across 52 commits. Every phase of the
implementation plan is complete, including the 3D surfaces that were once marked skipped.

---

## 3. The proof: one real incident, end to end

**Guam — Apra Harbour, 2025-09-21.** Reference `VARUNA-DEMO-01`.

| | |
|---|---|
| **Scene** | `S1C_IW_GRDH_1SDV_20250921T200737_20250921T200800_004227_008638_rtc` |
| **Source** | Microsoft Planetary Computer, `sentinel-1-rtc` (radiometrically terrain-corrected) |
| **Acquired** | 2025-09-21 20:07:48 UTC |
| **AOI** | 144.55, 13.3 → 144.95, 13.6 |
| **Detections** | **13** dark-slick candidates, 2 analyst-confirmed |
| **Origin estimate** | `DEGRADED` / `FOOTPRINT_PROXIMITY` — no keyless current model covers 2025-09-21 |
| **AIS** | **9,711 real positions** from the NOAA Marine Cadastre archive |
| **Candidates** | **27 ranked**, 1 of them below the six-feature evidence floor and correctly withheld |
| **Outputs** | PDF dossier (10 pages, 310 kB, printed by the worker), GeoJSON, CSV, run manifest |
| **Staging** | `pnpm run stage:demo` — real inputs cached in 5.5 s; results still run live |

Two things about that table are worth saying out loud to a judge, because they are the
strongest evidence that the system is honest:

- **The origin estimate is DEGRADED and we display it as DEGRADED**, with the full reason, on
  the public landing page. Every candidate is consequently capped at `MODERATE`. A flattering
  demo would have hidden this.
- **One candidate is withheld** because only five of twelve features could be measured. The
  system refuses to rank it rather than showing a number it cannot support.

`pnpm run stage:demo` caches the real *inputs* only — the scene window and the AIS slice, with
their original checksums. **Detections, origin estimates and rankings are not pre-computed**;
they run live during the demo. So a provider outage cannot derail us, and equally we cannot
show a result prepared in advance. If the pipeline would fail on the day, it fails in front of
the audience.

---

## 4. What is built — phase by phase

All fourteen phases of `IMPLEMENTATION_PLAN.md` are complete. Chronological, with the commit
that landed each.

| Phase | What landed | Commit | Date |
|---|---|---|---|
| **0** | Monorepo scaffold, CI, docker-compose, real-data policy check, design tokens | `ad7758a` | 28 Aug |
| **1** | Data-plane spine — 8 Zod contracts, 11 Mongoose models, the provenance plugin + guard, GeoJSON winding validator, cross-stack geodesy as a CI gate. DB-verified against real MongoDB 8.3.7. | `aa05c14` | 28 Aug |
| **2** | Platform — argon2id auth, JWT + rotating refresh tokens with family revocation, RBAC (22-case matrix test), investigations CRUD, BullMQ queues with deterministic idempotency keys, Socket.IO realtime, OpenAPI from Zod | `441dcaf` | 28 Aug |
| **3** | Providers + live catalogue — Planetary Computer / CDSE / ASF queried in parallel, circuit breaker, Redis quota tracker, p95 sampling. The rule that a *failure* advances the chain but *zero results* does not. | `818d5eb` | 28 Aug |
| **4** | Scene ingest — windowed AOI read → COG in MinIO → TiTiler tiles → ML detect API → API → queue → worker → MongoDB | `0ef9962`, `c7e7892` | 28 Aug |
| **5** | Model infrastructure — manifest gate, equal-area morphology, four-term confidence, content-addressed model registry | `7141ea2` | 28 Aug |
| **6** | Detection review — confirm / reject / edit / reopen with **immutable model output**; version 0 is always the detector's own | `e8a7c30` | 28 Aug |
| **7** | Backward Lagrangian drift — sampled wind-drift and Ekman parameters, KDE origin field, release window with the prior-clear-scene bound | `4188fa6` | 28 Aug |
| **8** | AIS module — the coverage honesty endpoint, track reconstruction, dark-period detection, MID-derived vessel identity | `c6e58c6` | 28 Aug |
| **9** | Attribution rigour — the twelve features, applicability states, bootstrap CIs, calibration state, candidates API | `071187e` | 28 Aug |
| **10** | Workspace UI — persistent map, layer provenance gate, evidence waterfall | `b46de71` | 28 Aug |
| **12** | Reporting — dossier with structurally mandatory Uncertainty + Provenance, GeoJSON / CSV / manifest exports | `47b2dc1` | 29 Aug |
| **13** | Demo staging, verification gates, security review, real-scale load measurement | `1f738b8`, `8cd0720` | 29 Aug |
| **11** | 3D surfaces — space–time prism, slick relief, orbital globe. **Un-skipped and delivered.** | `b255d00`, `9a67fec`, `887be91` | 29 Aug |

### Everything that landed after the plan was finished

Roughly half the work is post-plan hardening — the things found by actually using the system:

| What | Why it mattered | Commit |
|---|---|---|
| **M1–M9 made visible** | The SAR raster, origin zone, release window and moving vessels were computed and stored but never *drawn*. | `e8833c2`, `2991305`, `540d2e2` |
| **Real detector metrics** | The detector had no measured performance. Now evaluated on a real held-out split — including a result that reflects badly on it (see §7). | `4e735b4`, `421b7e9` |
| **U-Net trained and rejected** | A learned segmenter was trained on a geographic split, measured, and **not adopted** — it did not beat the classical detector. | `368a8e0`, `e712c24` |
| **Pipeline gap closed** | Origin and correlate existed as API routes with no UI — reachable only with curl. | `3e047f2`, `368a8e0` |
| **Usability** | AOI picker with AIS-coverage markers, bounding-box input, reachable exports, printable dossier | `7bca277`, `2d35d1b`, `20a4540` |
| **Admin + team screens** | Users, roles, provider health, quotas, audit log, per-investigation membership and trail | `350cbc3`, `45b1c87` |
| **Evidence drill-down** | Click a feature → the actual AIS fixes behind it. Weight-sensitivity sliders. | `93cf053`, `6be5bd7` |
| **Playwright + k6 run for real** | Both journeys executed against a live stack for the first time; fixed what they found. | `41e213a` |
| **Real basemap** | Land and coastlines from Natural Earth, served locally | `caad393`, `07ce01c` |
| **Geometric coastline mask** | Land was removed by *brightness* — which fails on dark land (wet asphalt, runways, tidal flats). That is the mechanism by which a car park becomes a slick. Now unioned with a rasterised Natural Earth coastline. | `db24345` |
| **Real PDF generation** | `/report/generate` used to return a note telling the analyst to print it themselves. The worker now prints the real thing. | `db24345` |
| **Four CI gates** | Pre-commit secret hook, OpenAPI drift + coverage, bundle budgets measured against real output | `4f4a4f4` |
| **Analyst notes** | Immutable, retractable, author-only — the audit log records what the *system* did; nothing recorded what a *person thought*. | `f2b78b0` |
| **Public landing page** | One unauthenticated route showing one real incident, with **vessel identity withheld** | `4100e35` |
| **GeoTIFF upload** | An analyst holding imagery from a national agency had no way in. Validated by reading the TIFF directory, not by trusting the extension. | `f1cbc7c` |
| **Full-chain integration test** | Seven stages had each been verified in isolation and never together. | `cca9ef9` |

---

## 5. The twelve MVP items

| # | Requirement | Status | Evidence |
|---|---|---|---|
| **M1** | Real S-1 scene ingested, preprocessed, shown as real raster tiles | ✅ | Guam scene → COG in MinIO → TiTiler tiles rendering in the workspace |
| **M2** | Segmentation model produces a slick mask on that real scene | ✅ | `darkspot-v1` classical detector; a U-Net was also trained, measured and rejected on merit |
| **M3** | Mask vectorised to a georeferenced polygon with real km² | ✅ | 13 polygons, areas recomputed geodesically on the Node side |
| **M4** | Real wind + current fields fetched for that date/region | ⚠️ | Provider chain built and probing correctly. **HYCOM has no coverage for 2025-09-21** — reported honestly, not faked. Needs CMEMS credentials. |
| **M5** | Backward drift → origin probability surface + release-time window | ✅ | Runs; `DEGRADED` for this date because of M4. Full physics implemented and unit-tested against analytic solutions. |
| **M6** | Real AIS from a public historical archive | ✅ | 9,711 real NOAA Marine Cadastre positions |
| **M7** | ≥ 5 candidate vessel trajectories reconstructed and rendered | ✅ | 27 candidates; tracks drawn and animated on the timeline |
| **M8** | Candidates ranked with full per-factor evidence breakdown | ✅ | Twelve features, evidence waterfall, per-feature drill-down to source AIS fixes |
| **M9** | Timeline replay works, synchronised across layers | ✅ | Vessels move with the cursor; positions it cannot place honestly are omitted |
| **M10** | PDF dossier exports with methodology + uncertainty + provenance | ✅ | 10 pages, 310 kB, printed by the worker from the same route the analyst reads |
| **M11** | Model eval metrics on a held-out real test split | ✅ | 66 real Sentinel-1 scenes, never fitted to. Numbers in §7. |
| **M12** | Every screen passes the provenance check | ✅ | Four enforcement layers; a layer without provenance is refused registration |

**11 of 12 complete. M4 is credential-blocked, not code-blocked** — and its absence degrades
gracefully and visibly rather than silently.

---

## 6. By the numbers

| | |
|---|---|
| **Commits** | 52, over 2 days (28–29 Aug 2026) |
| **Source** | ~32,900 lines across 264 files |
| — API (Node/Express 5, TS) | 15,262 lines · 119 files |
| — Web (React 18 / Vite / MapLibre / deck.gl) | 10,157 lines · 74 files |
| — ML service (Python 3.11 / FastAPI) | 3,866 lines · 33 files |
| — Shared contracts (Zod) | 1,116 lines · 18 files |
| — Scripts and checks | 1,982 lines · 13 files |
| — Worker (BullMQ) | 483 lines · 7 files |
| **Specification + working docs** | ~10,900 lines across 20 documents |
| **Tests** | 179 API unit · 64 API integration (real MongoDB) · 114 web · shared + Python suites · 3 Playwright E2E |
| **CI jobs** | 6 — Node lint/typecheck/test, integration against real Mongo, real-data policy (required), gitleaks secret scan, Python ruff/black/pytest, plus token / OpenAPI / bundle gates |

### Measured performance

| Gate | Result |
|---|---|
| AIS envelope query (NFR-6) | **p95 84 ms at 9,408,344 real positions** — target was &lt;400 ms at 10⁷ |
| Cold start | **PASS** — API boots from `.env.example` alone in a clean environment |
| Accessibility (axe-core) | **PASS** — 0 critical/serious on 5 routes plus the provenance panel and evidence waterfall |
| Dependency audit | **PASS** — 0 high/critical in either ecosystem |
| Security review | 4 findings, **all fixed** (`doc/docs/SECURITY_REVIEW.md`) |
| Bundle — initial load | 104.8 kB gzip / 280 budget (37%) |
| Bundle — workspace route | 608 kB / 650 budget (94%) — see §7 |
| Demo staging | Real scene + 9,711 AIS positions in **5.5 s** |

---

## 7. What is NOT done — the honest gaps

Stated plainly, because these are what a judge will probe and we are better off naming them
first.

### 7.1 The origin estimate is DEGRADED — the single biggest limitation

No keyless ocean-current model covers 2025-09-21. HYCOM's reanalysis archive **ends
2024-09-05**; its operational feed only covers the last ~2 weeks. Our incident falls in the
gap. So back-tracking falls back to `FOOTPRINT_PROXIMITY` — a buffer around the slick, which
cannot tell upstream from downstream.

**Consequence:** every candidate is capped at `MODERATE`, and the attribution is weaker than
the system is capable of. **Fix:** CMEMS credentials. This is a registration, not a code
change.

### 7.2 The detector's measured performance includes a bad result

On 66 held-out real Sentinel-1 scenes it has never been fitted to (Trujillo-Acatitla et al.
2024, Part III, CC-BY-4.0):

| Metric | Value |
|---|---|
| Mean oil-region IoU | 0.56 (median 0.63) |
| Overlapped the true slick | 100% of 22 oil scenes, 0 missed |
| **Fired on look-alike scenes** | **68% of 22** |
| Fired on clean-sea scenes | 18% of 22 |
| **Mean look-alike risk on those false positives** | **0.26** |

That last row is the problem and we say so in the dossier: on scenes where the detector is
provably wrong, **its own warning channel stayed low**. It was not merely wrong but
*unwarned*. A low look-alike risk must not be read as evidence that a detection is oil.

This is stated in the product, in the report, and in the guide — it is not hidden. The
coastline mask (`db24345`) removes one whole class of false positive; the rest needs a trained
classifier with more labelled data.

**The labelled data now accumulates on its own.** A `REJECT` review requires a *category*
alongside its note — which look-alike class it actually was — and `GET /admin/training-labels`
assembles those into a labelled set: a confirmed detection is a positive, a categorised
look-alike rejection is a negative of its class, and an operational rejection ("duplicate",
"out of scope") is neither and is excluded by construction. The expensive half of a training
set is the labelling, and it is now a by-product of ordinary review rather than a separate
project. The summary reports the per-class shortfall, so the decision to retrain is made
against a count rather than a feeling. Nothing trains automatically: a retrained model still
has to beat the shipped detector on the held-out split, exactly as the U-Net had to and did
not.

### 7.3 Scores are uncalibrated

There are too few validated incidents to fit a calibration, so a score of 70 does not mean a
70% likelihood. Scores are comparable between candidates in one report and **not** between
reports. Labelled as such everywhere.

### 7.4 AIS covers US waters only

The free bulk archive is NOAA Marine Cadastre. Elsewhere you get imagery and detections and
then no candidates — not because no vessel was there, but because we cannot see who was. The
AOI picker states this per region before you commit to an area. Global AIS needs a paid feed
or Global Fishing Watch approval (requested, approval can take days).

### 7.5 No wind data configured

The wind-suitability confidence term reads "wind unknown" and defaults to 0.5 — never 1.0,
because absence of a measurement is not evidence of good conditions. Needs ERA5 / CDS
credentials.

### 7.6 Provider credentials outstanding

| Account | Status | Unblocks |
|---|---|---|
| CDSE (Copernicus Data Space) | ⛔ not registered | Third provider in the catalogue chain; currently reports `NOT_CONFIGURED` |
| NASA Earthdata | ⛔ not registered | ASF *downloads* (search already works) |
| CMEMS (Copernicus Marine) | ⛔ not registered | **Lifts the origin estimate out of DEGRADED** |
| CDS (ERA5) | ⛔ not registered | Wind suitability term |
| Global Fishing Watch | ⛔ not requested | AIS outside US waters |

The system works today on Planetary Computer (anonymous) + ASF (open search) + NOAA AIS. These
credentials each add capability; none is required to run.

### 7.7 Smaller, known, and accepted

- **Workspace bundle is 608 kB gzip** against the spec's original 220 kB. That spec number was
  written before MapLibre (278 kB alone) and deck.gl were chosen — it was never achievable.
  The budget is now set from the measured size plus headroom, and says so, so it works as a
  ratchet against the next 100 kB nobody meant to add.
- **OpenAPI covers 17 of 71 mounted operations (24%).** The drift gate holds it steady; the
  coverage number is printed, not enforced, and fills in as documentation lands.
- **No accessibility sign-off on the assembled workspace.** MapLibre needs a WebGL context, so
  axe cannot audit it in jsdom. Individual panels pass; the screen an analyst actually works in
  has not been audited. Manual keyboard and screen-reader passes are not done.
- **NFR-7 (50 concurrent investigations) is unmeasured.** k6 is written but the profile has not
  been run; NFR-6 was measured directly at the datastore instead, which is the stronger
  measurement for that specific number.
- **MongoDB runs standalone locally, so no multi-document transactions.** Fine for everything
  built so far; recorded as an open question.
- **The 08 §8.9 demo script has not been rehearsed or timed.**

---

## 8. The gap register, and what has closed since

On 29 August every one of the 155 task lines in `IMPLEMENTATION_PLAN.md` was read against the
working tree, and ~90 specific capabilities were probed directly in source rather than
inferred from checkboxes. The result is [`doc/docs/GAP_REGISTER.md`](GAP_REGISTER.md) — **28
mismatches**, deliberately sorted into three kinds, because only the first is a hole:

| Kind | At audit | Meaning |
|---|---|---|
| **Absent** | 18 | Specified, not built, no substitute |
| **Deviates** | 7 | Built another way; the capability exists |
| **Deliberate** | 3 | Skipped on purpose, reason recorded in the code |

**The register named three gaps as changing what the system can *claim*. All three are now
closed**, along with seven more:

| Gap | Why it mattered | Closed by |
|---|---|---|
| **Coastline land mask** | Land was removed by *brightness*. Dark land — wet asphalt, runways, tidal flats, dry lake beds — passes a brightness test as sea and has exactly the shape a dark-spot detector hunts for. **That is the mechanism by which a car park becomes a slick**, and no threshold fixes it. Now unioned with a rasterised Natural Earth coastline. | `db24345` |
| **Server-side PDF** | Everything the dossier does exists to produce a document someone can file. It could not leave the browser as one. | `db24345` |
| **Full-chain integration test** | Seven stages verified individually and never together. Every integration break so far was found by a person clicking. | `cca9ef9` |
| Landing page + `GET /public/demo-incident` | An evaluator arriving at the system met a login form and no explanation of what they were logging into. | `4100e35` |
| Husky pre-commit hook | gitleaks in CI catches a leaked secret only once it is already in the history — at which point rotating the credential is the cheap part. | `4f4a4f4` |
| OpenAPI drift gate | A contract that can change silently is not a contract. | `4f4a4f4` |
| CI bundle budgets | Nothing measured the front-end size. Now a ratchet against the next 100 kB nobody meant to add. | `4f4a4f4` |
| `tokens-sync-check` in CI | deck.gl cannot read CSS variables, so the typed token mirror is what it uses — and nothing asserted the two agreed. | in `ci.yml` |
| Investigation comments | The audit log records what the *system* did. Nothing recorded what a *person thought*. | `f2b78b0` |
| `POST /scenes/upload` | An analyst holding a GeoTIFF from a national agency had no way in. | `f1cbc7c` |
| Static frame on `visibilitychange` | A backgrounded tab kept rendering. | `4f4a4f4` |

### What remains in the register

Mostly deviations and nice-to-haves, none of which block a demo:

- **Three segmentation architectures untried** (U-Net++, DeepLabV3+, SegFormer-B2). One was
  built and evaluated; the plan's instruction to *pick the shipped model by evaluation rather
  than assertion* was followed and the U-Net lost — better oil IoU (0.637 vs 0.564) but worse
  on look-alikes (81.8% vs 68.2% false positives), because look-alike scenes carry no positive
  pixels and so teach no rejection. **A focal-loss variant is the obvious next lead** and is
  named in the register.
- **Packed binary track format and its decoder worker.** Tracks go over the wire as JSON. A
  60 s read-path cache holds the endpoint inside budget, which is why it has not bitten.
- **Kystverket and Global Fishing Watch clients.** A token slot and quota entry exist; no
  client calls either. This is what limits AIS to US waters.
- **Pydantic-from-Zod generation with a drift check.** Both model sets exist but are
  hand-maintained, so a renamed field fails at runtime on the ML boundary rather than in CI.
- **Scoring lives in the API, not the ML service.** The behaviour matches the spec; the
  deployment boundary does not.
- **`design/primitives` and `motion.ts`.** Controls are styled per feature against the tokens,
  so they are consistent today by discipline rather than by construction.
- **Generated API client types.** Hand-written; nothing connects a server route change to the
  frontend types describing it.
- **Globe on MapLibre rather than react-three-fiber.** All three surfaces exist; the globe is
  less striking and has no atmosphere shell. Three.js is not a dependency at all — deliberately,
  since the workspace bundle is already over budget.
- **LCP / CLS / INP budgets.** Bundle size is now gated; the web vitals need a browser against
  a deployment.

---

## 9. The three things that would move the needle most

In order. Each is a small amount of work with a large effect on what we can claim.

1. **Register for CMEMS (and CDS for ERA5).**
   Lifts the origin estimate from `DEGRADED` to a real drift-derived probability surface,
   which removes the `MODERATE` cap on every candidate and turns the strongest limitation in
   the demo into a strength. **This is the single highest-value remaining change**, and it is
   a form, not a feature.

2. **Rehearse and time the demo script.**
   The pipeline runs; the *presentation* of it has never been walked through end to end
   against the clock. `doc/08_APP_FLOW.md §8.9` has the script.

3. **Bring `CONTEXT.md` in line with reality** (see §11 — it currently understates the project
   badly) and finish the OpenAPI documentation coverage.

Secondary, if there is time: register CDSE + Earthdata for full three-provider redundancy;
request the MKLab/CERTH dataset for detector training data; run the k6 profile for NFR-7.

---

## 10. How to run it yourself

Full instructions: **[`RUNNING.md`](RUNNING.md)** — a fresh clone reaches a working
system using only the values already in `.env.example`. No credentials needed to start.

```bash
pnpm install
cp .env.example .env
docker compose up -d mongo redis minio titiler mlflow

pnpm --filter @varuna/api dev        # → :4000
pnpm --filter @varuna/worker dev
pnpm --filter @varuna/web dev        # → :5173
cd services/ml && uv run uvicorn varuna_ml.main:app --reload --port 8000
```

**Two documents to read before touching anything:**

| Document | What it is |
|---|---|
| [`doc/docs/FEATURE_GUIDE.md`](FEATURE_GUIDE.md) | Every feature — how to drive it and how it works underneath. 18 sections, written from the code. |
| [`doc/docs/RUNNING.md`](RUNNING.md) | Clone to working system, including the Windows and MongoDB gotchas. |

In-product, `/guide` is the short version for analysts, and the **Progress** panel in every
workspace tells you which pipeline step is next.

---

## 11. Housekeeping the team should pick up

**`CONTEXT.md` §15.3 is badly stale and should not be shown to anyone.** Its status board
still marks Phases 4–10 as 🔴 *not started* and all twelve MVP items as 🔴, when every one of
them is built and running. Phase 11 is marked "SKIPPED" when all three 3D surfaces shipped. The
snapshot at the top of the file is closer to right but is dated 28 August and predates roughly
half the work.

If a judge or evaluator opens that table, it says we have built a third of what we have
actually built. Fixing it is worth an hour.

Also outstanding:

- Fill in `Days to submission` in the CONTEXT snapshot.
- Correct `doc/06_BACKEND §6.3.2` and `doc/12_FEATURE_RATIONALE` — decision **D-011** found
  that the polygon-winding claim in both is **false as written on MongoDB 8**. Doc 12 is
  presentation material and currently contains a claim a judge could falsify.
- Record the Real-Data Policy acknowledgement signatures (13 §13.11).
- Complete `data/manifests/dataset_manifest.yaml` — sha256 and retrieval dates still `PENDING`.

---

*Generated from the repository state at commit `cca9ef9`, 2026-08-29.*
