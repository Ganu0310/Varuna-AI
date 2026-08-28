# 01 — Product Requirements Document (PRD)

**Product:** VARUNA — Vessel Attribution through Remote-sensing & Unified Navigational Analytics
**Problem Statement:** SIH26143 — Satellite Imagery + AIS Based Oil Spill Vessel Attribution System
**Document version:** 1.0
**Status:** Baseline for build

---

## 1. Problem Definition

### 1.1 The operational gap

When an oil slick appears on the sea surface, three facts are usually knowable and one is
usually not:

| Knowable | Source | Not knowable without correlation |
|---|---|---|
| *Where* the slick is now | SAR / optical satellite imagery | *Who* discharged it |
| *When* it was observed | Satellite acquisition timestamp | *When* it was discharged |
| *Which vessels were in the area* | AIS broadcast records | *Which of them is plausibly responsible* |

The gap is not a sensing gap. It is a **correlation gap**. Satellite imagery and AIS both
exist, are both frequently free and public, and are almost never joined in space *and*
time by a system that shows its working.

### 1.2 Why the gap persists

1. **Different physical domains.** Imagery is raster plus projected coordinates. AIS is a
   sparse, irregular, per-vessel time series. Joining them requires geodesy, resampling
   and interpolation — not a database join.
2. **The slick moves.** The location where a slick is *observed* is not the location where
   it was *released*. Between release and overpass, wind and surface current translate and
   stretch it. Correlating vessels against the observed footprint is a well-documented
   source of false attribution.
3. **Time is an interval, not an instant.** A SAR scene gives one timestamp. The release
   happened at some unknown time before it. Any honest system must reason over a *window*.
4. **AIS is adversarial.** Gaps, spoofed MMSIs, disabled transponders and duplicated
   identities are common precisely in the situations that matter. Most academic pipelines
   assume clean AIS.
5. **Existing operational systems are closed.** EMSA CleanSeaNet and KSAT do this well and
   are unavailable to most of the world (see [09_RESEARCH](09_RESEARCH_Competitive_Analysis.md)).

### 1.3 Scale of the harm

Operational (deliberate) discharges — tank washing, bilge dumping, sludge release — are
chronic, dispersed and rarely attributed, and cumulatively significant relative to
headline tanker casualties. Attribution is the deterrent. Detection alone is not.

---

## 2. Product Vision

> A single investigator, with a free satellite scene and free AIS records, should be able
> to move from "there is a slick here" to "here are the four vessels that could have
> produced it, ranked, with the evidence and the uncertainty for each" in under fifteen
> minutes — and be able to defend every number in that dossier to a regulator, a court, or
> a hostile cross-examination.

---

## 3. Goals and Non-Goals

### 3.1 Goals

| ID | Goal |
|---|---|
| G1 | Detect and delineate oil-like slicks in real satellite imagery with quantified accuracy |
| G2 | Convert detections into georeferenced polygons with real-world area, extent and morphology |
| G3 | Estimate a **probable release zone** and **release-time window** via physics-based back-tracking, not centroid assumption |
| G4 | Ingest, clean and reconstruct real AIS vessel trajectories, including quality flags |
| G5 | Rank candidate vessels using transparent, per-factor, individually inspectable evidence |
| G6 | Present the full reasoning chain in an investigator-grade interface |
| G7 | Export a structured, reproducible incident dossier including methodology and uncertainty |
| G8 | Operate exclusively on real, citable data — at every stage, including model training |

### 3.2 Non-Goals (explicitly out of scope)

| ID | Non-goal | Why |
|---|---|---|
| NG1 | Declaring legal guilt | Outside the epistemic reach of the evidence. The product ranks; humans decide. |
| NG2 | Real-time global monitoring at EMSA scale | Requires satellite tasking contracts and 24/7 ops. We do incident reconstruction plus near-real-time regional monitoring. |
| NG3 | Oil *type* fingerprinting | Requires physical sampling and GC-MS. Not remotely sensable. |
| NG4 | Predicting future spills | Different problem class. |
| NG5 | Replacing aerial verification | Satellite detection has known look-alike ambiguity; aerial or vessel confirmation stays in the loop. |
| NG6 | Any use of simulated or synthetic vessels/slicks in demo or evaluation | Violates the core data policy. |

---

## 4. Users and Personas

### P1 — Coast Guard Pollution Response Officer ("Lt. Cdr. Meera")
- **Context:** Receives a report of a slick. Has 90 minutes to decide whether to launch an aircraft.
- **Needs:** Fast shortlist, confidence, ability to see *why*. Must not be misled.
- **Success:** Launches the aircraft toward the right vessel, or correctly decides not to launch.
- **Failure mode to avoid:** A confident-looking ranking with no visible uncertainty.

### P2 — Marine Environmental Analyst ("Arjun", state pollution control board)
- **Context:** Builds the case file weeks after the event. Needs defensibility over speed.
- **Needs:** Full provenance, methodology appendix, reproducibility, export.
- **Success:** Produces a dossier that survives legal review.

### P3 — Remote Sensing / GIS Researcher ("Dr. Sen")
- **Context:** Wants to validate or extend the detection model.
- **Needs:** Model metrics on held-out data, access to masks, ability to re-run with different parameters, honest failure cases.
- **Success:** Can reproduce a published result and see where the model fails.

### P4 — Port / Maritime Authority Duty Officer ("Rakesh")
- **Context:** Monitors a defined port approach zone continuously.
- **Needs:** Standing area-of-interest monitoring, alerting, low false-alarm rate.
- **Success:** Gets alerted to real events and is not spammed by wind-shadow look-alikes.

### P5 — System Administrator
- **Needs:** Manage users and roles, data-source credentials, quotas, audit log, job health.

---

## 5. User Stories

### Epic A — Incident Intake

| ID | Story | Acceptance criteria |
|---|---|---|
| A1 | As an analyst, I create an investigation by drawing an AOI and setting a date range, so the system knows where and when to look. | AOI ≤ 50,000 km²; date range ≤ 30 days; both persisted; investigation gets an immutable ID and audit entry. |
| A2 | As an analyst, I search available satellite scenes covering my AOI and window. | Results come from a live catalogue query (CDSE / Planetary Computer STAC), showing platform, mode, polarisation, acquisition time UTC, footprint overlap percentage, and cloud cover for optical. Zero results is a valid, clearly communicated outcome. |
| A3 | As an analyst, I select one or more scenes and trigger ingestion. | Job enqueued; progress streamed over WebSocket; scene stored as COG in object storage with full STAC metadata retained. |
| A4 | As an analyst, I upload my own georeferenced scene (GeoTIFF). | CRS, transform and timestamp are read from the file. A file without georeferencing or acquisition time is **rejected**, not defaulted. |

### Epic B — Detection

| ID | Story | Acceptance criteria |
|---|---|---|
| B1 | As an analyst, I run oil-slick segmentation on an ingested scene. | Model returns per-pixel class map (sea / oil / look-alike / ship / land) with a per-class confidence raster. |
| B2 | As an analyst, I see detected slicks as polygons on the map with area in km². | Polygons are geodesically correct; area computed on an equal-area projection, not in degrees. |
| B3 | As an analyst, I see *why* the model is or is not confident. | Confidence panel shows model probability, wind-condition suitability, look-alike class competition, and slick morphology metrics. |
| B4 | As an analyst, I can correct a detection (accept / reject / redraw). | Correction is recorded as a labelled human decision, versioned, attributed to the user, and available as future training data. Original model output is never overwritten. |
| B5 | As an analyst, I compare before/after imagery for the same location. | Swipe/split comparison of two real acquisitions with their true timestamps. |

### Epic C — Origin and Time Estimation

| ID | Story | Acceptance criteria |
|---|---|---|
| C1 | As an analyst, the system back-tracks the slick to estimate where it started. | Particle ensemble seeded across the slick polygon, driven by real CMEMS currents plus ERA5/GFS winds, integrated backwards over the candidate window. Output is a **probability density surface**, not a point. |
| C2 | As an analyst, I see an estimated release-time window rather than a single time. | Window derived from slick elongation versus drift speed, bounded by prior scene coverage. Presented as an interval with a most-likely sub-interval. |
| C3 | As an analyst, I can scrub the back-track animation. | Timeline scrubber animates the particle cloud from observation time backwards. |
| C4 | When environmental data is unavailable for the region or date, the system says so. | Drift module returns `UNAVAILABLE` with a reason; the system degrades to footprint-proximity mode and **labels the degradation in the UI and the report**. |

### Epic D — AIS Correlation

| ID | Story | Acceptance criteria |
|---|---|---|
| D1 | As an analyst, the system retrieves all AIS positions in the search envelope. | Envelope = origin-probability support buffered by drift uncertainty, over the release-time window plus margin. Source and record count shown. |
| D2 | As an analyst, vessel tracks are reconstructed from raw pings. | Gap-aware segmentation, outlier removal by kinematic implausibility, great-circle interpolation only within a configured maximum gap. |
| D3 | As an analyst, I see AIS data-quality flags per vessel. | Flags: `AIS_GAP`, `POSITION_JUMP`, `MMSI_INVALID`, `MMSI_DUPLICATE`, `STATIC_MISMATCH`, `LOW_SAMPLING`. Each is explainable on hover. |
| D4 | As an analyst, a vessel that went dark inside the release window is highlighted. | Dark-period detection with duration, entry point, exit point, and whether the dark period overlaps the origin zone. |
| D5 | As an analyst, I can replay all vessel movement across the incident window. | Time-slider driven animated tracks; playback speeds; scrub to any UTC timestamp. |

### Epic E — Attribution and Evidence

| ID | Story | Acceptance criteria |
|---|---|---|
| E1 | As an analyst, candidate vessels are ranked by an investigative priority score. | Score in [0,100] with a calibrated confidence band and an explicit tier: `STRONG` / `MODERATE` / `WEAK` / `INSUFFICIENT_EVIDENCE`. |
| E2 | As an analyst, I see the per-factor contribution to each score. | Waterfall/contribution chart per factor, with the raw measured value alongside the normalised contribution. |
| E3 | As an analyst, I can open any factor and see the underlying records. | Click-through from "temporal proximity: 0.81" to the exact AIS pings and timestamps that produced it. |
| E4 | As an analyst, I can adjust factor weights and immediately see the effect. | Live re-ranking; the modified weight profile is recorded in the investigation and printed in the report. |
| E5 | As an analyst, the system tells me when it cannot conclude anything. | If the top candidate's score is below threshold, or if the evidence spread is degenerate, the UI leads with `INSUFFICIENT_EVIDENCE` rather than a ranking. |
| E6 | As an analyst, I can exclude a vessel with a documented reason. | Exclusion plus reason recorded in the audit trail and the report. |

### Epic F — Reporting and Collaboration

| ID | Story | Acceptance criteria |
|---|---|---|
| F1 | As an analyst, I export a full incident dossier as PDF. | Contains incident summary, scene metadata, detection maps, morphology, drift methodology and parameters, AIS source and coverage, candidate table, per-candidate evidence pages, uncertainty statement, full data-provenance appendix, and methodology version hashes. |
| F2 | As an analyst, I export machine-readable results. | GeoJSON (slicks, tracks, origin field) plus CSV (candidates, evidence factors) plus JSON (full run manifest). |
| F3 | As a team, we can annotate an investigation. | Threaded comments pinned to map features or candidates. |
| F4 | As an admin, every action is auditable. | Append-only audit log: who, what, when, before and after. |

### Epic G — Monitoring

| ID | Story | Acceptance criteria |
|---|---|---|
| G1 | As a duty officer, I register a standing AOI for automatic monitoring. | New scenes over the AOI are auto-ingested and auto-processed on a schedule. |
| G2 | As a duty officer, I receive an alert when a slick is detected. | Email or webhook with slick summary and deep link. Alert threshold configurable. |

---

## 6. Functional Requirements

### FR-1 Satellite Data Pipeline
- **FR-1.1** Query live STAC/OData catalogues for Sentinel-1 GRD, Sentinel-2 L2A, and Landsat 8/9.
- **FR-1.2** Filter by AOI intersection, time range, platform, orbit direction, polarisation, and (optical) cloud cover.
- **FR-1.3** Download and stage scenes to object storage; convert to Cloud-Optimised GeoTIFF.
- **FR-1.4** Preserve the complete original metadata record (STAC item JSON) immutably.
- **FR-1.5** SAR preprocessing chain: orbit correction → thermal-noise removal → border-noise removal → radiometric calibration to sigma-nought → speckle filtering → terrain correction → dB conversion. Each step recorded in the processing manifest.
- **FR-1.6** Land masking from a real coastline vector source (OSM coastlines / GSHHG).
- **FR-1.7** Generate XYZ tiles for map display directly from the COG (no pre-rendered screenshots).

### FR-2 Oil Slick Detection
- **FR-2.1** Semantic segmentation over five classes: `sea`, `oil_spill`, `look_alike`, `ship`, `land`.
- **FR-2.2** Tiled inference over arbitrarily large scenes with overlap blending to remove seams.
- **FR-2.3** Per-pixel class probability output retained, not just argmax.
- **FR-2.4** Post-processing: morphological opening and closing, minimum-area filter, hole filling.
- **FR-2.5** Vectorisation: raster mask → GeoJSON polygons with correct affine transform and CRS, simplified with a documented tolerance.
- **FR-2.6** Morphology metrics per polygon: area (km²), perimeter, major/minor axis, elongation ratio, orientation bearing, convexity, centroid.
- **FR-2.7** Look-alike suppression using ancillary evidence: wind speed at acquisition, distance to known seeps and platforms, proximity to river plumes.
- **FR-2.8** Human review workflow producing versioned corrections.

### FR-3 Environmental and Drift
- **FR-3.1** Fetch real surface current fields (CMEMS) and 10 m wind fields (ERA5 / GFS) for the AOI and window.
- **FR-3.2** Backward Lagrangian particle transport with configurable ensemble size (default 5,000).
- **FR-3.3** Forcing model: `u_particle = u_current + alpha * u_wind`, with `alpha` sampled per particle from 0.02–0.04, a sampled Ekman deflection of 0°–20°, plus a horizontal diffusion term. Parameters recorded per run.
- **FR-3.4** Output: time-indexed particle cloud plus a kernel-density origin probability surface per time step.
- **FR-3.5** Release-time window estimator combining slick major-axis length, drift speed, and prior-scene non-detection.
- **FR-3.6** Graceful, *labelled* degradation when forcing data is unavailable.

### FR-4 AIS Processing
- **FR-4.1** Multi-source ingestion: bulk historical CSV (Marine Cadastre, Danish DMA, Norwegian AIS), API (Global Fishing Watch), live stream (AISStream WebSocket).
- **FR-4.2** Normalisation to a single canonical schema with UTC timestamps.
- **FR-4.3** Validation: MMSI format and MID country prefix, latitude/longitude bounds, SOG/COG plausibility, duplicate detection.
- **FR-4.4** Outlier removal by kinematic gate (implied speed between consecutive pings above a threshold).
- **FR-4.5** Trajectory reconstruction with gap-aware segmentation.
- **FR-4.6** Dark-period detection with duration and geographic bounds.
- **FR-4.7** Static data join: vessel name, type, IMO, dimensions, flag (from AIS Message 5 and open registries).

### FR-5 Candidate Filtering
- **FR-5.1** Spatiotemporal envelope query against MongoDB time-series collections plus the `2dsphere` index.
- **FR-5.2** Coarse filter: any position inside the envelope. Fine filter: track geometry versus origin field.
- **FR-5.3** Configurable radius (default: origin-field 90th-percentile support plus 15 km) and time margin (default ±3 h beyond the estimated window).
- **FR-5.4** Vessel-type prefilter is **advisory only** and never removes a vessel silently.

### FR-6 Attribution Scoring
- **FR-6.1** Twelve evidence features (full definitions in [07_AIML §7.6](07_AIML_Specification.md)).
- **FR-6.2** Transparent additive model (weighted normalised features / logistic regression) — **no black-box ranker**.
- **FR-6.3** Per-feature contribution exposed via the model's own coefficients, and via SHAP where a non-linear variant is enabled.
- **FR-6.4** Probability calibration (isotonic or Platt) against validated incidents.
- **FR-6.5** Confidence interval from bootstrap over drift ensemble members and AIS interpolation uncertainty.
- **FR-6.6** Mandatory `INSUFFICIENT_EVIDENCE` outcome path.
- **FR-6.7** Missing features are propagated as missing, never imputed with a neutral default that inflates a score.

### FR-7 Investigation Workspace (UI)
- **FR-7.1** Multi-layer interactive map: basemap, SAR raster, slick polygons, origin probability heat surface, AIS tracks, candidate markers, land mask, AOI.
- **FR-7.2** Temporal scrubber synchronising every time-aware layer.
- **FR-7.3** Candidate ranking panel with expandable evidence.
- **FR-7.4** Evidence detail drawer with source-record drill-down.
- **FR-7.5** Before/after imagery comparator.
- **FR-7.6** Job/pipeline status console with live progress.
- **FR-7.7** Provenance inspector for any selected object.

### FR-8 Reporting
- **FR-8.1** PDF dossier via headless-browser render of a dedicated report route.
- **FR-8.2** Deterministic, versioned report template; the report embeds pipeline version, model version, and weight-profile hash.
- **FR-8.3** GeoJSON / CSV / run-manifest export.

### FR-9 Platform
- **FR-9.1** Email and password auth with JWT access/refresh tokens in httpOnly cookies.
- **FR-9.2** RBAC: `viewer`, `analyst`, `lead`, `admin`.
- **FR-9.3** Append-only audit log.
- **FR-9.4** Per-user and per-organisation quota on external API consumption.
- **FR-9.5** Job queue with retry, dead-letter, and cancellation.

---

## 7. Non-Functional Requirements

| ID | Category | Requirement | Target |
|---|---|---|---|
| NFR-1 | Performance | Map interaction frame rate with 250k AIS points | ≥ 50 fps on a 2020-class laptop GPU |
| NFR-2 | Performance | Spatiotemporal AIS envelope query | p95 < 400 ms for a 100 km × 24 h envelope |
| NFR-3 | Performance | Segmentation inference, one Sentinel-1 IW GRD scene | < 4 min on a single T4-class GPU; < 20 min CPU-only |
| NFR-4 | Performance | Drift back-track, 5,000 particles × 24 h | < 90 s |
| NFR-5 | Performance | Scoring and ranking for 200 candidates | < 3 s |
| NFR-6 | Performance | API p95 (non-job endpoints) | < 250 ms |
| NFR-7 | Scalability | Concurrent investigations | 50 without degradation |
| NFR-8 | Scalability | AIS positions stored | 10^9 documents via time-series collections and monthly partitioning |
| NFR-9 | Reliability | Job success rate on valid inputs | ≥ 99% with three retries and exponential backoff |
| NFR-10 | Reliability | Ingestion is idempotent | Re-running a scene ingest produces no duplicates |
| NFR-11 | Security | Secrets never in client bundle or repo | Enforced by CI secret scan |
| NFR-12 | Security | Transport | TLS 1.2+ everywhere; HSTS |
| NFR-13 | Security | Authorisation | Every route guarded; deny by default |
| NFR-14 | Auditability | Every state change logged | Append-only, immutable, exportable |
| NFR-15 | Accessibility | WCAG 2.1 AA | Contrast, keyboard navigation, focus rings, screen-reader labels on all controls |
| NFR-16 | Accessibility | Motion | Full `prefers-reduced-motion` support; no information conveyed by motion alone |
| NFR-17 | Accessibility | Colour | No information conveyed by hue alone; confidence also encoded by label and position |
| NFR-18 | Provenance | Every rendered data object has a provenance record | UI refuses to render objects lacking one |
| NFR-19 | Reproducibility | Any run can be replayed | Run manifest pins scene IDs, model hash, parameters, data source versions |
| NFR-20 | Portability | Full local bring-up | `docker compose up` with MinIO, local MongoDB and Redis |
| NFR-21 | Data integrity | No fabricated data anywhere | CI check; see [13_REAL_DATA_POLICY](13_REAL_DATA_POLICY.md) |
| NFR-22 | Internationalisation | UTC everywhere internally; local-time display optional | All timestamps stored and transmitted as ISO-8601 UTC |

---

## 8. Scope: MVP versus Full

### 8.1 MVP (hackathon deliverable) — must be complete and working end to end

The MVP is defined by **one fully reconstructed real historical incident**, demonstrated
live, with no gaps in the chain.

| MVP item | Definition of done |
|---|---|
| M1 | Real Sentinel-1 GRD scene ingested from CDSE or Planetary Computer, preprocessed, and displayed as a real raster tile layer |
| M2 | Trained segmentation model produces a slick mask on that real scene |
| M3 | Mask vectorised to a georeferenced polygon with real area in km² |
| M4 | Real wind and current fields fetched for that date and region |
| M5 | Backward drift produces an origin probability surface and a release-time window |
| M6 | Real AIS records for that region and window loaded from a public historical archive |
| M7 | At least five candidate vessel trajectories reconstructed and rendered |
| M8 | Candidates ranked with the full per-factor evidence breakdown |
| M9 | Timeline replay works and is synchronised across layers |
| M10 | PDF dossier exports with methodology, uncertainty and provenance appendix |
| M11 | Model evaluation metrics (IoU/Dice/F1) reported on a held-out real test split |
| M12 | Every screen passes the provenance check — nothing rendered without a source |

### 8.2 Phase 2 (post-MVP)
- Live AIS stream integration and standing-AOI monitoring
- Multi-scene temporal slick tracking (same slick across consecutive overpasses)
- Optical/SAR fusion for look-alike disambiguation
- Uncertainty calibration against a multi-incident validation set
- Collaborative multi-analyst investigation with presence
- Alerting (email, webhook, SMS)

### 8.3 Phase 3 (vision)
- Regional deployment for the Indian EEZ with ISRO EOS-04 / RISAT integration and INCOIS currents
- Model retraining loop fed by analyst corrections
- Cross-incident vessel behaviour profiling (repeat-offender detection)
- Integration hooks for national contingency-plan workflows (NOS-DCP)

---

## 9. Success Metrics

### 9.1 Model metrics (measured on a held-out split of real labelled data)

| Metric | Target (MVP) | Target (Phase 2) |
|---|---|---|
| Oil-class IoU | ≥ 0.55 | ≥ 0.65 |
| Oil-class Dice/F1 | ≥ 0.70 | ≥ 0.78 |
| Oil-class recall | ≥ 0.75 | ≥ 0.85 |
| Mean IoU (five classes) | ≥ 0.60 | ≥ 0.70 |
| Look-alike → oil false-positive rate | ≤ 0.20 | ≤ 0.10 |

> These targets are set relative to published benchmarks on the same public dataset
> family (see [09_RESEARCH §9.6](09_RESEARCH_Competitive_Analysis.md)), not invented.

### 9.2 System metrics

| Metric | Target |
|---|---|
| Top-3 containment rate on validated incidents with known source | ≥ 70% |
| Origin-zone centroid error versus known release point | ≤ 12 km median (24 h drift) |
| Release-time window contains true release time | ≥ 80% of validated cases |
| Track reconstruction completeness (fraction of true positions retained) | ≥ 95% |
| Time from scene selection to ranked dossier (single scene) | ≤ 15 min wall-clock |

### 9.3 Product metrics

| Metric | Target |
|---|---|
| Fraction of scores fully traceable to source records | 100% |
| Fraction of rendered objects with provenance | 100% |
| Investigations ending in an honest `INSUFFICIENT_EVIDENCE` where warranted | Reported, not minimised |
| Analyst-reported time saved versus manual workflow | Qualitative, captured in user testing |

---

## 10. Risks and Mitigations

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | Look-alikes (low wind, biogenic slicks, rain cells) misclassified as oil | High | High | Five-class model that explicitly learns `look_alike`; wind-condition gate at 3–10 m/s; ancillary context features; confidence shown; human review loop |
| R2 | AIS gaps or spoofing hide the responsible vessel | High | Medium | Dark-period detection as an *explicit positive evidence factor*; MMSI validity checks; SAR ship detection cross-check to find AIS-less vessels |
| R3 | Drift model error propagates into a wrong origin zone | High | Medium | Ensemble with sampled wind-drift coefficient and deflection; output a probability field with visible uncertainty rather than a point; confidence interval on scores |
| R4 | Insufficient labelled training data for the region of interest | Medium | High | Train on the public MKLab/CERTH Sentinel-1 oil spill dataset; augment with real SAR from validated incidents; transfer-learn; never generate synthetic slicks |
| R5 | External API quota exhaustion mid-demo | High | Medium | Pre-stage the demo incident's scenes and AIS locally in MinIO; per-key quota tracking; graceful fallback ordering across providers |
| R6 | Attribution misused as proof of guilt | Very High | Medium | Product-level guardrails: tier labels, mandatory uncertainty statement in every export, no "guilty" language anywhere in copy, `INSUFFICIENT_EVIDENCE` as a first-class result |
| R7 | MongoDB lacks true spatial functions needed for polygon distance | Medium | Certain | Turf.js and Shapely compute layer with results persisted back as derived GeoJSON; documented in [02_TRD §2.6](02_TRD_Technical_Requirements.md) |
| R8 | Data volume (SAR scenes around 1 GB each; AIS around 10^7 rows per month) | Medium | High | COG plus HTTP range requests instead of full downloads; time-series collections; monthly AIS partitions; object-storage lifecycle rules |
| R9 | Timezone or CRS errors silently corrupting correlation | High | Medium | Single canonical rule: UTC and EPSG:4326 for storage, equal-area projection for measurement only; unit tests on known-answer geodesic cases |
| R10 | Judges assume the demo is faked | Medium | Medium | Live provenance inspector on every object; scene IDs and AIS record counts visible on screen; offer to re-run against a judge-chosen date |

---

## 11. Assumptions and Dependencies

**Assumptions**

1. Sentinel-1 coverage exists for the chosen demo incident (verified before selection).
2. Free historical AIS coverage exists for the demo region (US, Danish or Norwegian waters, or Global Fishing Watch coverage).
3. A GPU is available for training; inference can fall back to CPU.
4. Judges accept incident *reconstruction* as a valid demonstration of a near-real-time-capable pipeline.

**External dependencies**

- Copernicus Data Space Ecosystem availability
- CMEMS and CDS (ERA5) availability and registration
- At least one AIS archive or API remaining accessible
- MongoDB Atlas free tier, or self-hosted MongoDB, for the demo

**Documented consequence if an assumption fails:** the affected module degrades to a
labelled reduced-capability mode and the report states the limitation. It never
substitutes fabricated values.

---

## 12. Release Criteria

VARUNA MVP is releasable when **all** of the following hold:

1. All M1–M12 items in §8.1 are demonstrably working on a real incident.
2. Model metrics meet the MVP targets in §9.1 on a held-out real test split.
3. No code path can produce, ingest or render fabricated data (CI check green).
4. Every screen passes the provenance audit.
5. The PDF dossier renders completely and includes the uncertainty and provenance sections.
6. The accessibility audit passes WCAG 2.1 AA on the primary workspace.
7. A cold `docker compose up` on a clean machine reaches a working system using only documented environment variables.
8. All thirteen documents in this suite are current with the shipped build.
