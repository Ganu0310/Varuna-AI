# VARUNA — Documentation Suite

**Vessel Attribution through Remote-sensing & Unified Navigational Analytics**

> Smart India Hackathon 2026 — Problem Statement **SIH26143**
> Satellite Imagery + AIS Based Oil Spill Vessel Attribution System

---

## 0.1 What This System Is

VARUNA is a **maritime environmental investigation platform**. It ingests real satellite
imagery (primarily Sentinel-1 C-band SAR), detects and segments oil-like slicks with a
deep learning model, converts those detections into georeferenced polygons, back-tracks
the slick through real wind and ocean-current fields to estimate a **probable release
zone and release-time window**, correlates that zone against **real AIS vessel
trajectories**, and produces a **ranked, fully explainable evidence dossier** of vessels
that warrant investigation.

## 0.2 What This System Is *Not*

VARUNA does **not** assert legal responsibility. It produces an *investigative priority
score* backed by traceable evidence, with explicit uncertainty and an explicit
"insufficient evidence" outcome. Every number in the UI can be traced back to a source
observation record. This distinction is a core product requirement, not a disclaimer.

## 0.3 The Non-Negotiable Data Rule

**Zero mock data. Zero fake data. Zero fabricated data. Zero synthetic placeholders in
any demo, screenshot, metric, or model training run.**

Every pixel, every AIS ping, every current vector, every reported metric originates from
a named, citable, reproducible public source. This rule is enforced in code (see
[13_REAL_DATA_POLICY.md](13_REAL_DATA_POLICY.md)), in CI, and in the UI itself — every
data object carries a provenance record and the interface refuses to render an object
without one.

---

## 0.4 Document Map

| # | Document | Covers | Primary Audience |
|---|---|---|---|
| 01 | [PRD — Product Requirements](01_PRD_Product_Requirements.md) | Problem, personas, user stories, functional + non-functional requirements, scope, MVP, success metrics | Everyone |
| 02 | [TRD — Technical Requirements](02_TRD_Technical_Requirements.md) | Stack decisions, data contracts, algorithms, performance budgets, security, **embedded API-key register** | Engineers, judges |
| 03 | [Architecture](03_ARCHITECTURE.md) | Service topology, deployment, data stores, queues, scaling, failure modes | Engineers |
| 04 | [UI/UX Design System](04_UIUX_Design_System.md) | Design language, colour tokens, typography scale, motion + 3D system, component library, accessibility | Designers, frontend |
| 05 | [Frontend Specification](05_FRONTEND_Specification.md) | React app structure, routing, state, map engine, every screen and component, function-level behaviour | Frontend engineers |
| 06 | [Backend Specification](06_BACKEND_Specification.md) | Express API surface, MongoDB schemas + indexes, job queue, auth, WebSockets, every endpoint | Backend engineers |
| 07 | [AI/ML Specification](07_AIML_Specification.md) | SAR preprocessing, segmentation model, training protocol, drift back-tracking, attribution scoring, calibration, evaluation | ML engineers |
| 08 | [App Flow](08_APP_FLOW.md) | End-to-end journeys, screen-by-screen flow, sequence diagrams, state machines, error paths | Everyone |
| 09 | [Research & Competitive Analysis](09_RESEARCH_Competitive_Analysis.md) | Every comparable existing system, what they do, what they miss, our defensible differentiation, literature review | Judges, product |
| 10 | [Datasets & Sources](10_DATASETS_and_Sources.md) | Every dataset required, exact acquisition route, licence, volume, and the incidents we reconstruct | Data / ML |
| 11 | [API Keys & External Services](11_API_KEYS_and_External_Services.md) | Complete key register, signup route, cost, quota, env-var names, rotation policy | DevOps |
| 12 | [Feature Rationale — PPT Q&A](12_FEATURE_RATIONALE_PPT_QnA.md) | For every feature: how it works, why it exists, what breaks without it, likely judge questions + answers | Presenters |
| 13 | [Real Data Policy](13_REAL_DATA_POLICY.md) | The no-mock-data contract, provenance schema, CI enforcement, what to do when data is missing | Everyone |

---

## 0.5 Technology Stack at a Glance

| Layer | Choice | Note |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | MERN "R" |
| Map / geo-viz | MapLibre GL JS + deck.gl | WebGL; handles millions of AIS points |
| 3D | react-three-fiber + drei | Globe, hero, 3D slick relief |
| Motion | Framer Motion + GSAP ScrollTrigger | Respects `prefers-reduced-motion` |
| API server | Node.js 20 + Express 5 + TypeScript | MERN "E" + "N" |
| Database | MongoDB 7 (Atlas) with 2dsphere + time-series collections | MERN "M" |
| Geometry in JS | Turf.js | Compensates for MongoDB's lack of PostGIS functions |
| ML / geo service | Python 3.11 + FastAPI | PyTorch, rasterio, GeoPandas, Shapely, OpenDrift |
| Queue | BullMQ on Redis | Long-running ingestion + inference jobs |
| Realtime | Socket.IO | Job progress, live AIS, collaborative investigation |
| Object storage | S3-compatible (Cloudflare R2 / MinIO) | Scenes, COGs, masks, report PDFs |
| Tiles | TiTiler (COG → XYZ/WMTS) | Serves real satellite rasters, not screenshots |

> **On MERN + geospatial:** MongoDB is not PostGIS. It gives us GeoJSON storage,
> `2dsphere` indexing, and `$geoWithin` / `$geoIntersects` / `$geoNear`, which covers
> ~80% of what we need at the *query* layer. The remaining 20% — buffering,
> polygon-to-polygon distance, simplification, unions, length-along-track — is done in
> **Turf.js** (Node) and **Shapely/GeoPandas** (Python) and the results are *persisted
> back* into MongoDB as derived GeoJSON. This is a deliberate, documented trade-off, not
> an oversight. Full reasoning in [02_TRD §2.6](02_TRD_Technical_Requirements.md).

---

## 0.6 How to Read This Suite

- **Judges / evaluators** → 01 (PRD), 09 (Research), 12 (Feature Rationale Q&A).
- **Building the frontend** → 04 (Design System) then 05 (Frontend Spec) then 08 (App Flow).
- **Building the backend** → 03 (Architecture) then 06 (Backend Spec) then 02 (TRD).
- **Building the model** → 07 (AI/ML) then 10 (Datasets) then 13 (Real Data Policy).
- **Setting up the environment** → 11 (API Keys) then 03 (Architecture §3.9 Local Dev).
- **Where the project stands** → [`docs/STATUS_REPORT.md`](docs/STATUS_REPORT.md).
- **Running it** → [`docs/RUNNING.md`](docs/RUNNING.md).
- **Using it** → [`docs/FEATURE_GUIDE.md`](docs/FEATURE_GUIDE.md) — every feature, how to
  drive it and how it works underneath. The in-product short version is `/guide`.

---

## 0.7 Naming

**VARUNA** is the Vedic deity of the waters and the upholder of *ṛta* — cosmic order and
law. The name maps directly onto the product's purpose: applying order and accountability
to the sea. It also gives a clean backronym: **V**essel **A**ttribution through
**R**emote-sensing & **U**nified **N**avigational **A**nalytics.
