# VARUNA — Algorithms Specification & 52 Technical Judge Q&A Guide
**Vessel Attribution through Remote-Sensing & Unified Navigational Analytics**
*Smart India Hackathon 2026 — Problem Statement SIH26143*

---

# PART 1: COMPREHENSIVE ALGORITHMIC SPECIFICATION

This document details every mathematical, physical, statistical, and computational algorithm implemented in VARUNA across the machine learning, drift simulation, geospatial analytics, and attribution scoring pipelines.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                VARUNA ALGORITHMIC STACK                                  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
  1. SAR Image Processing & Deep Learning        2. Physical Drift & Kernel Estimation
  ├── SNAP Radiometric Calibration & Speckle     ├── 5,000-Particle Stochastic RK Stepper
  ├── 5-Class Semantic Segmentation (U-Net)      ├── ERA5 Wind & CMEMS Current Integration
  ├── Hybrid Dice + Focal Loss Function          ├── 2D Gaussian Kernel Density Surface
  └── Cosine Hann 2D Window Tiled Blending       └── Spatiotemporal Release Window Estimation
                                                 
  3. Spatial Analytics & Telemetry               4. Decision Science & Attribution
  ├── WGS84 Geodesic Morphometry (pyproj)        ├── 12-Feature Additive Evidence Scoring
  ├── Time-Series Telemetry Cleaning (Mongo)     ├── Renormalized Missing Feature Masking
  ├── Geodesic Interpolation & Track Repair      ├── 500-Iteration Paired Joint Bootstrap
  └── MongoDB 2dsphere / Turf.js Hybrid Geo      └── Monotonic Isotonic Score Calibration
```

---

## 1. SAR Preprocessing & Radar Calibration

### 1.1 Radiometric Calibration & Decibel Scaling
Synthetic Aperture Radar (SAR) sensors measure backscatter intensity in raw Digital Numbers (DN). To allow direct physical comparison across different satellite orbits and viewing angles, raw intensity is calibrated into the radar backscatter coefficient ($\sigma^0$):

$$\text{Intensity } \sigma^0 = \frac{\text{DN}^2}{\text{Calibration Constant } K} \cdot \sin(\text{Incidence Angle } \theta)$$

Radar intensity values span several orders of magnitude. They are converted into decibels ($\text{dB}$) to transform raw values into a smooth bell-curve distribution ideal for deep learning models:

$$\text{Intensity in dB} = 10 \cdot \log_{10}(\sigma^0 + 10^{-7})$$

*(Note: Adding $10^{-7}$ prevents mathematical errors when calculating logarithms over acoustic shadows or zero-padded ocean regions).*

### 1.2 Refined Lee Speckle Filtering
Radar images suffer from multiplicative noise called "speckle" caused by wave interference. Instead of using standard smoothing filters that blur oil slick borders, VARUNA uses a spatial **7x7 Refined Lee filter**. This filter calculates local image variance and applies directional gradient masks to smooth ocean noise while preserving sharp boundaries between oil slicks and open water:

$$\text{Filtered Pixel} = \text{Local Mean} + W \cdot (\text{Raw Pixel} - \text{Local Mean})$$

where $W$ is a weighting factor derived from local variance and sensor noise statistics.

---

## 2. Multi-Class Semantic Segmentation & Neural Inference (Model M1)

### 2.1 3-Channel Input Normalization
Input SAR satellite images are organized into a 3-channel dual-polarization tensor:
* **Channel 1:** $\text{VV}$ polarization (in decibels) — captures main ocean surface contrast.
* **Channel 2:** $\text{VH}$ polarization (in decibels) — cross-polarization, helps separate look-alikes.
* **Channel 3:** Polarization Difference ($\text{VV} - \text{VH}$) — log ratio, enhances structural boundary contrast.

To prevent bright metal ships from compressing dynamic contrast, each scene is normalized using robust scaling between its **2nd and 98th percentiles**:

$$\text{Scaled Channel} = \frac{\text{Channel} - \text{Percentile}_2}{\text{Percentile}_{98} - \text{Percentile}_2}$$

Values are then clipped safely between $0.0$ and $1.0$.

### 2.2 Hybrid Dice + Focal Loss Function
Oil pixels typically occupy less than $2\%$ of a satellite scene. Plain cross-entropy loss causes networks to predict "sea" everywhere, claiming 98% accuracy while missing all slicks. VARUNA trains its deep learning models (U-Net, SegFormer) using a composite loss function:

$$\text{Total Loss} = 0.5 \cdot \text{Dice Loss} + 0.5 \cdot \text{Focal Loss}$$

* **Dice Loss:** Measures direct spatial polygon overlap (Intersection over Union) to optimize slick shapes.
* **Focal Loss:** Automatically down-weights easy background ocean pixels so model gradients focus heavily on difficult oil vs look-alike boundaries.

### 2.3 Cosine-Window 2D Hann Tiled Inference Blending
Running deep learning models on large satellite scenes by splitting them into plain square patches creates ugly grid seam artifacts along tile edges. VARUNA runs inference using a $256 \times 256$ sliding window with 25% overlap ($192\text{ px}$ stride) and weights overlapping predictions using a **2D Hann Cosine Window**:

$$w(x, y) = \sin^2\left(\frac{\pi x}{256}\right) \cdot \sin^2\left(\frac{\pi y}{256}\right)$$

Pixels near tile centers are given full weight, while edge pixels fade out smoothly, creating seamless probability maps across entire satellite scenes.

---

## 3. Geodesic Morphometry & Priority Triage

### 3.1 Geodesic WGS84 Area & Perimeter
Measuring geographical shapes on flat latitude/longitude grids causes severe size distortions near the poles. VARUNA uses `pyproj.Geod` over the WGS84 ellipsoid model of Earth to compute true surface area in square kilometers:

$$\text{Area in km}^2 = \frac{\left| \text{Geodesic Surface Area in meters}^2 \right|}{1,000,000}$$

### 3.2 Minimum Bounding Rectangle & Axis Morphometry
Oil slicks discharged by moving vessels are long and linear, whereas natural seeps or platforms create rounder blobs. Using Shapely, VARUNA fits a minimum rotated bounding rectangle around each slick to extract:
* **Major Axis Length ($L$):** Slick length along its main direction (in km).
* **Minor Axis Length ($W$):** Slick width perpendicular to main direction (in km).
* **Elongation Ratio:** $L / W$ (values above $2.5$ indicate vessel discharge).
* **Orientation Angle ($\theta$):** Compass bearing of the major axis ($0^\circ$ to $180^\circ$).

### 3.3 Physics-Based Wind Suitability Gate
Radar contrast for oil spills requires moderate wind. VARUNA checks real ERA5 surface wind speed ($u_{10}$) at the time of satellite acquisition:
* **Wind < 1.5 m/s:** Sea is too calm and smooth; background is dark. Oil cannot be distinguished.
* **Wind 3.0 to 10.0 m/s:** Optimal physics window; clear radar contrast.
* **Wind > 14.0 m/s:** Wind waves mix oil into the ocean column, destroying contrast.

A suitability factor $S_{\text{wind}}$ is calculated. Detections made in bad wind conditions are automatically flagged as low-reliability regardless of neural confidence.

### 3.4 Queue Triage Priority Score
To help analysts review the most urgent cases first without auto-confirming unreviewed data:

$$\text{Triage Score} = 0.45 \cdot \text{Significance}(\text{Area}) + 0.35 \cdot \text{Interpretability}(\text{dB}) + 0.20 \cdot \text{Attributability}(\text{Elongation})$$

---

## 4. Backward Drift Simulation (Model M2)

### 4.1 Particle Transport Equations
VARUNA advects **5,000 virtual drift particles** backward in time ($t \to t - \Delta t$) starting from random points inside the detected oil slick. Movement is calculated using a 2nd-order Runge-Kutta (RK2) numerical integration scheme:

$$\text{Total Particle Velocity} = \text{Ocean Current Velocity} + (\text{Wind Leeway Factor} \times \text{Rotated Wind Velocity}) + \text{Turbulent Diffusion}$$

Where:
* **Ocean Current Velocity:** Interpolated 3D ocean velocity vectors from CMEMS ($1/12^\circ$ resolution).
* **Wind Velocity:** Surface wind vectors from ERA5 ($0.25^\circ$ resolution).
* **Wind Leeway Factor ($\alpha$):** Randomly sampled between $2\%$ and $4\%$ ($0.02$ to $0.04$) per particle.
* **Ekman Deflection Angle ($\theta$):** Randomly sampled between $0^\circ$ and $20^\circ$ to simulate surface current angle deflection.
* **Turbulent Diffusion:** Random-walk noise weighted by horizontal diffusivity $D_h = 10\text{ m}^2/\text{s}$.

### 4.2 2D Gaussian Kernel Density Estimation (KDE)
At each backward time step, continuous spatial probability density is generated from particle positions using 2D Gaussian Kernel Density Estimation. The resulting surface is contoured into **50% (`support50`)** and **90% (`support90`)** probability origin polygons.

---

## 5. AIS Telemetry Reconstruction & Track Repair

### 5.1 AIS Outlier Scrubbing
Raw AIS telemetry broadcasts are cleaned prior to analysis:
1. **Invalid Sentinels:** Records with invalid indicators (Speed $= 102.3\text{ knots}$, Course $= 360^\circ$, Heading $= 511^\circ$) are removed.
2. **Speed Outlier Rejection:** Consecutive fixes requiring implied speeds over $45\text{ knots}$ are split as position jumps.
3. **Gap Splitting:** Reporting gaps over $20\text{ minutes}$ split vessel paths into separate track segments.

### 5.2 Geodesic Track Interpolation
To evaluate vessel location at an exact estimated release timestamp $t$, spherical linear interpolation (Slerp) along the geodesic path is computed between adjacent valid AIS fixes.

---

## 6. 12-Feature Vessel Attribution & Rank Separation (Model M3)

### 6.1 Feature Formulation & Scoring Formula
The raw attribution score combines 12 normalized evidence features ($n_i$, values from $0$ to $1$) multiplied by expert weights ($w_i$):

$$\text{Raw Score} = \frac{\text{Sum of (Weight}_i \times \text{Normalized Value}_i\text{) for Measured Features}}{\text{Sum of Weights for Measured Features}}$$

| ID | Feature Name | How It Is Measured | Weight |
|---|---|---|---|
| **F1** | Spatial Proximity | Geodesic distance from track to 90% origin polygon: $\exp(-\text{distance} / 8.0\text{ km})$ | **0.18** |
| **F2** | Temporal Alignment | Overlap fraction between vessel presence and estimated release window | **0.16** |
| **F3** | Track Intersection | Distance vessel traveled inside 50% origin polygon (capped at 5 km) | **0.13** |
| **F4** | Heading Alignment | Alignment between vessel course and slick major axis angle ($\cos^2 \Delta \theta$) | **0.10** |
| **F5** | AIS Dark Period | Duration of transponder silence during origin zone transit (up to 90 min) | **0.08** |
| **F6** | Vessel Type Risk | Static risk weighting by ship type (Oil Tankers: 1.0, Cargo: 0.8, Ferries: 0.4) | **0.08** |
| **F7** | Dark Period Anomaly | Comparison of AIS gap length against vessel's historical baseline | **0.08** |
| **F8** | Speed Consistency | Checks if vessel speed was in typical transit discharge range ($4–14\text{ knots}$) | **0.06** |
| **F9** | Vessel Type Prior | Static historical risk profile | **0.04** |
| **F10** | Origin Density at Track | Origin surface probability density sampled directly along vessel track | **0.04** |
| **F11** | Draught Change | Change in reported vessel draft depth before vs after window transit | **0.02** |
| **F12** | Slick Axis Continuity | Distance from extended slick axis line to vessel track | **< 0.02** |

*Note on Missing Data:* Dividing **only by measured feature weights** prevents missing AIS records from penalizing or falsely exonerating a vessel. If fewer than 6 features can be measured, the vessel is marked `INSUFFICIENT_EVIDENCE`.

### 6.2 Paired Joint Bootstrap Resampling for Lead Separation
To determine whether Candidate #1 is statistically ahead of Candidate #2, VARUNA executes **500 paired Monte Carlo simulation draws**:
* **Shared Drift Uncertainty:** Origin probability fields are perturbed jointly for all candidates per draw.
* **Independent Vessel Uncertainty:** Positional interpolation noise is drawn independently per candidate.
* **Win Share Metric:**
  $$\text{winShare} = \frac{\text{Number of draws where Candidate 1 scores higher than Candidate 2}}{500}$$

Candidate #1 is declared **statistically distinguishable** if $\text{winShare} \ge 0.90$ (90% or higher).

---

# PART 2: 52 TECHNICAL JUDGE QUESTIONS & ANSWERS

---

### Category A: Satellite Imaging, SAR Physics & Deep Learning (Q1–Q12)

#### Q1: Why did you choose Sentinel-1 C-band SAR instead of optical imagery like Sentinel-2?
**Answer:** Optical sensors (Sentinel-2) cannot penetrate cloud cover and cannot acquire imagery at night. Marine oil spills frequently occur in stormy weather or dark cover. Sentinel-1 C-band SAR radar operates 24/7 in all weather. Oil slicks damp short ocean surface waves, reducing radar backscatter and causing oil spills to appear as clear dark patches.

#### Q2: How do you handle radar speckle noise without blurring slick edges?
**Answer:** Standard smoothing filters blur slick boundaries, corrupting surface area calculations. We use a 7x7 Refined Lee filter. It calculates local image variance and applies directional gradient masks to smooth ocean noise while preserving sharp boundaries between oil slicks and open water.

#### Q3: Why is a simple binary (oil vs not-oil) classifier insufficient for real deployment?
**Answer:** Low-wind zones (<3 m/s), natural biogenic algal films, rain cells, and internal ocean waves produce dark radar patches identical to mineral oil. A binary classifier labels all dark patches as false positives. We enforce a 5-class schema (`sea_surface`, `oil_spill`, `look_alike`, `ship`, `land`), forcing the neural network to learn subtle spatial texture patterns.

#### Q4: What is your neural network loss function, and why does cross-entropy alone fail?
**Answer:** Oil pixels make up under 2% of a satellite scene. Plain cross-entropy loss causes models to predict "sea" everywhere, reaching 98% accuracy while missing all spills. We use a hybrid loss combining 50% Dice Loss (which directly optimizes spatial polygon overlap) and 50% Focal Loss (which suppresses easy background ocean pixels so gradients focus on difficult oil boundaries).

#### Q5: How do you eliminate seam artifacts when processing large satellite scenes?
**Answer:** We process scenes in $256 \times 256$ tiles with 25% overlap. Overlapping predictions are blended using a 2D Hann cosine window function, giving highest weight to center pixels and fading edge pixels smoothly. This eliminates tile grid lines.

#### Q6: How does wind speed affect SAR oil detection, and how do you encode this physics?
**Answer:** At wind speeds under 1.5 m/s, the sea is completely smooth and dark, making oil invisible. At wind speeds over 14 m/s, turbulence mixes oil into the water column, destroying radar contrast. We calculate a wind suitability factor from ERA5 wind data; detections made in bad wind conditions are automatically marked as low reliability.

#### Q7: Why do you compute image scaling parameters per scene rather than globally?
**Answer:** Global scaling fails across different satellite viewing angles, ocean states, and regions. We scale each scene using its own 2nd and 98th percentile brightness values over ocean pixels. This also prevents bright metal ships from distorting contrast.

#### Q8: How do you convert probability maps into GIS polygons?
**Answer:** Probability rasters are thresholded at 60%, cleaned with morphological filters (opening to remove stray dots, closing to fill holes), polygonized using OpenCV, reprojected into WGS84 coordinates, and simplified with a 20-meter tolerance.

#### Q9: What is the significance of slick shape (elongation and orientation)?
**Answer:** Slick shape reveals vessel motion. Oil dumped by a moving ship creates a long, linear slick whose orientation angle matches the vessel's heading. A spill from a stationary platform or seep creates a round blob. We extract major and minor axis lengths and elongation ratios using minimum bounding rectangles.

#### Q10: How do you handle dark land or coastline errors that look like oil spills?
**Answer:** Land masks based on static maps often fail due to tides. We include `land` as an explicit class in our 5-class model, allowing the network to recognize wet land, tidal flats, and coastal structures directly.

#### Q11: What deep learning architectures were tested, and which performed best?
**Answer:** We evaluated U-Net (ResNet-34), U-Net++ (ResNet-34), DeepLabV3+ (ResNet-50), and SegFormer-B2 on a held-out split of 66 real Sentinel-1 scenes. U-Net (ResNet-34) achieved the best balance of accuracy and speed, with an oil Mean IoU of 0.637 and a Dice score of 0.738.

#### Q12: Why are synthetic data augmentations (GANs, diffusion) forbidden in your project?
**Answer:** Generative AI models introduce artificial boundary patterns that deep neural networks memorize. This inflates test scores while failing on real ocean satellite data. Under our Real Data Policy, data augmentation is strictly limited to geometric flips, rotations, and minor brightness adjustments of real Sentinel-1 acquisitions.

---

### Category B: Drift Modelling & Oceanographic Physics (Q13–Q22)

#### Q13: What mathematical model powers your backward drift simulation?
**Answer:** We use a 5,000-particle stochastic Lagrangian advection-diffusion model integrated backward in time using a 2nd-order Runge-Kutta (RK2) numerical scheme with 15-minute time steps.

#### Q14: How do you combine ocean currents and surface wind in drift calculations?
**Answer:** Particle velocity is calculated by combining 3D ocean velocity vectors from CMEMS ($1/12^\circ$ resolution) with surface wind vectors from ERA5 ($0.25^\circ$ resolution), applying a 2% to 4% wind leeway factor and a 0 to 20 degree Ekman deflection angle.

#### Q15: How do you model turbulent ocean diffusion?
**Answer:** Diffusion is modeled as a random-walk displacement term using a horizontal turbulent diffusivity value of $D_h = 10\text{ m}^2/\text{s}$.

#### Q16: How do you convert discrete drift particles into origin probability polygons?
**Answer:** At each backward step, particle positions are processed using 2D Gaussian Kernel Density Estimation (KDE) with Scott's Rule bandwidth selection. The density matrix is contoured into 50% (`support50`) and 90% (`support90`) probability polygons.

#### Q17: How is the release-time window estimated from a slick?
**Answer:** Elapsed release time is calculated by dividing the slick's major axis length by the median particle drift speed. The release window spans from 1.5 times to 0.4 times this estimated elapsed time prior to image acquisition.

#### Q18: What happens when ocean current API data is unavailable?
**Answer:** The system enters `DEGRADED` mode and falls back to `FOOTPRINT_PROXIMITY`, creating a 40 km buffer around the slick footprint. The UI displays a degradation banner, and score confidence intervals widen.

#### Q19: What happens when wind data is missing?
**Answer:** The drift model runs using ocean currents only (setting wind drift to zero). The result is marked `DEGRADED`, and the final report explicitly notes that wind drift was omitted.

#### Q20: Why do you sample wind leeway as a range (2% to 4%) instead of a fixed number?
**Answer:** Oil leeway varies with oil viscosity, weathering, and slick thickness, which cannot be measured from satellite images alone. Sampling leeway between 2% and 4% across 5,000 particles captures physical uncertainty accurately.

#### Q21: Why do you use Runge-Kutta 2nd-order (RK2) integration instead of simple Euler steps?
**Answer:** Simple Euler integration accumulates numerical errors over long 72-hour drift runs, causing particles to drift off ocean current streamlines. RK2 evaluates midpoint velocities, achieving higher accuracy ($O(dt^2)$) with minimal computational load.

#### Q22: Can your drift model run forward in time?
**Answer:** Yes. Reversing the time step direction projects future oil slick movement to support emergency response and spill containment planning.

---

### Category C: Telemetry, Geodesy & Database Architecture (Q23–Q31)

#### Q23: Why did you use MongoDB instead of PostgreSQL + PostGIS?
**Answer:** The project mandate specified a MERN stack. MongoDB 7 provides native GeoJSON support, 2dsphere spatial indexing, and optimized time-series collections (`ais_positions`) required to ingest millions of vessel position broadcasts.

#### Q24: How do you compensate for MongoDB's lack of native PostGIS spatial functions?
**Answer:** We use a hybrid compensation architecture: MongoDB performs fast spatial filtering (`$geoWithin`, `$geoIntersects`), while exact geographic operations (buffering, polygon-to-line distances, geodesic area) are computed in Turf.js (Node.js) or Shapely/pyproj (Python) and persisted back to MongoDB as indexed GeoJSON.

#### Q25: How is your `ais_positions` collection structured in MongoDB?
**Answer:** `ais_positions` is configured as a time-series collection with `timeField: 't'`, `metaField: 'meta'`, and `granularity: 'seconds'`. Compound indexes on `{'meta.mmsi': 1, t: 1}` and `position: '2dsphere'` deliver fast range queries.

#### Q26: How do you filter corrupt or invalid AIS records?
**Answer:** The telemetry parser strips invalid sentinel values (Speed $= 102.3\text{ knots}$, Course $= 360^\circ$, Heading $= 511^\circ$) and drops position updates requiring speeds over $45\text{ knots}$.

#### Q27: How do you handle gaps in AIS vessel broadcasts?
**Answer:** If elapsed time between updates exceeds 20 minutes, the track is split into separate segments. Gaps overlapping the estimated release window are flagged as `AIS_GAP` and evaluated by feature $F_5$ (`ais_dark_period`).

#### Q28: How do you interpolate vessel positions along tracks?
**Answer:** We compute spherical linear interpolation (Slerp) along geodesic arcs between adjacent valid AIS fixes to estimate vessel coordinates at exact timestamps.

#### Q29: What spatial index type is used in MongoDB?
**Answer:** We use `2dsphere` spatial indexes, which calculate geometry over the WGS84 reference ellipsoid to accelerate `$geoWithin` and `$geoIntersects` queries.

#### Q30: How do you calculate distance from a vessel track to an origin polygon?
**Answer:** MongoDB `$geoNear` only measures distance to point centroids. We pull candidate tracks into Node.js and use Turf.js `turf.pointToLineDistance` to compute true minimum geodesic distance from the track line to the polygon border.

#### Q31: How do you archive historical AIS telemetry when data grows very large?
**Answer:** Telemetry older than 24 months is archived to compressed Parquet files in Cloudflare R2 object storage, with metadata cataloged in `provenance_records` for full auditability.

---

### Category D: Attribution Scoring, Paired Bootstrap & Uncertainty (Q32–Q41)

#### Q32: Why is your attribution model (Model M3) an additive model rather than a Deep Neural Network?
**Answer:** Legal investigation evidence requires total transparency. Black-box neural outputs cannot survive courtroom cross-examination. Additive scoring provides explicit feature contribution breakdowns and traceable evidence sources. Furthermore, validated vessel discharge incidents are scarce (dozens, not millions), making deep models prone to overfitting.

#### Q33: How do you handle missing features during vessel candidate scoring?
**Answer:** Missing features are excluded from both numerator and denominator in the scoring equation:
$$\text{Raw Score} = \frac{\text{Sum of (Weight} \times \text{Value) for Measured Features}}{\text{Sum of Weights for Measured Features}}$$
This prevents missing data from acting as false exonerating evidence. If fewer than 6 features are measured, the vessel is assigned tier `INSUFFICIENT_EVIDENCE`.

#### Q34: What is the purpose of Paired Joint Bootstrap Resampling in `separation.ts`?
**Answer:** Standard confidence intervals treat vessel errors independently, ignoring shared origin drift uncertainty. `separation.ts` runs 500 joint Monte Carlo iterations, perturbing origin surfaces jointly across all candidates per draw to calculate $\text{winShare} = P(\text{Rank}_1 = 1)$.

#### Q35: What threshold defines a statistically distinguishable lead candidate?
**Answer:** A lead candidate is declared statistically distinguishable if its `winShare` is 90% or higher ($\ge 0.90$) across 500 paired Monte Carlo draws.

#### Q36: What are the four attribution tiers, and how are they defined?
**Answer:**
1. `STRONG`: Score $\ge 70$, $\ge 6$ measured features.
2. `MODERATE`: Score $50–69$, $\ge 6$ measured features.
3. `WEAK`: Score $30–49$, $\ge 6$ measured features.
4. `INSUFFICIENT_EVIDENCE`: Score $<30$ OR $<6$ measured features.

#### Q37: How does feature F4 (`heading_alignment`) correlate slick geometry with vessel tracks?
**Answer:** $F_4$ measures $\cos^2(\Delta \theta)$ between vessel course and slick major axis. Moving discharge creates linear slicks aligned with vessel heading. $F_4$ is evaluated only when slick elongation ratio $\ge 2.5$; for circular slicks, it returns `NOT_APPLICABLE`.

#### Q38: How does feature F5 (`ais_dark_period`) treat transponder silence?
**Answer:** Vessels discharging oily waste intentionally turn off AIS transponders. $F_5$ measures the duration of transponder silence within the origin zone, treating dark periods as positive investigative evidence rather than missing data.

#### Q39: How is raw attribution score calibrated into a probability?
**Answer:** When $\ge 30$ validated incident records exist, an `IsotonicRegression` model fits raw scores to observed historical discharge rates. Isotonic regression guarantees monotonicity: higher evidence scores never yield lower calibrated probabilities.

#### Q40: What happens if fewer than 30 validated historical incidents exist for calibration?
**Answer:** The system outputs raw scores and marks them as `UNCALIBRATED` in the UI and exported PDF reports, preventing uncalibrated priors from masquerading as learned probabilities.

#### Q41: How does feature F1 (`spatial_proximity`) scale distance to origin?
**Answer:** Minimum geodesic distance $d_{\text{min}}$ (in km) to the 90% origin polygon is normalized using exponential decay: $\exp(-d_{\text{min}} / 8.0)$. Plausibility drops off exponentially with distance.

---

### Category E: Architecture, Security & Production Engineering (Q42–Q52)

#### Q42: How is Role-Based Access Control (RBAC) enforced in your API?
**Answer:** Access control is enforced via Express middleware using a deny-by-default model. `authenticate()` populates user data from JWT cookies, and `rbac(minRole)` validates role rank: $\text{viewer (0)} < \text{analyst (1)} < \text{lead (2)} < \text{admin (3)}$.

#### Q43: Why does your API return HTTP 404 instead of HTTP 403 on unauthorized investigation access?
**Answer:** Returning HTTP 403 confirms to an unprivileged user that an investigation ID exists. Returning HTTP 404 prevents investigation ID enumeration attacks.

#### Q44: How does the system generate PDF evidence reports without visual divergence from the web app?
**Answer:** PDF reports are generated by launching headless Playwright browser instances that render the web application's dedicated report route. This ensures typography, maps, and evidence charts match the UI exactly.

#### Q45: How are Playwright PDF generation sessions authenticated securely?
**Answer:** The API issues a short-lived `varuna_report` JWT token cookie scoped strictly to the target investigation ID (`reportScopeGuard`). The role is pinned to `viewer`, preventing privilege escalation.

#### Q46: How does `provenanceGuard.ts` enforce your zero fake data policy?
**Answer:** `provenanceGuard` intercepts Express `res.json()` responses mid-flight. If a payload lacks a valid `provenance` metadata block or references mock data tags, it returns an HTTP 500 error in production.

#### Q47: How are asynchronous background jobs handled?
**Answer:** BullMQ task queues backed by Redis process background jobs (`ingest`, `inference`, `drift`, `scoring`, `report`). Workers process jobs concurrently with automatic retries and exponential backoff.

#### Q48: How does the frontend handle high-frequency map updates without lagging?
**Answer:** Viewport and layer states are managed in Zustand using `subscribeWithSelector`. Map updates bypass React component re-renders, updating deck.gl WebGL layers directly.

#### Q49: How do you prevent MongoDB injection attacks?
**Answer:** All incoming Express requests pass through `sanitizeMongo()` middleware, which strips characters starting with `$` or containing `.` from request parameters, body, and query strings.

#### Q50: How do you maintain API document synchronization with the codebase?
**Answer:** The OpenAPI 3.1 specification is auto-generated from Zod schemas using `zod-to-openapi`. Running `npm run check:openapi` in CI ensures the spec matches route definitions.

#### Q51: How do you prevent CORS vulnerabilities?
**Answer:** Express uses `cors({ origin: env.PUBLIC_APP_URL, credentials: true })`, restricting API requests to explicitly configured client domains.

#### Q52: What security measures protect against XSS and clickjacking?
**Answer:** Helmet middleware applies strict HTTP security headers, including Content Security Policy (CSP), `X-Frame-Options: DENY`, and `X-Content-Type-Options: nosniff`.

---
*Document generated for VARUNA SIH26143 Hackathon Documentation Suite.*
