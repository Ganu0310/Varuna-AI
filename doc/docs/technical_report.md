# VARUNA — Comprehensive Technical Report
**Vessel Attribution through Remote-Sensing & Unified Navigational Analytics**
*Smart India Hackathon 2026 — Problem Statement SIH26143*

---

## 1. Executive Overview & System Purpose

**VARUNA** is a maritime environmental investigation platform built to solve vessel attribution for marine oil spill incidents. By combining Sentinel-1 Synthetic Aperture Radar (SAR) imagery, Automatic Identification System (AIS) vessel telemetry, and ERA5/CMEMS oceanographic weather and current data, VARUNA detects oil slicks, tracks them backward in time to their release point, and identifies candidate vessels that were in the area.

### Core Engineering Principles
1. **Transparent & Explainable Priority Scoring:** VARUNA outputs a clear investigative priority score backed by physics, geographic measurements, and statistical confidence intervals (5th to 95th percentiles).
2. **Zero Fake Data Policy:** Synthetic placeholders, GAN-generated SAR images, and simulated AIS tracks are strictly forbidden. Every single data point carries an immutable provenance record tracing back to its official public source.
3. **MongoDB-Turf/Shapely Hybrid Geodesy:** To deliver high performance within a MERN stack without PostGIS, VARUNA uses MongoDB's native 2dsphere indexes for fast spatial filtering, while exact geographic measurements (WGS84 distance, area, buffers) are calculated in Turf.js (Node.js) and Shapely/pyproj (Python).

---

## 2. Technology Stack & Architectural Rationale

| Layer | Primary Technology | Why This Choice & Rationale |
|---|---|---|
| **Frontend Framework** | **React 18 + Vite 6** | Mandated by MERN. React 18 Concurrent Rendering keeps map controls smooth during background data loads. Vite provides instant development updates. |
| **Frontend Language** | **TypeScript 5.7** | Prevents coordinate inversion errors (such as swapping longitude and latitude) at compile time via strong typing. |
| **Map & Visualization** | **MapLibre GL JS + deck.gl** | MapLibre renders open WebGL maps without paid API tokens. deck.gl uses GPU acceleration to display over 1 million vessel position points and animated tracks smoothly at 60 FPS. |
| **3D Engine** | **React Three Fiber (Three.js)** | Renders global 3D interactive globes and elevation relief views for oil slicks. |
| **State Management** | **Zustand + TanStack Query** | TanStack Query caches server data and prevents duplicate requests. Zustand handles high-frequency map viewport state without triggering unnecessary re-renders. |
| **Backend API** | **Node.js 20 + Express 5** | Express 5 natively catches asynchronous errors, preventing server crashes. |
| **Database** | **MongoDB Atlas 7** | Mandated by MERN. Native GeoJSON support, 2dsphere spatial indexing, and optimized time-series collections for high-volume AIS telemetry. |
| **ML & Geospatial Engine** | **Python 3.11 + FastAPI** | Essential for scientific computing. Python hosts PyTorch deep learning models, raster image tools (rasterio/GDAL), and spatial math libraries (Shapely/pyproj). |
| **Deep Learning** | **PyTorch 2.4** | Powers 5-class semantic segmentation models (U-Net, SegFormer) to distinguish oil slicks from natural ocean dark spots. |
| **Task Queue & Cache** | **BullMQ + Redis 7** | Handles background processing (downloading satellite images, running deep learning models, calculating 5,000-particle drift simulations). |
| **Realtime Gateway** | **Socket.IO** | Pushes live job progress, stream updates, and multi-user collaboration via WebSockets. |
| **Object Storage** | **Cloudflare R2 / MinIO** | Stores satellite rasters, probability maps, and generated PDF reports with zero bandwidth egress fees. |

---

## 3. Access Control, Security & Authentication Architecture

Security in VARUNA follows a strict **deny-by-default Role-Based Access Control (RBAC)** model combined with resource ownership checks and real-data integrity verification.

```
       [ Client Request ]
               │
               ▼
┌──────────────────────────────┐
│  authenticate() Middleware   │  ── Extracts JWT access token from 'varuna_access' cookie
└──────────────┬───────────────┘  ── Or report token from 'varuna_report' cookie (scoped viewer)
               │
               ▼
┌──────────────────────────────┐
│     reportScopeGuard()       │  ── Confines report token sessions strictly to GET /investigations/:id
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│       rbac(minRole)          │  ── Deny-by-default role gate checking role rank
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ requireInvestigationAccess() │  ── Validates resource ownership (creator/member)
└──────────────┬───────────────┘  ── Returns 404 (Not Found) on unauthorized access to prevent enumeration
               │
               ▼
┌──────────────────────────────┐
│     provenanceGuard          │  ── Response interceptor ensuring every output object carries valid
└──────────────────────────────┘     non-synthetic provenance metadata
```

### 3.1 Authentication
* **User Sessions:** Managed via HTTP-only secure cookies (`varuna_access`). Tokens use stateless JWTs signed on the backend, with passwords hashed using **Argon2id**.
* **Headless Report Tokens (`varuna_report`):** Short-lived tokens issued to background PDF generation workers. These are strictly locked to `viewer` permissions to prevent privilege escalation.

### 3.2 Role Hierarchy
1. **`viewer` (Rank 0):** Read-only access to published cases, maps, candidate rankings, and exported reports.
2. **`analyst` (Rank 1):** Create/edit investigations, upload data, run deep learning models, review detections (confirm or reject with reason tags), and run drift simulations.
3. **`lead` (Rank 2):** Add/remove team members, adjust evidence scoring weights, and lock approved reports.
4. **`admin` (Rank 3):** Full system management, user management, audit logs, and system metrics.

### 3.3 Protection Mechanisms
* **Anti-Enumeration (404 Responses):** When a user tries to open an investigation they do not have permission to view, the server returns **404 Not Found** instead of 403 Forbidden. This prevents unauthorized users from probing for valid case IDs.
* **Real Data Guard (`provenanceGuard.ts`):** Intercepts API responses before sending them to the client. If any data object lacks valid provenance metadata or contains mock/fake data flags, the request is automatically blocked with an HTTP 500 error in production.

---

## 4. End-to-End System Workflow

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                VARUNA PIPELINE WORKFLOW                                 │
└─────────────────────────────────────────────────────────────────────────────────────────┘
   1. Satellite Scene Ingestion           2. Deep Learning Segmentation (Model M1)
   ┌───────────────────────────────┐     ┌───────────────────────────────────┐
   │ Sentinel-1 SAR Radar Scene    │ ──► │ 5-Class Deep Neural Network       │
   │ Noise Removal & Calibration   │     │ Tiled Cosine Window Blending      │
   └───────────────────────────────┘     └─────────────────┬─────────────────┘
                                                           │
   4. AIS Telemetry & Track Builder       3. Vectorisation & Triage
   ┌───────────────────────────────┐     ┌───────────────────────────────────┐
   │ Mongo Time-Series Database    │ ──► │ Geodesic Area (WGS84 Ellipsoid)   │
   │ Speed Outlier Cleaning        │     │ Priority Review Queue Ordering    │
   └──────────────┬────────────────┘     └─────────────────┬─────────────────┘
                  │                                        │
                  └──────────────────┐ ┌───────────────────┘
                                     ▼ ▼
                          5. Backward Drift Simulation (Model M2)
                          ┌───────────────────────────────────┐
                          │ 5,000-Particle Stochastic Model   │
                          │ ERA5 Wind + CMEMS Ocean Current   │
                          │ 2D Kernel Density Origin Zone     │
                          └─────────────────┬─────────────────┘
                                            │
                                            ▼
                          6. Vessel Attribution Scoring (Model M3)
                          ┌───────────────────────────────────┐
                          │ 12-Feature Evidence Model         │
                          │ Paired Joint Bootstrap (Rank)     │
                          │ Evidence Dossier & Report Export  │
                          └───────────────────────────────────┘
```

---

## 5. Feature Deep Dive & Execution Summary

### Feature 1: Satellite Scene Ingestion & Radar Preprocessing
* **Purpose:** Downloads and prepares raw Sentinel-1 Synthetic Aperture Radar (SAR) imagery over the investigation area.
* **Provider Order:** Copernicus Data Space Ecosystem (CDSE) -> Microsoft Planetary Computer -> Alaska Satellite Facility.
* **Key Steps:**
  1. *Orbit Correction:* Applies precise satellite orbit files to fix positioning errors from 30 meters down to under 1 meter.
  2. *Noise Removal:* Removes sensor noise in dark ocean regions and cleans up border edge artifacts.
  3. *Calibration & dB Conversion:* Converts raw radar energy numbers into physical backscatter intensity ($\sigma^0$) and scales it to decibels ($\text{dB} = 10 \cdot \log_{10}(\sigma^0)$) for linear processing.
  4. *Speckle Filter:* Applies a 7x7 Refined Lee filter to smooth out ocean noise while keeping sharp edges on oil slick borders.
  5. *Cloud-Optimized GeoTIFF (COG):* Stores processed scenes as COGs for fast web tile rendering.

---

### Feature 2: Deep Learning Oil Slick Segmentation (Model M1)
* **Purpose:** Analyzes radar images to separate real mineral oil spills from natural look-alikes (such as algae or low-wind calm ocean spots).
* **5-Class Schema:** `0: sea_surface`, `1: oil_spill`, `2: look_alike`, `3: ship`, `4: land`.
* **How It Works:**
  * Uses a deep neural network (U-Net with ResNet-34 backbone) trained on real Sentinel-1 imagery.
  * Processes images in $256 \times 256$ tiles with 25% overlap, using a smooth 2D Hann cosine window to blend edges together seamlessly without grid line artifacts.
  * Uses a custom loss function combining Dice Loss (for shape overlap) and Focal Loss (to focus on small oil spills in large oceans).

---

### Feature 3: Polygon Vectorisation & Priority Triage
* **Purpose:** Converts neural network output pixels into GIS polygons and orders them in the analyst review queue.
* **How It Works:**
  * Applies morphological opening and closing filters to remove stray noise dots and fill wave-induced holes inside slicks.
  * Calculates real geodesic surface area on the WGS84 ellipsoid (in square kilometers) using `pyproj.Geod`.
  * Computes slick shape features (length, width, elongation ratio, and orientation angle).
  * Applies a **Physics Wind Suitability Gate**: Checks real wind speed from ERA5 data. If wind is under 1.5 m/s (sea is too calm) or over 14 m/s (sea is too rough), the detection is flagged as low reliability because physics prevents clear radar contrast.
  * Calculates a **Queue Triage Score** (combining Area, Contrast, and Shape Elongation) to place the most urgent detections at the top of the analyst's queue.

---

### Feature 4: Backward Drift Simulation (Model M2)
* **Purpose:** Reconstructs where an oil slick originated and estimates when the spill occurred.
* **How It Works:**
  * Releases **5,000 virtual particles** across the detected slick polygon.
  * Simulates particle transport **backward in time** in 15-minute time steps using a 2nd-order Runge-Kutta numerical integration scheme.
  * Combines 3D ocean currents (from CMEMS) and surface wind vector drift (from ERA5) with a 2% to 4% wind leeway factor and 0 to 20 degree Ekman current deflection.
  * Applies a 2D Gaussian Kernel Density Estimation (KDE) algorithm to generate continuous probability surfaces, creating 50% and 90% origin confidence polygons (`support50` and `support90`).
  * Estimates the **release time window** by dividing the slick's major axis length by the median drift speed.

---

### Feature 5: AIS Telemetry Ingestion & Track Reconstruction
* **Purpose:** Cleans raw vessel position broadcasts and reconstructs vessel tracks around the estimated release window.
* **How It Works:**
  * Stores telemetry in MongoDB time-series collections indexed by vessel MMSI and timestamp.
  * Cleans bad data: Removes invalid positions (such as zero coordinates or impossible speeds over 45 knots).
  * Splits tracks into separate segments whenever a vessel stops broadcasting AIS for more than 20 minutes.
  * Performs spherical linear interpolation along geodesic arcs to estimate exact vessel coordinates at any given timestamp.

---

### Feature 6: 12-Feature Vessel Attribution Scoring (Model M3)
* **Purpose:** Evaluates every candidate vessel in the area and ranks them by investigative priority.
* **The 12 Evidence Features:**
  1. *Spatial Proximity:* Geodesic distance from vessel track to 90% origin polygon.
  2. *Temporal Alignment:* Overlap between vessel presence and the estimated release window.
  3. *Track Intersection:* Distance the vessel traveled inside the 50% origin zone.
  4. *Heading Alignment:* Alignment between vessel course and the slick's main axis angle.
  5. *AIS Dark Period:* Duration of transponder silence during window transit.
  6. *Vessel Type Risk:* Risk weighting based on ship type (e.g., oil tankers have higher prior risk than passenger ferries).
  7. *Dark Period Anomaly:* Comparison of AIS gap length against the vessel's normal baseline.
  8. *Speed Consistency:* Checks if vessel speed was in the typical 4–14 knot discharge range.
  9. *Vessel Type Prior:* Static historical risk profile.
  10. *Origin Density at Track:* Probability surface density sampled directly under the track.
  11. *Draught Change:* Change in reported draft depth before vs after transit.
  12. *Slick Axis Continuity:* Alignment of extended slick axis with vessel path.

* **Missing Feature Protection:** The scoring formula divides **only by the sum of weights of features actually measured**. If a vessel is missing AIS data, it is not artificially penalized or exonerated. Candidates with under 6 measured features are marked `INSUFFICIENT_EVIDENCE`.
* **Paired Joint Bootstrap Resampling:** Runs 500 Monte Carlo draws perturbing origin zone bounds and vessel positions together to calculate `winShare` (how often Candidate #1 remains #1 across uncertain origin draws). If `winShare` is 90% or higher, Candidate #1 is confirmed as statistically distinguishable from Candidate #2.
* **Attribution Tiers:** `STRONG` (Score >= 70), `MODERATE` (Score 50-69), `WEAK` (Score 30-49), and `INSUFFICIENT_EVIDENCE`.

---

## 6. Verification & Automated Testing
* Automated unit, integration, and end-to-end tests (`vitest`, `pytest`, `playwright`).
* Real-data policy enforcement script (`npm run check:real-data`) verifies zero mock data across the project.
* OpenAPI specification validator (`npm run check:openapi`) enforces contract synchronization between backend routes and documentation.

---
*Report compiled for VARUNA SIH26143 System Architecture Specification.*
