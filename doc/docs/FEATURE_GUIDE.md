# VARUNA — Feature Guide

**How every feature is used, and how each one actually works.**

This is the companion to [`RUNNING.md`](RUNNING.md). `RUNNING.md` gets the system up; this
document explains what to do with it once it is running, and what is happening underneath
each screen and endpoint.

It is written in pipeline order, because VARUNA's pipeline is strictly sequential and most
confusion comes from meeting a step out of order. An empty candidate list is almost never a
bug — it is a missing origin estimate two steps back, or an area with no AIS at all.

---

## Contents

1. [What VARUNA claims, and what it does not](#1-what-varuna-claims-and-what-it-does-not)
2. [Roles and access](#2-roles-and-access)
3. [The chain at a glance](#3-the-chain-at-a-glance)
4. [Investigations](#4-investigations)
5. [Catalogue — finding a scene](#5-catalogue--finding-a-scene)
6. [Scenes & ingest](#6-scenes--ingest)
7. [Detections](#7-detections)
8. [AIS](#8-ais)
9. [Origin — back-tracking to a release zone](#9-origin--back-tracking-to-a-release-zone)
10. [Candidates — the twelve-feature attribution model](#10-candidates--the-twelve-feature-attribution-model)
11. [The workspace map and timeline](#11-the-workspace-map-and-timeline)
12. [The three extra views: prism, relief, globe](#12-the-three-extra-views-prism-relief-globe)
13. [Report dossier and exports](#13-report-dossier-and-exports)
14. [Jobs and activity](#14-jobs-and-activity)
15. [Team, audit trail, and admin](#15-team-audit-trail-and-admin)
16. [Cross-cutting: provenance, the real-data rule, idempotency, realtime](#16-cross-cutting)
17. [Empty states and what they actually mean](#17-empty-states-and-what-they-actually-mean)
18. [API surface reference](#18-api-surface-reference)

---

## 1. What VARUNA claims, and what it does not

VARUNA links an oil slick seen from space to the vessels that were near it, and ranks them
as **investigative leads**. It does not determine responsibility, and the design pushes that
distinction into the product rather than leaving it in a disclaimer:

| Design decision | Why it exists |
|---|---|
| Scores are labelled **UNCALIBRATED** everywhere | A score of 70 is *not* a 70 % likelihood. There are too few validated incidents to fit a calibration, so the number is comparable **between candidates in one report** and not between reports. |
| A feature that could not be measured is `MISSING`, never `0` | Zero is a measurement ("no evidence in this dimension"). Missing means "we could not look". Scoring a gap as zero would silently penalise a vessel for *our* data gaps. |
| Below **6 of 12** measured features the score is withheld | A high number computed from three features is not a strong case. The tier becomes `INSUFFICIENT_EVIDENCE` regardless of value. |
| A `DEGRADED` origin caps every candidate at `MODERATE` | Without a drift field the origin zone is a proximity buffer; in a busy waterway that circle contains most passing traffic, so proximity cannot separate a discharger from a bystander. |
| "No AIS" returns `NO_AIS_COVERAGE`, not an empty list | An empty list reads as an exoneration. It is not — it means we could not see. |
| Model output is **immutable**; a correction creates a new version | "What did the algorithm actually say before a human adjusted it?" must stay answerable months later, including to someone challenging the finding. |
| Uncertainty and Provenance are **structurally mandatory** report sections | A dossier that names a vessel while omitting what the analysis could not establish is not shorter; it is misleading. |

**The non-negotiable data rule:** zero mock, fake, synthetic or placeholder data anywhere —
product, demo, screenshots, metrics, or model training. Every data object carries a
provenance record; anything without one is stripped rather than displayed. See
[`13_REAL_DATA_POLICY.md`](../13_REAL_DATA_POLICY.md).

---

## 2. Roles and access

Four roles, deny-by-default, ranked: `viewer` (0) → `analyst` (1) → `lead` (2) → `admin` (3).

| Role | Can |
|---|---|
| `viewer` | Read investigations they are a member of; read scenes, detections, AIS, origin, candidates, reports; download exports. |
| `analyst` | Everything above, plus queue ingest / back-tracking / correlation, review detections, reweight, exclude candidates. |
| `lead` | Everything above, plus manage investigation membership and delete investigations. |
| `admin` | Everything above, plus `/admin` — users, roles, provider health, quotas, global audit log. |

Two behaviours worth knowing:

- **Invisible resources return `404`, not `403`.** Asking about an investigation you cannot
  see must not confirm that it exists.
- **Sessions**: 15-minute JWT access token (httpOnly cookie) + 7-day opaque refresh token,
  rotated on every use. Refresh-token **reuse revokes the entire family** — if a stolen token
  is replayed, both the attacker and the legitimate session are logged out. On a `401` the
  web client sends you to `/login?from=…` and returns you to where you were.

---

## 3. The chain at a glance

Five steps, strictly in order. Each needs the one before it, and the server **refuses** a
step whose precondition is missing rather than producing a weaker answer.

```
  1  Find a scene        →  /catalogue          live provider search, nothing stored
  2  Ingest it           →  queue: ingest       AOI window → COG → detector runs automatically
  3  Review detections   →  Scenes & detections CONFIRM / REJECT / EDIT / REOPEN
  4  Back-track          →  queue: drift        particles run backwards → release zone + window
  5  Correlate AIS       →  queue: scoring      every transmitting vessel scored on 12 features
```

The **Progress** panel in every workspace computes this state live from what actually exists
(never from a stored `progress` field, which would drift the first time anything was deleted
or re-run) and tells you which step is next. Steps 2, 4 and 5 are asynchronous BullMQ jobs;
watch them in **Activity**.

Hard preconditions the API enforces:

- Correlation without an origin estimate → **`409`** with the reason: *"Correlation needs a
  release zone and window to search against."*
- Back-tracking without a detection → nothing to run; the UI disables the control and says so.
- Rejecting a detection without a note → **`422`**. An unexplained rejection is
  indistinguishable from hiding evidence.
- Excluding a candidate without a reason → **`422`**, same principle.
- A weight profile that does not sum to 1.000 → **`422`**; scores would stop being comparable.

---

## 4. Investigations

### 4.1 The list — `/investigations`

Every investigation you are a member of. This is the home route; `/` redirects here.

### 4.2 Creating one — `/investigations/new`

Three things are required: a **name**, an **area**, and a **UTC time window**.

**The area.** Easiest is the **Known areas** dropdown. Each entry is somewhere a slick has
actually been observed — the staged demo incident, plus the geographic clusters of the 150
confirmed-oil scenes in the evaluation dataset — and each states its AIS situation up front:

| Marker | Meaning |
|---|---|
| `STAGED` | AIS is already imported for this area/window (Guam — Apra Harbour). |
| `OBTAINABLE` | US waters — the free NOAA Marine Cadastre bulk archive covers it; you can import a slice. |
| `NONE` | No free AIS archive. You will get imagery and detections and then **no candidates** — not because no vessel was there, but because we cannot see who was. |

The presets currently shipped: Guam — Apra Harbour · Gulf of Mexico (Mississippi Delta) ·
Baniyas, Syria · İskenderun Bay · Red Sea (north Saudi coast) · Persian Gulf (Abu Dhabi) ·
Ligurian Sea (Corsica) · Makassar Strait.

Otherwise type a bounding box as `west,south,east,north` (e.g. `144.55,13.3,144.95,13.6`),
or paste a GeoJSON `Polygon`, `Feature` or `FeatureCollection`. Coordinates are
`[longitude, latitude]`. Drawing directly on the map is not implemented.

The readout shows the area live against the **50,000 km² cap** and names the exact overage if
you exceed it. Server-side the area is measured **geodesically** (GeographicLib), and the
polygon's winding is normalised to right-hand rule on write.

**The window.** Up to **30 days**, in UTC. Keep it tight around the suspected incident: a
wider window means more vessels to consider and weaker discrimination between them.

**The Review step** runs a **live** catalogue query against real providers before you commit,
so nobody creates an investigation for a window with no possible imagery. It is not
auto-run — it consumes real provider quota, so you ask for it explicitly.

### 4.3 Editing scope

`PATCH /investigations/:id` accepts a changed AOI or window. If the change alters scope it
returns a `SCOPE_CHANGED` warning, because scenes, detections and candidates already attached
were produced under the old scope.

---

## 5. Catalogue — finding a scene

**Where:** `/catalogue`, and the **Catalogue** tab inside a workspace (pre-filled with the
investigation's AOI and window).

### 5.1 What it does

`GET /api/v1/catalogue/search` is a **live** query. Nothing is persisted — the endpoint
reports what the providers say *right now*.

Three providers are queried **in parallel**:

| Provider | Auth | Notes |
|---|---|---|
| **Microsoft Planetary Computer** | anonymous | STAC. `sentinel-1-rtc` items are flagged `preprocessed` — radiometrically terrain-corrected, so ingest can skip calibration. |
| **Copernicus Data Space Ecosystem (CDSE)** | OAuth2 client-credentials | OData + WKT search. The token is cached in Redis with a 60 s safety margin. |
| **Alaska Satellite Facility (ASF)** | open search | Earthdata credentials are only needed to *download*, not to search. |

Results are deduplicated by normalised product ID (a trailing `.SAFE` is tolerated), an RTC
duplicate wins over chain order, and the list is sorted by acquisition time. Filters:
platforms, orbit direction, polarisation, limit.

### 5.2 The rule that matters

**A provider FAILURE advances the chain; ZERO RESULTS does not.** An empty answer is a real
statement about coverage, not a reason to try somewhere else. This is why the panel keeps
three outcomes visually distinct:

| Outcome | What you see |
|---|---|
| Scenes found | The results table. |
| Providers answered, none had coverage | *"No acquisitions in this window"* — an explicit, non-error state, with the usual next step (widen the window, or accept lower AOI overlap). |
| No provider could be reached | An error naming **which providers were attempted and what each did**, plus a `consequence` sentence saying what the failure means for you. |

### 5.3 Resilience machinery

Every provider call goes through a shared `ProviderClient` with:

- **Circuit breaker** — 5 consecutive failures opens it, 60 s reset, single half-open probe.
- **Retry with exponential backoff** (1 → 2 → 4 s) on transient statuses and network errors
  **only** — never on a 4xx that will fail identically.
- **Redis-backed quota tracker** — soft limits, warns at 80 %, and `QuotaExhausted` advances
  the chain rather than hard-failing.
- **p95 latency sampling** and logging that never carries a credential.

`GET /api/v1/catalogue/providers` exposes all of this — circuit state, quota consumed, p95
latency, last success, and `configured: false` where a credential is absent. It reports the
truth, including "not configured", rather than inventing green ticks. The
**ProviderStatusStrip** above the results and the **ProviderHealthTable** on `/admin` both
read it.

---

## 6. Scenes & ingest

**Where:** workspace → **Scenes & detections** tab.

### 6.1 Using it

Paste a **product ID** from the catalogue results into *"Ingest a scene by product ID"* and
press **Ingest and detect**. The response is a job ID; if the same product was already
ingested for this investigation you get `deduplicated: true` and no duplicate work.

The scene list shows acquisition time, platform, polarisations, CRS, provider, preprocessing
level, and the **full, unelided product ID** on its own line — that string is what an
evaluator uses to pull the same acquisition themselves, so it is never truncated.

### 6.2 How ingest works

`POST /investigations/:id/scenes/ingest` enqueues on the `ingest` queue with the deterministic
key `ingest:{investigationId}:{productId}`. The worker calls the Python ML service, then the
Node side writes the records:

1. **`CATALOGUE` (5 %)** — resolve the product.
2. **`DOWNLOAD` (15 %)** — the ML service performs a **windowed read**: only the investigation
   AOI is pulled from the provider's COG, not the whole swath. That is what keeps ingest to
   seconds rather than gigabytes. The window is written out as a Cloud-Optimised GeoTIFF into
   object storage (MinIO / R2) via `rasterio` + `rio-cogeo`.
3. **`PERSIST` (55 %)** — a `SatelliteScene` document is upserted with footprint (right-hand
   wound), CRS, pixel size, storage keys, the provider's own STAC item kept verbatim, a
   processing chain entry, and a provenance record pointing at the real provider product.
4. **`DETECTION` (65 %)** — the detector runs (see §7).
5. **`PERSIST` (85 %)** — each detection is written, **derived from** the scene's provenance
   record, so the lineage from a candidate vessel back to a provider product is unbroken.
6. **`COMPLETE` (100 %)**.

If the ML service cannot geocode a scene, or a detection has no geometry, **the record is not
written**. An absent scene is a truthful state; an ungeoreferenced one is not.

### 6.3 Tiles — what you see on the map is what was measured

`GET /investigations/:id/scenes/:sceneId/tiles` returns a **TiTiler** template pointing at
**the same COG the analysis read** (`storage.cogKey`), not a re-rendered copy — so the
displayed pixels cannot drift from the measured ones. Bounds come from the stored footprint,
so the raster is placed by the same geometry the rest of the analysis uses.

`rescale=0,0.3` is **display only**. Sigma0 is stored linear and spans a huge dynamic range,
so it must be stretched to be visible at all; the analysis used the untouched values. The
response says so in a `note` field.

The same endpoint also returns a second, **Terrain-RGB encoded** template — the same Sigma0
raster packed as elevation, which is what drives the Slick Relief view (§12.2).

---

## 7. Detections

### 7.1 The detector

`darkspot-v1` — a classical adaptive-threshold algorithm, the pre-deep-learning literature
standard. It needs no training data, which is why it ships first.

**The physics:** oil damps short capillary and gravity waves, so a slick returns much less
energy than the surrounding sea and appears dark on SAR. Low-wind zones, biogenic films, rain
cells and wind shadows do the same thing — those are *look-alikes*.

**Pipeline:** linear Sigma0 → dB (invalid/zero pixels become `NaN`, not `-inf`) → coarse land
and bright-target mask (deliberately conservative, so it can never erase a dark slick) →
adaptive local threshold (pixels darker than their neighbourhood by ≥ 3 dB) → morphological
cleanup → connected components → shape and context scoring. Features below **0.05 km²** are
dropped.

Areas are then **recomputed geodesically on the Node side** rather than trusting the
pixel-count figure, so the number that becomes evidence comes from the same routine as every
other measurement in the system.

**What it cannot do**, stated plainly because it changes how results must be read: it cannot
classify oil versus look-alike from *texture* the way a trained model can. It finds dark
features and scores how oil-like their shape and context are. Every detection therefore
carries an explicit `lookAlikeRisk`, and weak candidates are **returned rather than silently
dropped**, so an analyst sees what the algorithm saw.

**Measured performance** on a held-out real test split it has never been fitted to
(Trujillo-Acatitla et al. 2024, Part III, CC-BY-4.0 — 66 scenes: 22 oil, 22 look-alike,
22 no-oil):

| Metric | Value |
|---|---|
| Mean oil-region IoU | **0.56** (median 0.63) |
| Overlapped the true slick | **100 %** of 22 oil scenes; 0 missed entirely |
| Fired on look-alike scenes | **68 %** of 22 |
| Fired on clean-sea scenes | **18 %** of 22 |
| Mean look-alike risk it assigned *on those false positives* | **0.26** |

That last row is the important one and the dossier says so: on the scenes where the detector
is provably wrong, its own warning channel stayed **low**. It was not merely wrong but
*unwarned*. **Do not read a low look-alike risk as evidence that a detection is oil.**

> A U-Net was trained and evaluated on a geographic train/val/test split and **not adopted** —
> it did not beat the classical detector on the held-out split. The comparison is in
> `data/eval/detector-comparison.json`.

### 7.2 Confidence — four terms, never one number

```
overall = 0.40·model + 0.25·separation + 0.20·wind + 0.15·shape
```

A single "0.61" tells nobody whether a detection is weak because the model was unsure,
because the sea was glassy, or because the shape looks like a rain cell — and those three
cases demand different responses. So all four terms, **each with its raw input**, are carried
to the UI and the PDF:

| Term | From | Note |
|---|---|---|
| **Model** | calibrated per-pixel oil probability | The classical detector produces none, so it **defers to separation** and reports `meanOilProbability: null` — the UI shows *"no calibrated probability"* rather than a fabricated value. |
| **Separation** | `contrast_db / 10` | How much darker than the local sea background. ~10 dB is unambiguous. |
| **Wind suitability** | 10 m wind speed, piecewise trapezoid | `<2` or `>14` m/s → 0.05 (glassy sea, or slick re-roughened away); 2–3 and 12–14 → 0.30; 4–9 → 1.00; otherwise 0.70. **Unknown wind returns 0.5, not 1.0** — absence of a measurement is not evidence of good conditions. No wind provider is currently configured, so this term reads *"wind unknown"*. |
| **Shape** | look-alike risk | Elongation, convexity, contrast, context. |

### 7.3 Reviewing — `CONFIRM` / `REJECT` / `EDIT` / `REOPEN`

Open a detection's **Review** button. An `UNREVIEWED` detection is drawn **hatched**
everywhere it appears — map, panel, dossier — because a machine-produced candidate and a
human-confirmed one must never look the same in a screenshot that might end up in a report.

**The governing rule: the model's output is immutable.**

- `REJECT` **requires a note** (`422` without one).
- `EDIT` **requires a corrected polygon**, and recomputes `areaKm2` geodesically from what you
  actually drew — not the model's old figure.
- An edit does **not** overwrite anything. It appends a `reviewHistory` entry that captures
  the pre-edit geometry as `geometryBefore`, so the model's original output survives inside
  the record that changed it.

`GET /detections/:id/versions` reconstructs the full history: **version 0 is the detector's
own output**, then one version per review action, each with its actor, timestamp, note and
the geometry as it stood. The **Version history** panel renders it.

### 7.4 Geometry endpoint

`GET /detections/:id/geometry?simplify=z12` returns the outline simplified to roughly one
screen pixel at that zoom, with an `ETag` and `Cache-Control: private, max-age=60`.

**Simplification is display-only.** `areaKm2` on the response stays the geodesic figure
measured on the full-resolution outline, and the response restates that in an `areaNote` — a
number that becomes evidence must not change with the map's zoom level.

---

## 8. AIS

### 8.1 Getting AIS in

AIS is imported separately from a real bulk archive — **NOAA Marine Cadastre**, which covers
**US waters only**:

```bash
pnpm --filter @varuna/api ais:import -- \
  --file "DATASET DOW/AIS VESSEL DATA/guam_2025.csv" \
  --from 2025-09-21T08:00:00Z --to 2025-09-22T08:00:00Z \
  --bbox 144.4,13.2,145.1,13.8
```

Positions land in the `ais_positions` **time-series collection** with a provenance record and
a batch ID. The import's transforms are not cosmetic — each prevents a specific documented
way of corrupting an attribution:

| Transform | Why |
|---|---|
| **Sentinel values → `null`** | AIS encodes "unknown" in-band: SOG `102.3`, COG `360.0`, heading `511`. Stored as numbers they become a vessel doing 102 knots on a course of 360°, poisoning speed-consistency and heading-alignment scoring. |
| **Coordinate order asserted** | The CSV carries WKT `POINT (lon lat)`; GeoJSON is also `[lon, lat]`. A straight copy — but asserted, not assumed. |
| **MMSI validity flagged** | A 9-digit MMSI whose leading MID is not an assigned ITU country prefix is malformed or spoofed. Flagged, never silently trusted. |
| **Deduplication** | Exports overlap at file boundaries. A time-series collection cannot carry a unique index, so duplicates are filtered in-process on `(mmsi, second, rounded position)`. |

The run reports every count: read, imported, out-of-window, out-of-bbox, unparseable,
duplicates dropped, and each flag category.

### 8.2 The coverage endpoint — deliberately shown first

`GET /investigations/:id/ais/coverage` is the **honesty endpoint**, and the AIS tab renders it
**above** everything else. An attribution is only as good as the AIS coverage under it: with
sparse coverage a "top candidate" may simply be the only vessel that was transmitting.

Everything it returns is **measured**, never estimated: record count, distinct vessels, first
and last fix, actual bbox of the data, **median reporting interval computed per-vessel**
(the interval between fixes of *different* vessels says nothing about sampling rate),
temporal completeness, quality-flag counts, and a plain-language `assessment`.

With nothing there, it says so:

> *"No AIS positions are held for this area and window. Vessel attribution cannot be
> attempted: an empty evidence base is not the same as an absence of vessels."*

### 8.3 Track reconstruction

`GET /investigations/:id/ais/tracks` groups fixes per MMSI and returns a `LineString` plus a
parallel `times[]` array of epoch milliseconds.

**Why `times[]` exists:** AIS reporting is nothing like even — intervals swing from seconds
to hours. Without per-vertex times a client can only assume even spacing, and animating on
that assumption would place a vessel where it was never reported. That is fabricated
positional data whatever the intent. (They are numbers rather than ISO strings for a measured
reason: as ISO the response reached ~690 kB and pushed the envelope query p95 to 435 ms
against a 400 ms budget — the payload, not the database at 84 ms, was the cost.)

Two behaviours are load-bearing:

- **Gaps are evidence, not noise.** A vessel that stops transmitting over the origin zone is
  the classic deliberate-discharge signature. Gaps are detected, measured and kept — they
  feed feature F5 rather than being smoothed away. When an origin estimate exists, each gap
  is reported with whether it **overlaps the plausible release area and window**.
- **Outliers are counted, never silently dropped.** A fix implying an impossible speed is
  excluded from the geometry but recorded per vessel in `removedOutlierCount`, so an analyst
  can see the track was edited and by how much. The Tracks table shows that column.

### 8.4 Vessel identity

`GET /ais/vessel/:mmsi` returns what the archive genuinely supports — usually a number, a
flag, a last position and a fix count.

`flag` is derived from the MMSI's MID prefix using the **vendored ITU table**
(`data/reference/mid-table.json`). An MMSI whose prefix is not an assigned country is reported
as **invalid** rather than given a plausible-looking flag.

Name, IMO, callsign and ship type come from AIS *static* messages, which are **not present in
this archive export**. The endpoint says so explicitly rather than returning empty fields that
read as "unknown vessel" — and the attribution features that need them report `MISSING`.

---

## 9. Origin — back-tracking to a release zone

**Where:** workspace → **Origin** tab.

### 9.1 Using it

Pick a detection (rejected ones are not offered — correlating against something already ruled
out would be pointless) and press **Run back-tracking**. Optional bounded parameters:
`horizonHours` 1–72 (default 24) and `particleCount` 100–20,000 (default 5,000). They are
bounded because ensemble cost is linear in both, and an analyst should not be able to queue an
hour of compute by mistyping a number.

Deterministic job key `drift:{investigationId}:{detectionId}` — re-requesting the same
back-track is a no-op.

### 9.2 The physics

Particles are run **backwards** in time from the observed slick to the water they came from,
producing a **probability surface** over where the release happened rather than a single point.

Per particle:

```
dx/dt = u_current + α·R(θ)·u_wind + random_walk(K_h)
```

| Term | Value |
|---|---|
| `u_current` | Surface current from a real ocean model. |
| `α` | Wind-drift coefficient, **sampled per particle** from `U(0.02, 0.04)`. |
| `θ` | Ekman deflection, **sampled** from `U(0°, 20°)`, sign by hemisphere (right in the north, left in the south). |
| `K_h` | Horizontal eddy diffusivity, 10 m²/s, as an isotropic random walk. |
| `dt` | 15-minute steps, negated for backward integration. |

**Why α and θ are sampled rather than fixed:** their true values depend on slick thickness,
sea state and oil properties we do not know. Fixing them would produce a tight,
confident-looking origin blob whose apparent precision is fictional. Sampling across the
plausible range makes the resulting spread an honest expression of that ignorance — the
uncertainty in the answer comes from uncertainty in the physics, not from tuning.

Backward integration is `-dt` on the same equations: exact for advection, and
correct-in-distribution for the diffusive term, since a symmetric random walk run backwards
has the same statistics.

Particles are **rejection-sampled uniformly inside the slick polygon**, not seeded on the
centroid: the release could have produced any part of the observed slick, and seeding only
the centre would understate the origin zone's extent.

The particle cloud is then kernel-density-estimated into `support50` and `support90` polygons
plus a centroid, with per-frame grids retained.

> **Note on OpenDrift.** The spec designates OpenDrift as the integrator with this stepper as
> a cross-check. OpenDrift requires cartopy/GEOS, which would not install in this environment,
> so the roles are inverted: this stepper is primary and is tested directly against analytic
> solutions. The forcing interface deliberately keeps the shape OpenDrift expects, so swapping
> it in later touches one file.

### 9.3 Forcing — and the coverage gap

Real ocean and atmosphere models only. **There is no synthetic fallback.**

```
CURRENTS   CMEMS (credentials)  →  HYCOM (keyless OPeNDAP)
WIND       ERA5  (credentials)  →  NOAA GFS (keyless, ~10-day window)
```

A real, load-bearing gap discovered by probing rather than assumed: HYCOM's reanalysis archive
(`GLBy0.08/expt_93.0`) **ends 2024-09-05**, while its operational feed only covers roughly the
last two weeks. Dates in between have **no keyless current coverage**, so an incident there
requires CMEMS credentials. The forcing layer reports this honestly instead of silently
returning the nearest available field — which would attribute a spill using currents from a
different year.

### 9.4 `OK` versus `DEGRADED` — and why it follows you everywhere

| Status | Method | Meaning |
|---|---|---|
| `OK` | `LAGRANGIAN_BACKTRACK` | A real drift-derived probability surface. |
| `DEGRADED` | `FOOTPRINT_PROXIMITY` | No forcing covered this date. The zone is the slick footprint buffered by a fixed radius. **It cannot tell upstream from downstream.** |

The `degradationReason` is **stored, not just logged**, because a degraded origin must stay
visibly degraded wherever it is used. Its consequences:

- The map legend labels the layer *"Origin zone (proximity, degraded)"* — a proximity buffer
  and a drift field are different kinds of claim and the legend must not present them as one.
- The AIS search envelope widens from **15 km to 40 km**.
- Feature F8 (`origin_density_at_track`) becomes `MISSING` — a degraded zone carries no
  probability density to sample.
- **Every candidate is capped at `MODERATE`**, however high its score.
- The dossier's Uncertainty section states it as a `LIMITATION`.

### 9.5 The release window

Four timestamps: `earliest`, `latest`, `mostLikelyStart`, `mostLikelyEnd`, plus a status.

- `status: WIDE` means the window spans the whole back-tracking horizon — drift was too slow
  to date the slick. Feature F2 (`temporal_alignment`) then becomes **`NOT_APPLICABLE`**,
  because "was the vessel present during it?" is true of almost every vessel in the area and
  separates nothing; scoring it would hand every candidate the same 0.16 and dilute the
  features that *do* discriminate.
- **Prior-clear-scene bound.** Before running, the service looks for the most recent earlier
  acquisition over the same footprint that showed **no** detection. If one exists, the release
  cannot predate it. That is a real observational constraint and it **overrides** the kinematic
  estimate.

The window is drawn on the timeline as a **band, never a line** — a single tick would assert a
precision the drift model cannot support.

### 9.6 Re-running

A re-run **supersedes**: the previous origin estimate for that detection is deleted first, so
the UI can never show two contradictory release zones at once.

---

## 10. Candidates — the twelve-feature attribution model

**Where:** workspace → **Candidates** tab. Run it from the **Origin** tab
(*"Rank candidate vessels"*), or `POST /investigations/:id/candidates/correlate`.

### 10.1 What correlation does

1. **`ENVELOPE` (10 %)** — buffer the origin `support90` polygon: **15 km** normally,
   **40 km** if the origin is degraded.
2. **`AIS_QUERY` (30 %)** — query AIS inside that envelope, widened by **3 hours either side**
   of the release window (a vessel that discharged at the window's edge is still a candidate,
   and its approach track is what makes it one).
3. **If zero records → `NO_AIS_COVERAGE`.** Not an empty success. The response carries the
   sources queried and the sentence: *"This is an absence of observation, not an absence of
   vessels — an untracked or non-transmitting vessel would look identical."*
4. **`TRACKS` (50 %)** — reconstruct per-vessel tracks with gaps and outlier counts.
5. **`SCORING` (70 %)** — score every vessel across the twelve features.
6. **`PERSISTING` (85 %)** — delete any previous ranking for this detection (a re-run
   supersedes rather than accumulates) and write the new one.

### 10.2 The twelve features

Weights are **expert-elicited priors**, not measurements. They sum to exactly 1.00.

| # | Feature | Weight | Family | Raw unit | Normalisation | Becomes MISSING / N.A. when |
|---|---|---|---|---|---|---|
| F1 | **Spatial proximity** | 0.18 | spatial | km | `exp(−km/8)` — half-weight ≈ 5.5 km, near zero beyond ≈ 25 km | no reconstructed track |
| F2 | **Temporal alignment** | 0.16 | temporal | fraction | fraction of fixes inside the release window | no fixes; window unestablished; **N.A. if window is `WIDE`** |
| F3 | **Track intersection** | 0.13 | spatial | km | 1 if the track crosses the zone, else `1/(1+km/3)` | no track |
| F4 | **Heading alignment** | 0.10 | kinematic | degrees | `cos²(Δ)` of course vs slick long axis, compared **mod 180°** (a slick has orientation, not direction) | no measurable long axis; fewer than 2 fixes near the zone; **N.A. if elongation < 2.5:1** — a near-round blob's "long axis" is arbitrary |
| F5 | **AIS dark period** | 0.10 | behavioural | minutes | `min(1, longest_overlapping_gap / 120)` | never missing — gaps that exist but do not overlap the window score a **measured 0** |
| F6 | **Speed consistency** | 0.08 | kinematic | knots | 4–14 kn → `1 − abs(mean−9)/10`; below 4 kn → 0.3; else 0.2 | no SOG values near the zone |
| F7 | **Vessel type prior** | 0.07 | behavioural | 0–1 | tanker (80–89) 1.0 · cargo (70–79) 0.7 · fishing/tug (30–39) 0.35 · passenger (60–69) 0.3 · other 0.2 | AIS static data carries no ship type — **currently always MISSING** with the NOAA export |
| F8 | **Origin density at track** | 0.07 | spatial | normalised | `1/(1+km/2)` | **MISSING when the origin is DEGRADED** — no density surface to sample |
| F9 | **Draught change** | 0.05 | behavioural | metres | `min(1, drop/1.0)`; no drop → 0 | fewer than two draught reports |
| F10 | **Slick axis continuity** | 0.03 | kinematic | 0–1 | `1 − Δ/90` between track bearing near the zone and the slick axis | no long axis; fewer than 2 fixes near the zone |
| F11 | **Manoeuvre anomaly** | 0.02 | kinematic | 0–1 | `min(1, mean_course_change / 45°)` | fewer than 3 course reports near the zone |
| F12 | **Prior incident history** | 0.01 | behavioural | count | `min(1, n/3)` — **our own records only** | no incident-history source connected |

The vessel-type prior carries **0.07 and not more** deliberately: it must never be the reason a
vessel ranks first.

Every feature returns its **raw measurement alongside the normalised value**, plus a
plain-language explanation ("Closest approach to the origin zone: 3.20 km."), so the UI can
show *"3.2 km from the origin zone"* rather than only *"0.78"*.

### 10.3 Three states, not two

| Status | Meaning | Rendered as |
|---|---|---|
| `MEASURED` | We looked and got a value. | Bar with raw value and `normalised × weight = contribution`. |
| `MISSING` | We could not look — no data. | Hatched row, `NOT MEASURED`, weight excluded. |
| `NOT_APPLICABLE` | The question is meaningless here. | Hatched row, `NOT APPLICABLE`, weight excluded. |

Both are excluded from the denominator, but they are shown **differently**, because "we lack
the data" and "this cannot apply" tell a reviewer different things about the case.

### 10.4 Scoring

```
score = 100 × Σ(measured contributions) / Σ(measured weights)
```

Renormalised over **measured weight only**, so a candidate scored on 8 features is not
penalised against one scored on 12 — a gap in *our* data neither helps nor harms the vessel.
The EvidenceWaterfall states the actual denominator permanently ("…divided by the measured
weight (0.71 of 1.00), not by 1.00"), because a reader who does not know that will misread
every number on the screen.

**Tiers:**

| Tier | Rule |
|---|---|
| `STRONG` | score ≥ 70 |
| `MODERATE` | score ≥ 50 |
| `WEAK` | score ≥ 30 |
| `INSUFFICIENT_EVIDENCE` | score < 30, **or fewer than 6 of 12 features measured — regardless of score** |

Plus the degraded-origin cap: `STRONG` → `MODERATE` when the origin estimate is degraded.

If the **top** candidate is `INSUFFICIENT_EVIDENCE`, the ranking table is **replaced**, not
annotated — showing a leaderboard with a caveat invites the reader to act on the order anyway.

Ties break on measured-feature count: **more evidence wins.**

### 10.5 Confidence intervals

The top 10 candidates get a **bootstrap CI** (300 iterations here; the library default is 500).
`71 ±6` is a different claim from `71 ±22`, and only the first would justify acting. CIs are
computed for the top 10 only because 500 iterations × 200 candidates would dominate the run
for no decision-relevant gain.

Two sources of uncertainty are resampled:

1. **The drift ensemble** — which particle members are drawn, propagating the physical
   uncertainty into the score.
2. **Interpolated positions** — between AIS fixes a vessel's position is an estimate whose
   error grows with the reporting interval. A fix is treated as interpolated when it sits more
   than **3× the median interval** from its neighbour, and is perturbed by a Gaussian sized to
   the expected displacement error (≈10 kn × half the gap, capped at 20 km).

> **Real AIS fixes are NEVER perturbed.** This is a hard rule, not an optimisation: a recorded
> observation is evidence, and jittering it to widen an interval would be fabricating data to
> make a result look more careful than it is. Only values that were already estimates may be
> resampled. The result reports `realFixCount` and `perturbableFixCount`.

**Boundary effect.** Sometimes the unperturbed score falls *outside* the resampled interval.
That is not an error: a vessel whose closest approach is 0 km cannot get closer, so every
perturbation moves it further and the whole resampled distribution lies below the point
estimate. The interval is widened to include the point estimate, the raw percentile interval
is kept as `percentileCi`, and `scoreCiBoundaryEffect` records the explanation — which the
dossier's Uncertainty section then surfaces.

### 10.6 Reading the evidence

Click **Evidence** on any candidate:

- The **EvidenceWaterfall** — measured rows sorted by absolute contribution, each showing
  `raw value → normalised × weight = contribution`; unmeasured rows hatched and still visible.
- Click a **feature name** → `GET /candidates/:id/evidence/:featureKey` returns the feature's
  definition (unit, default weight, family), the source `evidenceRefs` (actual AIS fixes and
  gaps, with timestamps), and — when it could not be measured — **why not**.
- **VesselDetail** shows how much identity the archive really supports.
- A `STRONG` tier adds an inline statement that a strong evidential association is not a
  determination of responsibility.

### 10.7 Weight sensitivity

**Where:** Candidates tab → *Weight sensitivity* (collapsed by default).

The twelve weights are priors. An analyst who cannot see how much the ranking depends on them
is being asked to trust a number whose provenance is "someone chose 0.18". Move the sliders and
find out: **if the top candidate survives a large change, that is worth knowing; if it does
not, that is worth knowing more.**

Two things it is careful about:

1. **It is not a preview.** *Apply weights and re-rank* rewrites every candidate's score and
   rank server-side and stamps `weightProfileId: CUSTOM`, so the dossier will afterwards record
   that the ranking was produced under non-default weights. That is correct — a ranking must be
   identifiable as such — but it means the button is an **edit**, and the panel says so.
2. **Weights must sum to 1.000.** The server refuses otherwise with a `422`. The live sum is
   shown, and **Normalise** *scales* rather than clamps, preserving the ratios the analyst was
   actually expressing.

Only the *weighting* is recomputed. The underlying measurements are untouched.

### 10.8 Excluding a candidate

`POST /candidates/:id/exclude` with a **required reason** (`422` without one). The vessel drops
out of the ranking but **stays counted** in the summary, and the panel says *"N candidate(s)
excluded by an analyst and not shown"* — so a reader can see that a *decision* was made rather
than that a vessel never existed. The exclusion is written to the audit log.

---

## 11. The workspace map and timeline

**Where:** `/investigations/:id`.

The map is mounted **once** and the left rail switches what is shown beside it. Tabs never
remount it, so camera position and loaded tiles survive navigation.

Seven tabs: **Catalogue · Scenes & detections · Origin · AIS · Candidates · Activity · Team &
trail**, with the **Progress** panel beneath them naming the next step.

### 11.1 Layers

MapLibre basemap (land and coastlines from Natural Earth, served locally from
`public/basemap/`) + deck.gl overlays:

| Layer | Source |
|---|---|
| Area of interest | The investigation polygon. |
| SAR raster | TiTiler tiles of the ingested COG — the same pixels the detector ran on. |
| Detections | Slick polygons; `UNREVIEWED` hatched. |
| Origin zone | `support90`, labelled with its method. |
| AIS tracks | Reconstructed `LineString`s. |
| Vessels at cursor | Point markers at the time cursor. |

**The provenance gate.** Layers are registered *with* their provenance record; a layer whose
data has no source record is **refused by the store rather than drawn**. Layer state is keyed
per investigation, so layers cannot leak between them.

The **LayerStackControl** gives per-layer visibility and opacity, and shows each layer's
provider, dataset and licence.

### 11.2 The time scrubber

Play / pause / step, speeds 1× 10× 60× 300×, arrow keys step a minute (shift: an hour), space
toggles playback.

- The **release window is a band**, with the most-likely sub-interval marked — never a line.
- **Scene acquisition times are ticks**, so a scene boundary is visible while scrubbing.
- Playback drives an internal channel at frame rate but the React store syncs at **4 Hz** —
  a clock updating four times a second is indistinguishable from sixty, and the difference is
  the entire frame budget for every panel around the map.
- Under `prefers-reduced-motion`, playback is replaced by explicit stepping so no information
  is only available through animation.

### 11.3 Vessels at the cursor

`vesselsAt()` **omits any vessel it cannot place honestly** — one outside its own observed
window, or mid dark period. So the marker count rises and falls as vessels come in and out of
AIS coverage. **That is the data, not a bug.**

Hovering a candidate row or a track row highlights the corresponding vessel on the map, and
back.

---

## 12. The three extra views: prism, relief, globe

Each is its own route, so the workspace map is **unmounted** while one is open — the
two-WebGL-context budget is respected by never having both alive at once.

### 12.1 Space–time prism — `/investigations/:id/prism`

**Time is the vertical axis.** A vessel track becomes a **helix** through the volume; the
origin estimate becomes a **slab** occupying the release window. Where a helix passes through
the slab, that vessel was in the plausible release *area* during the plausible release
*period*.

That is the one thing a flat map cannot show: on a 2D plot, two vessels crossing the same
water twelve hours apart draw exactly the same picture. Here one passes through the slab and
the other misses it, at a visibly different height.

Coordinates are projected to **local metres** about the AOI centre (deck.gl's `OrbitView` is
Cartesian; mixing degrees with a time axis would make the vertical scale meaningless). Over an
AOI capped at 50,000 km² the equirectangular error is far below the width of a rendered track.
The vertical scale (**metres of Z per hour**) is stated on screen, and intersections are
computed and listed per vessel.

Camera presets: **isometric**, **plan**, **elevation**.

### 12.2 Slick relief — `/investigations/:id/relief`

The SAR image as 3D terrain. MapLibre reads elevation from Terrain-RGB tiles, so the **same
Sigma0 COG the detector ran on** drives the surface. A slick appears as a **basin**, because
oil damps capillary waves and returns far less energy — easier to see as terrain than as a
grey patch.

> **THE RELIEF IS BACKSCATTER, NOT SEA-SURFACE HEIGHT.**

That is the entire hazard of this view. A viewer who reads the basin as a depression in the
sea has understood something false about the physics, so the caption states it, states the
current exaggeration, and **cannot be dismissed**. Drag the exaggeration slider to **0** to
check that a basin is really in the data.

### 12.3 Orbital globe — `/globe`

Every investigation at its true AOI centroid, sized by total detected slick area and coloured
by strongest candidate tier.

Built on MapLibre's native globe projection rather than Three.js — the workspace bundle is
already 508 kB gzip against a 220 kB budget, and adding a second 3D engine to draw a sphere we
can already draw would make a measured problem worse for no new capability.

The **solar terminator** is computed from the actual solar position at the **selected
incident's acquisition time**, not the wall clock. An incident detected at local night is a
different proposition from one detected at noon: a SAR sensor does not care, but the
look-alike population does.

---

## 13. Report dossier and exports

**Where:** `/investigations/:id/report`. It renders **standalone** — no app chrome, light
theme, A4 width — so the printed page is only the dossier.

### 13.1 Structure

`SUMMARY · SCENES · DETECTIONS · ORIGIN · AIS · CANDIDATES · EVIDENCE · UNCERTAINTY · PROVENANCE`

**`UNCERTAINTY` and `PROVENANCE` are structurally mandatory.** They cannot be deselected, and
this is enforced in **three separate places** — the request schema, the report service, and
the job — because a dossier that names a vessel without stating what the analysis could not
establish, and where every number came from, is not a lesser report. It is a misleading one,
and it is exactly the document someone would want when the caveats are inconvenient.

The dossier reuses the **same `<EvidenceWaterfall>` component** as the workspace, so printed
evidence and on-screen evidence cannot diverge.

### 13.2 The Uncertainty section is derived, not boilerplate

Every statement is generated from a **recorded state**, so it cannot go stale or be quietly
softened between runs:

| Trigger | Severity | Statement |
|---|---|---|
| Origin `DEGRADED` or absent | `LIMITATION` | Names the degradation reason and the `MODERATE` cap. |
| Any candidate uncalibrated | `LIMITATION` | Scores are uncalibrated weighted evidence, not probabilities. |
| Fewer than 5 distinct vessels | `LIMITATION` | A high rank may reflect sparse coverage rather than strong evidence. |
| Median AIS interval > 600 s | `CAVEAT` | Positions between fixes are interpolated; short manoeuvres were not observed. |
| Any detection with look-alike risk > 0.4 | `CAVEAT` | Names the count. |
| Always | `LIMITATION` | The detector paragraph, with its **measured** IoU and false-positive rates (§7.1) — it stays a `LIMITATION` even once measured, because knowing the false-positive rate quantifies it rather than removing it. |
| Any boundary-effect CI | `CAVEAT` | Explains why the interval sits below the point estimate. |

### 13.3 The Provenance appendix

Every provenance record used in the run, with `sourceType`, provider, dataset ID, external ID,
licence, retrieval time and `derivedFrom` links — the full lineage from a ranked vessel back to
a provider product.

### 13.4 Exports

Three buttons on the toolbar (hidden when printing):

| Export | Contains | Use |
|---|---|---|
| **GeoJSON** | AOI, detection polygons, `ORIGIN_SUPPORT_50` / `ORIGIN_SUPPORT_90` — each with **provenance inline** and the origin features carrying `degradationReason` | Opens in QGIS. A proximity buffer must never be mistaken for a drift zone there either. |
| **CSV** | Every candidate and all twelve of its evidence features | Spreadsheet analysis. |
| **Run manifest** | Pipeline version, detector SHA, weight profile ID, scene product IDs, AIS source, origin method, generation time | Pins every input precisely enough to re-run the analysis. |

These exist so a finding can be **checked by someone who does not trust our UI**. Provenance
travels **inline** rather than in a sibling file, because an exported feature separated from
its source record is exactly the artefact this project exists to avoid.

**Print / Save as PDF** uses the browser's print path. The page carries
`data-report-ready="true"` for a headless renderer to wait on.

---

## 14. Jobs and activity

**Where:** workspace → **Activity** tab. `GET /jobs?investigationId=…`.

Five queues are registered: `ingest`, `drift`, `scoring`, `ais-import`, `report`.
**`inference` is deliberately not registered** — detection currently runs inside the ingest
job, and a stub processor would mark work complete without doing it.

Each row shows kind, queue, status (`QUEUED` / `RUNNING` / `COMPLETED` / `FAILED` /
`CANCELLED`), live progress percentage and stage, attempt count, and timing. **Cancel** and
**Retry** are available per job.

**Failure reasons are shown verbatim.** The provider chain's errors are specific and
actionable — *"HYCOM covers 1994 – 2024-09-05, requested 2025-09-21"* — and replacing that
with "job failed" would throw away the only thing that tells an analyst what to do next.

Rows refresh on Socket.IO `job:progress` / `job:completed` / `job:failed` events; the 2-second
poll while jobs are active is a floor for when the socket is down, not the primary mechanism.

**Idempotency:** every job carries a deterministic `jobKey` (`ingest:{inv}:{product}`,
`drift:{inv}:{detection}`, `scoring:{inv}:{detection}`). Re-requesting returns
`deduplicated: true` and HTTP `200` instead of `202` — no duplicate multi-second provider read
or ensemble run.

---

## 15. Team, audit trail, and admin

### 15.1 Team & trail — workspace tab

Add or remove members and set their per-investigation role (`viewer` / `analyst` / `lead`),
and read the **per-investigation audit trail** — who did what, when, with the request ID.

The trail is **not filterable or deletable here**. It is append-only server-side: *a trail an
investigator can prune is not a trail.*

### 15.2 `/admin` (admin role only)

| Panel | Content |
|---|---|
| **Users** | Every account, its global role, last login. Roles editable in place. |
| **Provider health** | Live circuit state, consecutive failures, retry time, call/failure counts, p95 latency, and `configured` — refreshed every 30 s. |
| **Quotas** | Consumption per quota key with period and reset time. |
| **Audit log** | The last 50 global entries. |

The audit log is **read-only by design, with no delete endpoint at all**: a log an
administrator can edit is not evidence of anything.

---

## 16. Cross-cutting

### 16.1 Provenance — four enforcement layers

Every data object in VARUNA carries a provenance record. It is enforced at four independent
levels, so no single mistake can leak an unsourced value into a screen or a report:

| Layer | Mechanism |
|---|---|
| **L1 — contract** | Zod schemas in `packages/shared` define the record shape; both the Node and Python stacks validate against it. |
| **L2 — database** | A Mongoose `provenancePlugin` rejects on pre-validate: missing, incomplete, or forbidden `sourceType` never reaches disk. |
| **L3 — API** | `provenanceGuard` middleware inspects every response, **strips** objects whose provenance is invalid, marks them `__provenanceMissing`, sets `X-Provenance-Count` / `X-Provenance-Stripped` headers and logs at severity 1. |
| **L4 — frontend** | `assertProvenance()` in `apiFetch`, plus the `<DataObject>` boundary, which renders a **deliberately ugly** `PROVENANCE MISSING` panel rather than the data. Map layers are refused registration without one. |

Records are **immutable** and deduplicated on `externalId`. Derived objects link to their
parents via `derivedFrom`, giving an unbroken chain from a ranked vessel → candidate →
detection → scene → provider product, and from an origin estimate → the exact ocean/atmosphere
model run it integrated.

### 16.2 The real-data policy check

`pnpm check:real-data` runs six checks and is a **required PR status check**. Among them: any
captured fixture's recorded `sha256` must still match its bytes — a fixture that drifted from
what the provider actually returned is not a real fixture.

### 16.3 Geodesy is a CI gate

`apps/api/src/geo/` (GeographicLib) and `services/ml/varuna_ml/geo/` (pyproj) both assert the
**same** known-answer file, `packages/shared/geo-known-answers.json`, and must agree to within
0.1 %. Distances, bearings and areas cannot silently diverge between the two stacks.

### 16.4 Realtime

Socket.IO namespaces `/jobs`, `/investigations`, `/ais`, with a JWT-from-cookie handshake and
**membership-checked room joins**. A `QueueEvents → Socket` bridge carries worker events into
the API process (the worker is a separate process). The header shows a **stale banner** when
the socket drops, rather than letting a frozen screen look live.

### 16.5 Demo staging

`pnpm run stage:demo` caches the real inputs for the Guam 2025-09-21 incident — the Sentinel-1
scene window (`S1C_IW_GRDH_1SDV_20250921T200737_…_rtc`) and the AIS slice — fetched once from
the real providers with their original provenance and checksums. Verified end to end: a real
scene plus **9,711 real AIS positions in 5.5 s**.

**It does not pre-compute detections, origin estimates or candidate rankings.** Those still run
live during the demo against the staged inputs. So a demo cannot be derailed by a provider
outage or a quota ceiling, and equally cannot show a result prepared in advance. If the
pipeline would fail on the day, it fails in front of the audience — which is the honest
arrangement.

---

## 17. Empty states and what they actually mean

| You see | It means | Do this |
|---|---|---|
| *"No acquisitions in this window"* | The catalogues answered successfully and hold nothing. **Not a failure.** | Widen the window, or accept a lower AOI overlap. |
| *"Catalogue search failed"* with an `attempted` list | No provider could be reached. | Read the per-provider outcomes and the `consequence` line; check `/admin` → Provider health. |
| No detections after ingest | The detector ran and found no dark feature above 0.05 km². | Check the scene actually covers the slick; check the Activity tab for a failed job. |
| Origin `reason: NOT_RUN` | Back-tracking has not been run. **Normal state, not an error.** | Origin tab → pick a detection → *Run back-tracking*. |
| Origin `DEGRADED` | No current/wind forcing covered this date (see the HYCOM gap, §9.3). | Either accept the `MODERATE` cap, or supply CMEMS credentials. |
| `409` on correlate | No origin estimate exists. | Run back-tracking first. |
| `NO_AIS_COVERAGE` | **No AIS positions at all** for that envelope and window. | This is an absence of *observation*. Outside US waters there is no free archive — pick an area marked `STAGED` or `OBTAINABLE`. |
| Candidates list empty | Correlation has not run, or it returned `NO_AIS_COVERAGE`. | Check the AIS coverage panel first. |
| Top candidate `INSUFFICIENT_EVIDENCE` | Fewer than 6 of 12 features measurable. | Usually sparse AIS or a too-weak origin. Both are stated in their own panels. |
| Vessel markers appearing and disappearing while scrubbing | Vessels entering and leaving AIS coverage; mid-gap positions are **not drawn**. | Nothing — that is the data. |
| `NOT MEASURED` / `NOT APPLICABLE` rows in the waterfall | The feature could not be measured, or the question is meaningless for this case. | Click the feature name for the specific reason. |
| Wind term reads *"wind unknown"* | No wind provider is configured; the term defaults to 0.5, never 1.0. | Configure ERA5/CDS credentials to enable it. |
| *"Investigation unavailable"* + HTTP 403 | You are not a member. | Ask its lead to add you in **Team & trail**. |

---

## 18. API surface reference

Base: `/api/v1`. All routes require authentication except `/health` and `/auth/*`.
OpenAPI 3.1 is generated from the Zod schemas and served at `/api/v1/openapi.json`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` | — | Session lifecycle. |
| `GET` | `/auth/me` | viewer | Current user. |
| `GET` | `/catalogue/search` | viewer | **Live** multi-provider scene search. |
| `GET` | `/catalogue/providers` | viewer | Circuit, quota, p95, last success. |
| `GET`/`POST` | `/investigations` | viewer / analyst | List, create. |
| `GET` | `/investigations/:id` · `/investigations/:id/summary` | viewer | Detail, rollup. |
| `PATCH`/`DELETE` | `/investigations/:id` | analyst / lead | Update (may return `SCOPE_CHANGED`), delete. |
| `POST` | `/investigations/:id/members` | lead | Add a member. |
| `GET` | `/investigations/:id/audit` | viewer | Per-investigation trail. |
| `POST` | `/investigations/:id/scenes/ingest` | analyst | Queue ingest + detect. |
| `GET` | `/investigations/:id/scenes` | viewer | Scene list. |
| `GET` | `/investigations/:id/scenes/:sceneId/tiles` | viewer | TiTiler raster **and** Terrain-RGB templates. |
| `GET` | `/investigations/:id/detections` | viewer | Detections for the investigation. |
| `GET` | `/detections/:id` · `/geometry` · `/versions` · `/tiles` | viewer | Detail, zoom-simplified outline, version history, raster. |
| `POST` | `/detections/:id/review` | analyst | `CONFIRM` / `REJECT` / `EDIT` / `REOPEN`. |
| `GET` | `/investigations/:id/ais/coverage` | viewer | **The honesty endpoint.** |
| `GET` | `/investigations/:id/ais/tracks` | viewer | Tracks, `times[]`, dark periods, query plan. |
| `GET` | `/investigations/:id/ais/vessels` | viewer | Persisted vessel tracks. |
| `GET` | `/ais/vessel/:mmsi` | viewer | Identity, MID-derived flag, validity. |
| `POST` | `/investigations/:id/origin/run` | analyst | Queue back-tracking. |
| `GET` | `/investigations/:id/origin` | viewer | Latest estimate, or `reason: NOT_RUN`. |
| `GET` | `/origin/:id` | viewer | One estimate. |
| `POST` | `/investigations/:id/candidates/correlate` | analyst | Queue correlation (**409** without an origin). |
| `GET` | `/investigations/:id/candidates` | viewer | Ranking + summary + permanent disclaimer. |
| `GET` | `/candidates/:id` · `/candidates/:id/evidence/:featureKey` | viewer | Candidate, per-feature source records. |
| `POST` | `/investigations/:id/candidates/reweight` | analyst | Re-rank under a custom profile (**422** if Σ ≠ 1). |
| `POST` | `/candidates/:id/exclude` | analyst | Exclude with a **required** reason. |
| `GET` | `/weight-profiles` | viewer | Default profile + the twelve feature definitions. |
| `GET` | `/investigations/:id/report/data` | viewer | Assembled dossier data. |
| `POST` | `/investigations/:id/report/generate` | analyst | Queue report generation. |
| `GET` | `/investigations/:id/exports/geojson` · `/csv` · `/manifest` | viewer | Machine-readable exports. |
| `GET` | `/jobs` · `/jobs/:id` | viewer | Job list and detail. |
| `POST` | `/jobs/:id/cancel` · `/jobs/:id/retry` | analyst | Job control. |
| `GET` | `/admin/users` · `/admin/providers` · `/admin/quotas` · `/admin/audit` | admin | Administration. |
| `POST` | `/admin/users/:id/role` | admin | Change a global role. |

**ML service** (internal only, never publicly exposed, `X-Service-Token` guarded):
`POST /ingest` · `POST /detect` · `POST /backtrack` · `GET /health`.

---

## Where to read more

| Topic | Document |
|---|---|
| Getting it running | [`RUNNING.md`](RUNNING.md) |
| Security posture | [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) |
| Product requirements | [`../01_PRD_Product_Requirements.md`](../01_PRD_Product_Requirements.md) |
| Architecture | [`../03_ARCHITECTURE.md`](../03_ARCHITECTURE.md) |
| UI/UX rules behind these screens | [`../04_UIUX_Design_System.md`](../04_UIUX_Design_System.md) |
| Detector, drift and scoring maths | [`../07_AIML_Specification.md`](../07_AIML_Specification.md) |
| Screen-by-screen flow | [`../08_APP_FLOW.md`](../08_APP_FLOW.md) |
| Datasets and their licences | [`../10_DATASETS_and_Sources.md`](../10_DATASETS_and_Sources.md) |
| Why each feature exists (PPT / Q&A) | [`../12_FEATURE_RATIONALE_PPT_QnA.md`](../12_FEATURE_RATIONALE_PPT_QnA.md) |
| The real-data rule | [`../13_REAL_DATA_POLICY.md`](../13_REAL_DATA_POLICY.md) |
| Build order and status | [`../../IMPLEMENTATION_PLAN.md`](../../IMPLEMENTATION_PLAN.md) · [`../../CONTEXT.md`](../../CONTEXT.md) |

In-product, `/guide` is the short version of this document for analysts.
