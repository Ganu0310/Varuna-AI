# VARUNA Prototype Architecture & Algorithm Guide
## How Every Function, Algorithm, and Decision Mechanism Works

This document provides a comprehensive, easy-to-understand explanation of the **VARUNA** prototype (*Vessel Attribution through Remote-sensing & Unified Navigational Analytics*, Problem Statement SIH26143). 

It details the end-to-end pipeline: from satellite image ingestion and dark-spot oil slick detection to backward drift tracking, AIS vessel track reconstruction, multi-feature scoring, and Monte Carlo rank separation.

---

## 1. System Overview & Architecture Flow

VARUNA attributes oil spill slicks observed in satellite imagery to specific marine vessels. The system operates through a **6-stage pipeline**:

```
[ 1. Satellite Ingestion ] ➔ [ 2. Dark-Spot Detection ] ➔ [ 3. Drift Back-tracking ]
                                                                      │
[ 6. Monte Carlo Verification ] ◄── [ 5. 12-Feature Attribution ] ◄── [ 4. AIS Track Reconstruction ]
```

---

## 2. Ingestion & Radiometry Processing

### 2.1 Windowed Satellite Ingestion (`ingest_scene`)
* **File Location:** [`services/ml/varuna_ml/ingest/preprocess.py`](file:///e:/SIH/services/ml/varuna_ml/ingest/preprocess.py)
* **What it does:** Fetches radar imagery for an Area of Interest (AOI) from Microsoft Planetary Computer without downloading full satellite swaths (~2 GB per scene down to ~15 MB).
* **Inputs:** `product_id` (Sentinel-1 RTC scene ID), `aoi` bounding box `(west, south, east, north)`.
* **Algorithms & Logic:**
  1. Queries STAC catalog for Sentinel-1 Radiometrically Terrain-Corrected (RTC) Cloud-Optimized GeoTIFFs (COG).
  2. Uses **GDAL HTTP Range Requests** to fetch only the GeoTIFF tiles covering the AOI.
  3. Translates array slices into local COGs using `rio_cogeo.cogeo.cog_translate` and uploads them to object storage (MinIO / S3).
* **Output:** `IngestResult` containing Cloud-Optimized GeoTIFF keys, coordinate system (UTM/WGS84), pixel size (10m), and provenance records.

### 2.2 User-Uploaded Scene Adoption (`adopt_upload` & `probe_radiometry`)
* **File Location:** [`services/ml/varuna_ml/ingest/adopt.py`](file:///e:/SIH/services/ml/varuna_ml/ingest/adopt.py)
* **What it does:** Inspects custom GeoTIFF files uploaded by operators to prevent invalid input processing.
* **Decision Rules (`probe_radiometry`):**
  * **Linear $\sigma_0$ (Valid):** Values $0 \le x \le 5$. Accepted directly for radar backscatter detection.
  * **Decibels dB (Rejected):** Values $< 0$ dB (e.g. $-25 \text{ to } -5$). Detector converts to dB internally; uploading dB imagery would cause double-logarithm corruption.
  * **Uncalibrated Digital Numbers (Rejected):** Values $> 5$ or 8-bit integers ($0-255$). Standard photos/quicklooks lack calibrated radar physics.

---

## 3. Dark-Spot (Oil Slick) Detection Engine

### 3.1 Linear Backscatter to Decibels (`to_db`)
* **File Location:** [`services/ml/varuna_ml/detect/darkspot.py`](file:///e:/SIH/services/ml/varuna_ml/detect/darkspot.py)
* **Formula:** 
  $$\text{dB} = 10 \cdot \log_{10}(\sigma_0)$$
* **Why:** Oil damps short capillary ocean waves, returning significantly less radar backscatter. Logarithmic scaling converts wide backscatter dynamic ranges into uniform linear decibel contrasts.

### 3.2 Hybrid Land Masking (`land_mask_from_backscatter` & `coastline_mask`)
* **File Location:** [`services/ml/varuna_ml/detect/landmask.py`](file:///e:/SIH/services/ml/varuna_ml/detect/landmask.py)
* **Problem Solved:** Land is generally bright ($>-8\text{ dB}$), but calm inland waters, wet asphalt, runways, and tidal flats appear dark and trigger false positives.
* **Algorithm:**
  1. **Backscatter Masking:** Flags pixels brightened by land/ships ($>-8\text{ dB}$), closed with morphological disk ($r=3$), and dilated ($r=5$).
  2. **Vector Coastline Masking:** Rasterizes Natural Earth 10m land polygons onto the scene grid.
  3. **Deliberate 500m Land Buffer:** Grows the land boundary outward by 500 meters. Excludes near-shore false positives while reporting the exact percentage of near-shore water omitted (`buffered_fraction`).
  4. **Union:** $Land_{\text{final}} = Land_{\text{backscatter}} \cup Land_{\text{vector}}$.

### 3.3 Adaptive Local Segmentation (`segment`)
* **File Location:** [`services/ml/varuna_ml/detect/darkspot.py`](file:///e:/SIH/services/ml/varuna_ml/detect/darkspot.py)
* **Algorithm:**
  1. Downsamples backscatter array by factor of 32 ($32 \times 32$ block grid).
  2. Applies a $9 \times 9$ median filter across the coarse grid to estimate sea surface background intensity ($bg$).
  3. Bilinearly interpolates $bg$ back to original resolution.
  4. Flags candidate pixels darker than local background by contrast threshold (default $3.0\text{ dB}$):
     $$\text{DarkPixel} = (db < bg - \text{contrast\_db})$$

### 3.4 Morphological Speckle Cleanup (`clean`)
* **Operations:**
  * **Morphological Opening** (disk $r=2$): Removes isolated SAR multiplicative speckle noise pixels.
  * **Morphological Closing** (disk $r=4$): Joins fragmented slick boundaries.
  * **Small Object Removal:** Filters features $< 500\text{ pixels}$ ($< 0.05\text{ km}^2$).

### 3.5 Look-Alike Risk & Physical Confidence (`look_alike_risk`, `wind_suitability`, `detect`)
* **Look-Alike Discriminators (`look_alike_risk`):**
  * **Elongation:** Slicks drawn out by wind/current shear are elongated; low-wind zones are round. $r_{\text{shape}} = \frac{1}{1 + \max(0, \text{elongation} - 1)}$.
  * **Convexity:** Real slicks have irregular boundaries (low convexity). $r_{\text{convex}} = \text{clip}\left(\frac{\text{convexity} - 0.75}{0.25}, 0, 1\right)$.
  * **Contrast:** Stronger decibel contrast favours oil over biogenic films. $r_{\text{contrast}} = \text{clip}\left(\frac{6.0 - \text{contrast}}{4.0}, 0, 1\right)$.
  * **Size:** Massive dark areas ($>40\text{ km}^2$) indicate weather fronts. $r_{\text{size}} = \text{clip}\left(\frac{\text{area} - 40}{60}, 0, 1\right)$.
  * **Total Risk:** 
    $$\text{Risk} = 0.35 \cdot r_{\text{shape}} + 0.25 \cdot r_{\text{convex}} + 0.25 \cdot r_{\text{contrast}} + 0.15 \cdot r_{\text{size}}$$
* **Wind Gate (`wind_suitability`):**
  * Below $3\text{ m/s}$: Sea is glassy (false detection zone, return 0.05 - 0.3).
  * $4\text{ to } 9\text{ m/s}$: Ideal SAR detection conditions (return 1.0).
  * Above $12\text{ m/s}$: Wind waves break up slicks (return 0.05).
* **Overall Detection Confidence:**
  $$\text{Confidence} = 0.40 \cdot \text{ContrastTerm} + 0.35 \cdot (1 - \text{Risk}) + 0.15 \cdot \text{WindTerm} + 0.10 \cdot \text{SizeTerm}$$

---

## 4. Backward Lagrangian Drift Simulation Engine

### 4.1 Particle Seeding (`seed_particles`)
* **File Location:** [`services/ml/varuna_ml/drift/backtrack.py`](file:///e:/SIH/services/ml/varuna_ml/drift/backtrack.py)
* **Logic:** Rejection-samples $N=5,000$ particles uniformly across the observed slick polygon geometry. Seeding uniformly rather than at the centroid prevents underestimating origin spatial extent.

### 4.2 Environmental Forcing & Coastal Cell Interpolation (`forcing.py`)
* **File Location:** [`services/ml/varuna_ml/drift/forcing.py`](file:///e:/SIH/services/ml/varuna_ml/drift/forcing.py)
* **Data Sources:** Real surface currents (CMEMS / HYCOM) & 10m wind fields (ERA5).
* **Bilinear Coastal Renormalization (`_bilinear`):** Ocean models mask land cells as `NaN`. Standard interpolation returns `NaN` if even one corner is land, which turns near-shore velocities to $0.00\text{ m/s}$ ("dead calm"). VARUNA renormalizes weights over finite (wet) corners only, accurately estimating near-shore currents.

### 4.3 Backward Lagrangian Stepping (`backtrack`)
* **Governing Equation (per particle $i$ at backwards step $-dt$):**
  $$\frac{dx}{dt} = u_{\text{current}} + \alpha_i \cdot R(\theta_i) \cdot u_{\text{wind}} + \text{RandomWalk}(K_h)$$
* **Parameter Sampling per Particle:**
  * **Wind Drift Factor $\alpha_i$:** Sampled uniformly $\alpha_i \sim U(0.02, 0.04)$ ($2-4\%$ of wind speed).
  * **Ekman Deflection Angle $\theta_i$:** Sampled uniformly $\theta_i \sim U(0^\circ, 20^\circ)$. Applied to the right in the Northern Hemisphere, left in Southern Hemisphere ($-\theta_i$).
  * **Horizontal Eddy Diffusivity $K_h$:** $10\text{ m}^2/\text{s}$, implemented as a random walk $\sigma = \sqrt{2 K_h dt}$.
* **Time Stepping:** Step size $-15\text{ minutes}$ backward over a 24-hour horizon.

### 4.4 Kernel Density Probability Surface & Contours (`kde.py`)
* **File Location:** [`services/ml/varuna_ml/drift/kde.py`](file:///e:/SIH/services/ml/varuna_ml/drift/kde.py)
* **Algorithm:**
  1. Computes 2D histogram of final particle locations.
  2. Applies Gaussian kernel smoothing with adaptive bandwidth based on particle cloud spread.
  3. **Cumulative Mass Contours:** Ranks grid cells by density and accumulates until reaching $50\%$ and $90\%$ total particle mass. Outlines these regions as EPSG:4326 GeoJSON polygons.

### 4.5 Release Window Estimation (`estimate_release_window`)
* **Logic:** Slicks stretch along their long axis due to drift shear.
  $$t_{\text{elapsed}} = \frac{\text{MajorAxisLength}}{\text{MedianDriftSpeed}}$$
  $$\text{Release Window} = [t_{\text{observation}} - 1.5 \cdot t_{\text{elapsed}}, \ t_{\text{observation}} - 0.4 \cdot t_{\text{elapsed}}]$$
* **Observational Hard Bound:** If an earlier clear satellite image exists for the region showing no slick, `earliest` is bounded by that acquisition timestamp.

---

## 5. AIS Track Reconstruction & Spatial Search

* **File Location:** [`apps/api/src/modules/candidates/service.ts`](file:///e:/SIH/apps/api/src/modules/candidates/service.ts)
* **Search Envelope (`envelopeFor`):** Buffers origin zone polygon by $15\text{ km}$ ($40\text{ km}$ if drift data is degraded).
* **Track Reconstruction (`reconstructTracks`):** Queries AIS database within $[t_{\text{earliest}} - 3\text{h}, t_{\text{latest}} + 3\text{h}]$. Groups fixes by MMSI, identifies transponder dark periods (gaps $>30\text{ min}$), and reconstructs GeoJSON LineString vessel tracks.

---

## 6. Multi-Feature Vessel Attribution & Decision Engine

### 6.1 The 12-Feature Scoring Model (`scoreCandidate`)
* **File Location:** [`apps/api/src/modules/attribution/features.ts`](file:///e:/SIH/apps/api/src/modules/attribution/features.ts)
* **Feature Breakdown:**

| Feature | Key | Weight | Formula / Logic |
| :--- | :--- | :---: | :--- |
| **F1** | `spatial_proximity` | 0.18 | $e^{-d / 8}$ where $d$ is km distance to origin zone. |
| **F2** | `temporal_alignment` | 0.16 | Fraction of AIS fixes inside release window. |
| **F3** | `track_intersection` | 0.14 | 1.0 if track crosses origin zone; else $\frac{1}{1 + d/3}$. |
| **F4** | `heading_alignment` | 0.10 | $\cos^2(\Delta \text{bearing})$ vs slick orientation. (*N/A if elongation $<2.5$*). |
| **F5** | `ais_dark_period` | 0.10 | Length of AIS silence in release window: $\min(1, \frac{\text{gap}}{120\text{ min}})$. |
| **F6** | `speed_consistency` | 0.08 | Evaluates speed over ground ($4-14\text{ knots}$ ideal for discharge). |
| **F7** | `vessel_type_prior` | 0.07 | Tankers = 1.0, Cargo = 0.7, Fishing/Tug = 0.35, Passenger = 0.3. |
| **F8** | `origin_density_at_track` | 0.05 | Sampled origin probability mass density along vessel track. |
| **F9** | `draught_change` | 0.04 | Measures reported draught drop (cargo/slops discharge). |
| **F10**| `slick_axis_continuity`| 0.03 | Alignment of vessel track heading with long axis of slick. |
| **F11**| `manoeuvre_anomaly` | 0.03 | Average course changes ($\Delta \text{COG}$) near origin zone. |
| **F12**| `prior_incident_history`| 0.02 | Number of prior confirmed incidents for MMSI: $\min(1, \frac{count}{3})$. |

### 6.2 Data Missingness & Renormalization Rule
To prevent penalizing candidates due to sensor coverage gaps, VARUNA uses three distinct statuses:
1. `MEASURED`: Feature evaluated successfully.
2. `MISSING`: Data unavailable (excluded from score calculation).
3. `NOT_APPLICABLE`: Question is physically meaningless (e.g. heading alignment on a round slick).

**Score Renormalization Formula:**
$$\text{Score} = \frac{\sum_{i \in \text{Measured}} \left(\text{Normalised}_i \times W_i\right)}{\sum_{i \in \text{Measured}} W_i} \times 100$$

### 6.3 Confidence Gates & Evidence Tiers
* **Minimum Feature Floor:** If measured features $< 4$, status is set to `INSUFFICIENT_EVIDENCE` regardless of score.
* **Tier Thresholds:**
  * Score $\ge 70.0 \rightarrow$ **`STRONG`**
  * Score $\ge 40.0 \rightarrow$ **`MODERATE`**
  * Score $\ge 20.0 \rightarrow$ **`WEAK`**
  * Score $< 20.0 \rightarrow$ **`INSUFFICIENT_EVIDENCE`**
* **Degraded Origin Cap:** If ocean drift inputs are missing, origin estimate falls back to footprint buffer. High proximity scores can no longer distinguish traffic from the true discharger, so tier is capped at **`MODERATE`**.

---

## 7. Monte Carlo Verification & Rank Separation

### 7.1 Single-Vessel Bootstrap Confidence Intervals (`bootstrapCi`)
* **File Location:** [`apps/api/src/modules/attribution/bootstrap.ts`](file:///e:/SIH/apps/api/src/modules/attribution/bootstrap.ts)
* **Method:** Runs 300 Monte Carlo draws perturbing origin zone bounds ($\pm 8\%$) and interpolated AIS positions. Returns the $5^{\text{th}}$ to $95^{\text{th}}$ percentile confidence range for each vessel score.

### 7.2 Common-Mode Resampling & Rank Separation (`rankSeparation`)
* **File Location:** [`apps/api/src/modules/attribution/separation.ts`](file:///e:/SIH/apps/api/src/modules/attribution/separation.ts)
* **Problem Solved:** Independent bootstrap draws treat origin zone uncertainty as separate accidents per vessel. But origin uncertainty is **common-mode**—shifting the origin zone moves it for all vessels simultaneously.
* **Algorithm:**
  1. Runs 300 paired Monte Carlo iterations across top 10 candidates.
  2. Perturbs origin zone geometry **once per iteration** for the entire field.
  3. Re-scores all candidates under the shared perturbation and records rank winner.
  4. Computes Leader Win Share $P(\text{Leader outscores Runner-Up})$.
* **Distinguishability Decision Rule:**
  * If Win Share $\ge 90\%$: The leader is **Statistically Distinguishable**.
  * If Win Share $< 90\%$: Verdict states candidates are **Not Separable**—ordering is an artifact of input noise, and both vessels must be investigated equally.

---

## Summary of Core Architectural Principles

1. **No Fake Data:** Every detection and attribution decision carries full provenance metadata.
2. **Honest Degradation:** Missing drift forcing degrades score confidence gracefully rather than fabricating mock drift vectors.
3. **Renormalized Weights:** Candidates are scored strictly on measurable dimensions.
4. **Common-Mode Uncertainty:** Rank separation evaluates multi-vessel fields under shared physical perturbations.
