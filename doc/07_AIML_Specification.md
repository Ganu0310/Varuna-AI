# 07 — AI / ML Specification

**Product:** VARUNA
**Problem Statement:** SIH26143
**Service:** Python 3.11 + FastAPI + PyTorch 2.4
**Document version:** 1.0

> **Binding constraint for this entire document:** every model in this system is trained,
> validated and tested exclusively on **real satellite observations with real
> expert-verified labels**. No synthetic slicks are generated. No simulated SAR is used.
> No fabricated AIS tracks enter the attribution model. Data augmentation is limited to
> *label-preserving geometric and radiometric transforms of real imagery* — which is
> re-sampling reality, not inventing it. The distinction is defined precisely in
> [§7.4.4](#744-what-counts-as-augmentation-and-what-counts-as-fabrication) and enforced in
> [13_REAL_DATA_POLICY](13_REAL_DATA_POLICY.md).

---

## 7.1 The three models

VARUNA contains three distinct learned or physical models. They are deliberately kept
separate — fusing them into one end-to-end network would destroy the explainability the
product requires.

| # | Model | Type | Input | Output | Learned? |
|---|---|---|---|---|---|
| **M1** | Oil slick segmentation | Deep CNN / transformer, semantic segmentation | Preprocessed Sentinel-1 SAR tiles | Per-pixel class + probability | Yes, supervised |
| **M2** | Backward drift | Physical Lagrangian particle model (OpenDrift) | Slick polygon + real current and wind fields | Origin probability surface + release-time window | No — physics, with sampled parameters |
| **M3** | Attribution scoring | Transparent additive / logistic model with calibration | 12 evidence features per vessel | Investigative priority score + per-feature contribution + CI | Yes, but deliberately low-capacity |

### 7.1.1 Why M3 is deliberately not a deep model

A gradient-boosted tree or a neural ranker would very likely score marginally better on a
held-out set. We reject it for three reasons that are product requirements, not
preferences:

1. **Explainability is the deliverable.** The output of this system is an evidence dossier
   that must survive cross-examination. "The model said so, and here is a SHAP plot" is a
   weaker artefact than "the vessel was 2.4 km from the 90% origin support at a time
   consistent with the estimated release window, and here are the AIS fixes."
2. **The label set is tiny.** Confirmed, publicly documented vessel-source attributions
   number in the dozens, not thousands. A high-capacity model on dozens of labels
   memorises rather than generalises.
3. **The failure mode is asymmetric.** An over-confident wrong attribution is far more
   damaging than a cautious miss. A low-capacity model with explicit uncertainty fails
   more safely.

---

## 7.2 M1 — Oil slick segmentation

### 7.2.1 Task formulation

Semantic segmentation, **five classes**, not binary detection:

| ID | Class | Why it must be its own class |
|---|---|---|
| 0 | `sea_surface` | Background |
| 1 | `oil_spill` | The target |
| 2 | `look_alike` | **The single most important design decision in the model.** Low-wind zones, biogenic slicks, rain cells, upwelling and algal films all produce dark patches in SAR that look like oil. A binary oil/not-oil model has no way to express "this is dark but not oil" and will produce a high false-positive rate. Giving look-alikes their own class forces the network to learn the discriminating texture and context. |
| 3 | `ship` | Bright point targets; useful for cross-checking AIS (a ship in SAR with no AIS fix is a dark-vessel signal) |
| 4 | `land` | Excluded from analysis; learned rather than only masked, so coastline errors do not create phantom slicks |

### 7.2.2 Why SAR and not optical

| Property | SAR (Sentinel-1 C-band) | Optical (Sentinel-2) |
|---|---|---|
| Cloud penetration | Yes | No |
| Night acquisition | Yes | No |
| Physical mechanism | Oil damps short capillary/gravity waves → reduced Bragg backscatter → dark patch | Sun-glint / colour contrast, geometry-dependent |
| Revisit (Europe/India) | ~6–12 days per orbit, more with both satellites | ~5 days, but clouds remove most acquisitions |
| Reliability for spills | High — this is why every operational service (EMSA CleanSeaNet, KSAT) is SAR-based | Supplementary |

**Decision:** SAR is the primary sensor. Optical is a secondary, opportunistic
disambiguation input (Phase 2) — a true oil slick often shows a sheen signature in optical
that a low-wind zone does not.

### 7.2.3 The physics the model is learning (and its hard limits)

Oil on water suppresses the small-scale surface roughness that generates radar backscatter.
The result is a dark region against a brighter sea. This mechanism has **a wind-speed
window**:

| Wind speed at 10 m | Consequence |
|---|---|
| **< ~3 m/s** | The sea is already too smooth; the whole surface is dark. Oil is indistinguishable. **Detection unreliable.** |
| **~3–10 m/s** | The reliable detection window. Sea is rough enough for contrast; oil is not yet dispersed. |
| **> ~10–12 m/s** | Wind mixes and disperses the slick; contrast collapses. **Detection unreliable.** |

This is not a model limitation; it is physics. VARUNA therefore fetches the **real wind
speed at acquisition time** from ERA5/GFS and computes a `windSuitability` term that is
surfaced in the confidence panel and printed in the report. A detection made at 1.8 m/s
wind is flagged as low-reliability *regardless of how confident the network is*.

```python
def wind_suitability(u10_ms: float) -> float:
    """Piecewise trapezoid over the physically reliable detection window."""
    if u10_ms < 1.5 or u10_ms > 14.0: return 0.0
    if u10_ms < 3.0:  return (u10_ms - 1.5) / 1.5 * 0.6      # ramp up, capped low
    if u10_ms <= 10.0: return 1.0                             # the reliable window
    return max(0.0, 1.0 - (u10_ms - 10.0) / 4.0)              # ramp down
```

### 7.2.4 Preprocessing pipeline

For Sentinel-1 GRD (IW mode). Every step is recorded in the processing manifest so the
result is reproducible.

| # | Step | Tool | Parameters | Purpose |
|---|---|---|---|---|
| 1 | Apply orbit file | SNAP `Apply-Orbit-File` | Precise (POEORB), fallback restituted | Correct geolocation; without it, positions can be off by tens of metres |
| 2 | Thermal noise removal | SNAP `ThermalNoiseRemoval` | Per polarisation | Removes additive sensor noise that dominates low-backscatter (i.e. oil) regions — critical here |
| 3 | Border noise removal | SNAP `Remove-GRD-Border-Noise` | threshold 0.5 | Removes invalid edge pixels that otherwise look like huge dark slicks |
| 4 | Radiometric calibration | SNAP `Calibration` | output `sigma0` | Converts DN to a physical backscatter coefficient, making scenes comparable |
| 5 | Speckle filtering | SNAP `Speckle-Filter` | Refined Lee, 7×7 | Suppresses multiplicative speckle while preserving edges. Median/boxcar blur slick boundaries; Refined Lee is edge-aware. |
| 6 | Terrain correction | SNAP `Terrain-Correction` | Range-Doppler, SRTM 1Sec, 10 m output | Projects to a map CRS so pixels have true geographic coordinates |
| 7 | dB conversion | `10*log10(sigma0)` | — | Backscatter is log-distributed; dB makes it approximately Gaussian and trainable |
| 8 | COG conversion | `rio cogeo create` | deflate, 512 px blocks, overviews | Enables windowed reads and tile serving |

**Fast path:** Microsoft Planetary Computer publishes **Sentinel-1 RTC** (Radiometrically
Terrain Corrected) products where steps 1–6 are already done to a documented standard. When
used, the manifest records `preprocessing: "MPC_RTC"` plus the provider's own processing
metadata. This cuts ingest from ~12 minutes to ~2.

### 7.2.5 Input representation

```python
# Three channels from a dual-polarisation acquisition
channels = [
    vv_db,                      # VV in dB — primary oil contrast
    vh_db,                      # VH in dB — cross-pol, different scattering, helps separate look-alikes
    vv_db - vh_db,              # polarisation ratio in dB (equivalent to log of the linear ratio)
]
```

Normalisation is **per-scene robust scaling**, not a global constant:

```python
def robust_scale(band: np.ndarray) -> np.ndarray:
    """Scale using the scene's own 2nd/98th percentiles over valid water pixels.

    A global mean/std would break across incidence angles, sea states and regions.
    Percentile clipping also removes ship-bright outliers that would otherwise
    compress the dynamic range where the oil signal lives.
    """
    valid = band[np.isfinite(band)]
    lo, hi = np.percentile(valid, [2, 98])
    return np.clip((band - lo) / (hi - lo + 1e-8), 0.0, 1.0)
```

Tiles: **256 × 256** at 10 m GSD (2.56 km on a side), stride **192** (25% overlap).

### 7.2.6 Architectures evaluated

All four are trained under an identical protocol and compared on the same held-out split.
We ship whichever wins on oil-class IoU *and* meets the latency budget — the choice is made
by the evaluation, not asserted in advance.

| Model | Encoder | Params | Why it is a candidate | Expected weakness |
|---|---|---|---|---|
| **U-Net** | ResNet-34 (ImageNet) | ~24 M | The reliable baseline for medical/remote-sensing segmentation; skip connections preserve the fine slick boundary | Limited receptive field for very large slicks |
| **U-Net++** | ResNet-34 | ~26 M | Nested dense skips improve boundary delineation, which matters because the polygon boundary becomes the drift seed | Heavier, slower |
| **DeepLabV3+** | ResNet-50 | ~40 M | Atrous spatial pyramid pooling captures multi-scale context — good for distinguishing a slick from a large low-wind region | Coarser boundaries from output stride |
| **SegFormer-B2** | MiT-B2 | ~27 M | Global self-attention gives scene-level context, the exact capability needed to separate oil from a look-alike that is locally identical | Needs more data; slower on CPU |

```python
import segmentation_models_pytorch as smp

def build_model(name: str, in_ch: int = 3, classes: int = 5):
    if name == 'unet':
        return smp.Unet('resnet34', encoder_weights='imagenet',
                        in_channels=in_ch, classes=classes)
    if name == 'unetpp':
        return smp.UnetPlusPlus('resnet34', encoder_weights='imagenet',
                                in_channels=in_ch, classes=classes)
    if name == 'deeplabv3p':
        return smp.DeepLabV3Plus('resnet50', encoder_weights='imagenet',
                                 in_channels=in_ch, classes=classes)
    if name == 'segformer':
        from transformers import SegformerForSemanticSegmentation
        return SegformerForSemanticSegmentation.from_pretrained(
            'nvidia/mit-b2', num_labels=classes, ignore_mismatched_sizes=True)
    raise ValueError(name)
```

> **Note on ImageNet pretraining:** the encoder is initialised from ImageNet weights. This
> is transfer learning from real photographs, not synthetic data. The first convolution is
> adapted from 3 RGB channels to our 3 SAR channels by weight averaging where channel
> counts differ.

### 7.2.7 Loss function

Oil is typically **under 2% of pixels** in a scene containing a spill, and 0% in most
scenes. Plain cross-entropy converges to predicting "sea" everywhere and reports 98%
accuracy — which is why accuracy is never reported for this task.

```python
class OilSegLoss(nn.Module):
    """0.5 * Dice + 0.5 * Focal.

    Dice optimises region overlap directly and is insensitive to the sea-class majority.
    Focal down-weights easy, correctly-classified sea pixels so gradient signal
    concentrates on the oil/look-alike boundary, which is where the decision is hard.
    """
    def __init__(self, class_weights: torch.Tensor):
        super().__init__()
        self.dice  = smp.losses.DiceLoss(mode='multiclass', from_logits=True)
        self.focal = smp.losses.FocalLoss(mode='multiclass', gamma=2.0, alpha=class_weights)

    def forward(self, logits, target):
        return 0.5 * self.dice(logits, target) + 0.5 * self.focal(logits, target)
```

Class weights are the inverse of the observed pixel frequency in the **real training set**,
normalised to mean 1, and clipped to a maximum of 12 to prevent instability.

### 7.2.8 Training protocol

| Setting | Value | Reason |
|---|---|---|
| Optimiser | AdamW, `lr=3e-4`, `weight_decay=1e-4` | Standard, decoupled weight decay |
| Schedule | Cosine annealing with 3-epoch linear warmup | Stabilises the early ImageNet-encoder mismatch |
| Batch size | 16 (256², AMP fp16 on a 16 GB GPU) | Fits with mixed precision |
| Epochs | 120, early stop on validation oil-IoU, patience 15 | — |
| Encoder freezing | First 3 epochs frozen, then full fine-tune | Prevents the random decoder from destroying pretrained features |
| Precision | AMP fp16 with gradient scaling | ~1.8× throughput |
| Gradient clipping | Max norm 1.0 | Focal loss can spike |
| Seed | Fixed and recorded; 3 seeds per architecture | Reported metrics are mean ± std over seeds, not a single lucky run |
| Tracking | MLflow: params, metrics, dataset manifest hash, git SHA, artefact SHA-256 | Reproducibility is a release criterion |

### 7.2.9 Inference

```python
@torch.inference_mode()
def segment_scene(cog_path: str, model, tile=256, stride=192, batch=16, device='cuda'):
    """Tiled inference with cosine-window blending.

    Naive tiling produces visible seams because a pixel at a tile edge has only
    half the context of a pixel at the centre. We weight each tile's contribution
    by a 2D cosine (Hann) window, so predictions near the tile centre dominate and
    the overlapping regions blend smoothly.
    """
    with rasterio.open(cog_path) as src:
        H, W = src.height, src.width
        prob = np.zeros((N_CLASSES, H, W), np.float32)
        wsum = np.zeros((H, W), np.float32)
        window2d = hann2d(tile)

        for chunk in batched(tile_windows(H, W, tile, stride), batch):
            arrs = [read_and_normalise(src, w) for w in chunk]
            x = torch.from_numpy(np.stack(arrs)).to(device)
            with torch.autocast(device_type=device, dtype=torch.float16):
                logits = model(x)
            p = torch.softmax(logits.float(), dim=1).cpu().numpy()
            for k, w in enumerate(chunk):
                prob[:, w.row_off:w.row_off+tile, w.col_off:w.col_off+tile] += p[k] * window2d
                wsum[w.row_off:w.row_off+tile, w.col_off:w.col_off+tile] += window2d

        prob /= np.maximum(wsum, 1e-8)
        return prob, prob.argmax(0).astype(np.uint8)
```

Both the argmax class map **and** the full per-class probability stack are written as COGs.
The probability raster is what the UI's confidence overlay renders — the analyst can see
*where* the model was unsure, not just a single scalar.

### 7.2.10 Post-processing and vectorisation

```python
def postprocess(class_map, prob, transform, crs,
                min_area_km2=0.05, min_mean_prob=0.60):
    oil = (class_map == OIL).astype(np.uint8)

    # Morphological opening removes speckle-scale false positives;
    # closing fills interior holes caused by wave-induced brightening within a slick.
    oil = cv2.morphologyEx(oil, cv2.MORPH_OPEN,  np.ones((3, 3), np.uint8))
    oil = cv2.morphologyEx(oil, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))

    polygons = []
    for geom, val in rasterio.features.shapes(oil, mask=oil.astype(bool), transform=transform):
        if val != 1:
            continue
        shp = shape(geom)

        # Geodesic area — never area in degrees
        area_km2 = abs(Geod(ellps='WGS84').geometry_area_perimeter(
            transform_to_wgs84(shp, crs))[0]) / 1e6
        if area_km2 < min_area_km2:
            continue

        mask = rasterio.features.geometry_mask([geom], oil.shape, transform, invert=True)
        mean_p = float(prob[OIL][mask].mean())
        if mean_p < min_mean_prob:
            continue

        polygons.append({
            'geometry': mapping(rewind(simplify(shp, tolerance=meters_to_deg(20)))),
            'areaKm2': area_km2,
            'morphology': compute_morphology(shp, crs),
            'confidence': {
                'meanOilProbability': mean_p,
                'minOilProbability': float(prob[OIL][mask].min()),
                'maxOilProbability': float(prob[OIL][mask].max()),
                'lookAlikeCompetition': float(prob[LOOK_ALIKE][mask].mean()),
            },
        })
    return polygons
```

**Morphology** (used later as attribution evidence):

```python
def compute_morphology(shp, crs):
    """Slick shape is evidence, not decoration.

    A slick released by a MOVING vessel is characteristically long, narrow and linear,
    and its major axis bearing approximates the vessel's course at the time of discharge.
    A slick from a stationary source (platform, seep, anchored vessel) is more
    isotropic. Elongation ratio and orientation therefore feed directly into the
    attribution model (features F4 and F10 in §7.6).
    """
    aeq = to_local_equal_area(shp, crs)
    mrr = aeq.minimum_rotated_rectangle
    (x0,y0),(x1,y1),(x2,y2) = list(mrr.exterior.coords)[:3]
    e1 = math.hypot(x1-x0, y1-y0); e2 = math.hypot(x2-x1, y2-y1)
    major, minor = max(e1, e2), min(e1, e2)
    dx, dy = (x1-x0, y1-y0) if e1 >= e2 else (x2-x1, y2-y1)
    bearing = (math.degrees(math.atan2(dx, dy)) + 360) % 180   # axis, so mod 180
    return {
        'majorAxisKm': major/1000, 'minorAxisKm': minor/1000,
        'elongationRatio': major/max(minor, 1e-6),
        'orientationDeg': bearing,
        'convexity': aeq.area / aeq.convex_hull.area,
        'centroid': mapping(to_wgs84(aeq.centroid)),
    }
```

### 7.2.11 Confidence model

```python
def detection_confidence(c, wind_u10_ms, elongation):
    """Combine model confidence with physical plausibility.

    A network can be confidently wrong. Multiplying by physical suitability means a
    detection made in unusable wind conditions cannot present as high confidence,
    which is exactly what we want for a safety-relevant tool.
    """
    model_term      = c['meanOilProbability']
    separation_term = 1.0 - min(c['lookAlikeCompetition'] / max(model_term, 1e-6), 1.0)
    wind_term       = wind_suitability(wind_u10_ms)
    shape_term      = min(elongation / 4.0, 1.0)   # linear slicks are more diagnostic
    overall = (0.40*model_term + 0.25*separation_term
             + 0.25*wind_term  + 0.10*shape_term)
    return {'overall': round(overall, 3), 'modelTerm': model_term,
            'separationTerm': separation_term, 'windTerm': wind_term,
            'shapeTerm': shape_term}
```

All four terms are displayed individually in the UI. A single blended number would hide
which factor is limiting.

### 7.2.12 Evaluation, and the labels review produces

**Never reported:** pixel accuracy. It is meaningless at 98% sea.

| Metric | Definition | Why |
|---|---|---|
| Oil IoU | `TP / (TP+FP+FN)` on the oil class | Primary metric; penalises both over- and under-segmentation |
| Oil Dice / F1 | `2TP / (2TP+FP+FN)` | Comparable to published SAR oil-spill literature |
| Oil precision | `TP/(TP+FP)` | False alarms waste response resources |
| Oil recall | `TP/(TP+FN)` | Missed spills are the worse environmental error → we tune the threshold to favour recall |
| Mean IoU (5 classes) | Mean over classes | Overall competence |
| **Look-alike → oil confusion rate** | Fraction of `look_alike` GT pixels predicted `oil_spill` | **The metric that matters most operationally.** This is the false-alarm driver. |
| Boundary F1 (2 px tolerance) | Boundary agreement | The boundary becomes the drift seed, so boundary error propagates into origin error |
| Per-scene detection rate | Scene-level TPR/FPR at the polygon level | What an operator actually experiences |

Splits are **by scene and by geography**, never by random tile. Random tile splitting leaks
information: two overlapping tiles from the same slick would land in train and test,
inflating metrics. Splits: 70/15/15 train/val/test, with the test set containing scenes from
geographic regions absent from training, to measure genuine generalisation.

#### What was actually measured

Held-out split: **66 real Sentinel-1 scenes**, 22 oil / 22 look-alike / 22 clean sea, from
1.0° geographic cells assigned wholly to one split (`data/splits/part3-split.json`). Measured
once, with no sweep against it.

| Metric | Target (§9.1) | `darkspot-v1` (shipped) | U-Net (trained, **not adopted**) |
|---|---|---|---|
| Oil mean IoU | ≥ 0.55 | **0.564** ✅ | 0.637 |
| Oil median IoU | — | 0.627 | 0.696 |
| Oil detection rate | ≥ 0.75 | **1.00** ✅ (0 missed) | 1.00 |
| Pixel-pooled Dice / F1 | ≥ 0.70 | — | 0.738 |
| **Look-alike → oil FP rate** | **≤ 0.20** | **0.682** ❌ | **0.818** ❌ |
| Clean-sea FP rate | — | 0.182 | 0.000 |
| Mean look-alike risk on its own false positives | — | **0.259** | — |

**The last row is the finding that matters, and it is a bad one.** The detector fires on 68%
of look-alike scenes, and on those false positives its own look-alike warning channel averages
0.26 — barely above what it assigns a true slick. **It is not merely wrong; it is wrong without
warning.** Reporting this is not optional under the honesty rule: a look-alike FP rate 3.4×
the target is exactly the number a judge should be told before they trust a ranking.

Raw results: `data/eval/classical-test66.json`, `data/eval/unet-test66.json`,
`data/eval/detector-comparison.json`.

#### Why thresholds cannot fix it — the tuning ladder, measured and closed

`services/ml/varuna_ml/eval/tuning.py` swept contrast threshold (2.5–5.0), minimum area
(0.05–3.0 km²), minimum elongation (0–4), the look-alike risk gate (0.2–1.0), and every
promising combination, on 384 development scenes. Oil detection rate was a **hard floor**, not
a term in a combined score — recall was never traded away to buy a better headline.

The best development configuration removed 8.5 points of look-alike false positives at zero
recall cost. **It did not transfer.** On the held-out split the look-alike FP rate was
unchanged at 68.2% — 15 of 22 scenes, identical to baseline — while oil IoU fell 0.028. It was
**not adopted**; `darkspot-v1` keeps its shipped parameters (`data/eval/tuning-decision.json`).

Two supporting findings, both negative and both worth keeping:

- **The gates are redundant, not complementary.** Adding an elongation gate on top of the risk
  gate changed the false-positive rate by *exactly zero* on 384 scenes — because
  `look_alike_risk()` already contains an elongation term (`r_shape`). Tuning them jointly
  cannot help.
- Across every configuration swept, mean look-alike risk on false positives stayed in the
  0.15–0.29 band. **No parameter setting makes the detector's warning channel informative
  about its own errors.**

This establishes that the look-alike problem is **not reachable by thresholds, area gates,
shape gates or risk gates on a classical detector.** What remains is focal loss to down-weight
easy negatives, and a trained look-alike classifier. Look-alike scenes carry no positive
pixels, so a segmentation objective alone teaches no rejection — which is also why the U-Net
scored *better* on oil IoU and *worse* on look-alikes.

#### The labelled set analyst review already produces

The fix the evidence points at is labelled negatives of each look-alike class. That is the
expensive half of a training set — the imagery is free, the labelling is not — and this system
generates it as a by-product of ordinary work, provided a rejection records *which class* it
was. Implemented in `apps/api/src/modules/detections/labels.ts`, exposed at
`GET /api/v1/admin/training-labels`.

A rejection therefore carries a **category**, not just prose. Prose is unusable in aggregate:
it cannot answer "which look-alike class does this detector fall for most?", and it cannot
become a labelled negative. The taxonomy lives in `packages/shared/src/constants.ts` as
`REJECTION_CATEGORIES` and is served to the UI at
`GET /api/v1/detections/rejection-categories`.

`kind` separates the two different questions a rejection can answer:

| `kind` | Meaning | Trainable |
|---|---|---|
| `LOOK_ALIKE` | The analyst judged the pixels are not oil — a statement about the **imagery** | Yes, iff `sarClass` is non-null |
| `OPERATIONAL` | The rejection is about the **workflow**, not the pixels | **Never** |

| Category | `kind` | `sarClass` |
|---|---|---|
| `LOW_WIND` — low-wind or wind-shadow zone | `LOOK_ALIKE` | `sea_surface` |
| `BIOGENIC_FILM` — biogenic film or algal slick | `LOOK_ALIKE` | `look_alike` |
| `RAIN_CELL` — rain cell | `LOOK_ALIKE` | `look_alike` |
| `SHIP_WAKE` — wake or turbulent trail | `LOOK_ALIKE` | `look_alike` |
| `INTERNAL_WAVE` — internal wave or current shear | `LOOK_ALIKE` | `look_alike` |
| `SEA_ICE` — sea ice | `LOOK_ALIKE` | `look_alike` |
| `LAND_OR_STRUCTURE` — land, tidal flat or fixed structure | `LOOK_ALIKE` | `land` |
| `SENSOR_ARTEFACT` — azimuth ambiguity, scalloping, thermal-noise banding | `LOOK_ALIKE` | **`null`** |
| `LOOK_ALIKE_UNCLASSIFIED` — not oil, mechanism not named | `LOOK_ALIKE` | `look_alike` |
| `INSUFFICIENT_IMAGE_QUALITY` — cannot be judged from this scene | `OPERATIONAL` | `null` |
| `DUPLICATE` — duplicate of another detection | `OPERATIONAL` | `null` |
| `SUPERSEDED` — superseded by a better acquisition | `OPERATIONAL` | `null` |
| `OUT_OF_SCOPE` — outside this investigation | `OPERATIONAL` | `null` |

**The single rule: a rejection is usable as a labelled negative iff `sarClass !== null`.**
`SENSOR_ARTEFACT` is the case that proves it is the right rule — a processing artefact is
genuinely not oil, but it is not a valid sample of any *physical* class either, so it is
recorded and never trained on. `INSUFFICIENT_IMAGE_QUALITY` is an absence of evidence, not
evidence of absence, and is `OPERATIONAL` for the same reason.

Three rules govern what leaves the harvester, each stopping a plausible-looking but dishonest
label:

1. **An `UNREVIEWED` detection is not a label.** No human looked at it. Excluded.
2. **An `OPERATIONAL` rejection is not a negative.** Training on "duplicate" would teach the
   detector that a perfectly good slick is not a slick.
3. **A rejection recorded before the taxonomy existed is `UNCATEGORISED`, not guessed.** It is
   counted, reported, and left out of the training set.

`MIN_LABELS_PER_CLASS = 25` is **a working target, not a measured one** — the held-out split
carries 22 scenes per class, so a training set materially smaller than that cannot be said to
have taught a class the model will be tested on. It is a judgement call, labelled as one
wherever it is reported, and must never be read as a validated sample-size result.

Nothing in this module trains anything. It assembles and counts, so the decision to retrain is
made against a number somebody can see.

---

## 7.3 M2 — Backward drift and origin estimation

### 7.3.1 Why this module exists

**The observed slick is not where the oil was released.**

Between release and satellite overpass — often 6 to 24 hours — the slick is transported by
surface currents and pushed by wind, while stretching along the shear. A system that
correlates vessels against the *observed* footprint will systematically favour vessels that
happened to be downstream, and systematically exclude the actual source.

This module is the primary technical differentiator of VARUNA
(see [09_RESEARCH §9.7](09_RESEARCH_Competitive_Analysis.md)).

### 7.3.2 The transport model

For a particle at position `x` and time `t`:

```
u_total(x,t) = u_current(x,t) + α · R(θ) · u_wind10(x,t)
```

| Term | Source | Value |
|---|---|---|
| `u_current` | **Real** surface `uo`/`vo` from the currents chain below | Bilinear in space, linear in time |
| `u_wind10` | **Real** 10 m `u10`/`v10` from the wind chain below | Bilinear in space, linear in time |
| `α` | Wind drift coefficient | Sampled per particle, `Uniform(0.02, 0.04)`; **set to 0 when `windStatus = UNKNOWN`** |
| `R(θ)` | Ekman/Coriolis deflection rotation | `θ ~ Uniform(0°, 20°)`, right of wind in the Northern Hemisphere, left in the Southern |

The 2–4% wind-drift factor with a 0–20° deflection is the long-standing empirical rule used
in operational spill response, and it is a *range* precisely because it is uncertain. We
sample it rather than fixing it, so that uncertainty propagates into the origin field
instead of being hidden.

#### The forcing provider chains

Implemented in `services/ml/varuna_ml/drift/forcing.py`. Best-quality first, keyless last.
**There is no synthetic fallback at any position in either chain.** If no provider covers the
region and date, the run degrades and says so — inventing a current field would produce an
origin zone that looks authoritative and means nothing
([13_REAL_DATA_POLICY §13.8](13_REAL_DATA_POLICY.md)).

| Chain | Order | Credential | Dataset |
|---|---|---|---|
| **CURRENTS** | 1. CMEMS | `CMEMS_USERNAME` + `CMEMS_PASSWORD` | `cmems_mod_glo_phy_anfc_0.083deg_PT1H-m` — 1/12°, hourly |
| | 2. HYCOM archive | none (OPeNDAP) | `GLBy0.08/expt_93.0/uv3z` |
| | 3. HYCOM operational | none (OPeNDAP) | `FMRC_ESPC-D-V02_uv3z_best.ncd` |
| **WIND** | 1. ERA5 local file | `ERA5_LOCAL_PATH` | operator-supplied GRIB/NetCDF, 10 m `u10`/`v10` |
| | 2. ERA5 CDS API | `CDSAPI_KEY` | `reanalysis-era5-single-levels` — 0.25°, hourly |

Three properties of these chains are deliberate and load-bearing.

**Every attempt is recorded, including the ones that succeeded later.** Each provider the
chain touches appends one entry — `provider`, `outcome`, and where relevant `datasetId`,
`covers`, `detail` — and the list is returned to the caller, persisted on the origin estimate
as `providerAttempts`, and rendered in the provenance panel and the dossier. A chain that
falls through silently is indistinguishable from one that was never tried, and the difference
is exactly what an analyst needs when the estimate comes back degraded. Outcomes are
deliberately coarse and stable (`OK`, `NOT_CONFIGURED`, `AUTH_FAILED_401`, `FORBIDDEN_403`,
`NOT_FOUND_404`, `NO_DATA`, `OUT_OF_COVERAGE`, `TIMEOUT`, `UNREACHABLE`, `ERROR`) rather than
echoing a library's error text, which changes between versions.

**There is a real keyless coverage gap, found by probing rather than assumed.** HYCOM's
reanalysis archive ends **2024-09-05**, while its operational feed holds only roughly the last
two weeks. Dates in between have **no keyless current coverage at all**, so an incident in
that gap requires CMEMS credentials. `coverage()` reports this honestly instead of silently
returning the nearest available field, which would attribute a spill using currents from a
different year.

**NOAA GFS is not a wind fallback, despite being keyless.** NOMADS retains roughly ten days,
so it cannot serve a historic incident. Rather than pretend otherwise, the chain records
`NOAA_GFS: RETENTION_TOO_SHORT_FOR_HISTORIC_DATE` and the run degrades to `α = 0`.

**Deadlines and retries.** The provider libraries (`copernicusmarine`, `netCDF4`/OPeNDAP,
`cdsapi`) are synchronous with no uniform timeout, so a wall-clock deadline is imposed from
outside on a worker thread — `forcing_timeout_seconds` (default 180 s), `forcing_retries`
(default 2). A thread that overruns is abandoned rather than killed, so the drift run degrades
on schedule instead of hanging a job queue behind a provider outage. Retries cover only
transport-shaped failures: an authentication failure or an out-of-coverage window will not
change on a second attempt, and retrying it wastes the deadline the analyst is waiting on.

> **The `/backtrack` handler is a blocking `def`, not `async def`, and that is load-bearing.**
> Everything it does is synchronous and slow — provider reads, GDAL, CMEMS, particle
> integration — and none of it awaits. Declared `async`, a single drift run stalls the entire
> event loop: while one waited ~50 s for CMEMS, every other request queued behind it,
> `/health` included, and the worker reported `fetch failed` on unrelated jobs. That reads
> like a network fault and was self-inflicted head-of-line blocking. Declared `def`, Starlette
> runs it in its threadpool, so slow work occupies one thread and the loop stays free.

### 7.3.3 Backward integration

```python
def backtrack(slick_polygon, t_obs, horizon_h=24, n_particles=5000,
              dt_min=15, kh=10.0, currents=None, winds=None, seed=None):
    """Backward Lagrangian transport producing an origin PROBABILITY FIELD.

    We integrate backwards in time from the observed slick. Each particle carries its
    own sampled wind-drift coefficient and deflection angle, so the ensemble spread
    directly represents parameter uncertainty rather than a single deterministic guess.
    """
    rng = np.random.default_rng(seed)
    pos   = sample_points_in_polygon(slick_polygon, n_particles, rng)   # [n,2] lon/lat
    alpha = rng.uniform(0.02, 0.04, n_particles)
    theta = np.radians(rng.uniform(0.0, 20.0, n_particles)) * hemisphere_sign(pos[:, 1])

    dt = dt_min * 60
    steps = int(horizon_h * 3600 / dt)
    frames = []
    t = t_obs

    for _ in range(steps):
        uc, vc = currents.interp(pos, t)          # real field, m/s
        uw, vw = winds.interp(pos, t)             # real field, m/s
        if uc is None or uw is None:
            return DriftResult(status='UNAVAILABLE',
                               reason='forcing field missing for this time/region')

        uw_r =  uw*np.cos(theta) + vw*np.sin(theta)      # apply deflection
        vw_r = -uw*np.sin(theta) + vw*np.cos(theta)

        u = uc + alpha*uw_r
        v = vc + alpha*vw_r

        # backward step + stochastic horizontal diffusion (random walk)
        dx = -u*dt + rng.normal(0, np.sqrt(2*kh*dt), n_particles)
        dy = -v*dt + rng.normal(0, np.sqrt(2*kh*dt), n_particles)
        pos = displace_lonlat(pos, dx, dy)

        t -= timedelta(seconds=dt)
        frames.append({'atTime': t, 'positions': pos.copy()})

    return DriftResult(status='OK', frames=frames,
                       alpha=alpha, theta=theta, params=locals_snapshot())
```

> ### ⚠️ Correction: the stepper above **is** the shipped implementation
>
> This section previously specified **OpenDrift** (`OceanDrift` / `OpenOil`) as the integrator,
> with the stepper above retained only as a test cross-check. **The roles are inverted in the
> shipped system**, and the reason is a hard dependency constraint, not a preference:
> OpenDrift requires cartopy/GEOS, which would not install in this environment.
>
> So `services/ml/varuna_ml/drift/backtrack.py` — the stepper above — is **primary**, and it is
> **directly tested against analytic solutions** rather than against another library's output.
> That is a weaker validation story than deferring to MET Norway's peer-reviewed operational
> model, and it is stated here rather than left implied.
>
> **What is lost by not running OpenDrift:** oil weathering and coastline stranding are not
> modelled. For a 24-hour back-track over open water, advection dominates both, but a
> back-track that would beach the slick is not handled specially and should be read with that
> in mind.
>
> **What keeps the door open:** the forcing interface is deliberately the same shape OpenDrift
> expects, so swapping it in later touches only that one file.

**Backward integration** is `-dt` on the same equations. That is exact for advection and
correct-in-distribution for the diffusive term, since a symmetric random walk run backwards has
the same statistics.

**Why `α` and `θ` are sampled rather than fixed:** their true values depend on slick thickness,
sea state and oil properties we do not know. Fixing them would produce a tight,
confident-looking origin blob whose apparent precision is fictional. Sampling across the
plausible range makes the resulting spread an honest expression of that ignorance — the
uncertainty in the answer comes from uncertainty in the physics, not from tuning.

### 7.3.4 From particle cloud to probability surface

```python
def origin_field(frame_positions, bounds, cell_deg=0.01):
    """Gaussian KDE over the particle cloud, exported as a georeferenced raster.

    A single 'most likely origin point' would be a false precision. What the physics
    actually supports is a probability density, and that is what we render and what
    the attribution model consumes.
    """
    kde = gaussian_kde(frame_positions.T, bw_method='scott')
    lon = np.arange(bounds.west, bounds.east, cell_deg)
    lat = np.arange(bounds.south, bounds.north, cell_deg)
    LON, LAT = np.meshgrid(lon, lat)
    dens = kde(np.vstack([LON.ravel(), LAT.ravel()])).reshape(LON.shape)
    dens /= dens.sum()
    return {
        'grid': dens,
        'support50': contour_polygon(dens, LON, LAT, cumulative=0.50),
        'support90': contour_polygon(dens, LON, LAT, cumulative=0.90),
        'centroid': weighted_centroid(LON, LAT, dens),
    }
```

### 7.3.5 Release-time window estimation

```python
def estimate_release_window(morphology, drift_speeds_kmh, t_obs,
                            horizon_h, prior_clear_scene_time=None):
    """Estimate WHEN the release happened — as an interval, never an instant.

    Physical basis: a slick released from a moving vessel is stretched along the
    drift/shear direction. Its major-axis length divided by the local drift speed
    gives an order-of-magnitude estimate of elapsed time since release.

    A hard lower bound comes from data, not modelling: if a previous satellite pass
    over the same footprint showed no slick, the release must have happened after it.
    """
    v = float(np.median(drift_speeds_kmh))
    if v < 0.05:
        return Window(status='WIDE', earliest=t_obs - timedelta(hours=horizon_h),
                      latest=t_obs, reason='drift speed too low to constrain timing')

    elapsed_h = morphology['majorAxisKm'] / v
    earliest = t_obs - timedelta(hours=min(elapsed_h*1.5, horizon_h))
    latest   = t_obs - timedelta(hours=max(elapsed_h*0.4, 0.5))

    if prior_clear_scene_time and prior_clear_scene_time > earliest:
        earliest = prior_clear_scene_time      # observational hard bound

    return Window(status='OK', earliest=earliest, latest=latest,
                  most_likely_start=t_obs - timedelta(hours=elapsed_h*1.15),
                  most_likely_end=t_obs   - timedelta(hours=elapsed_h*0.75))
```

### 7.3.6 Degradation behaviour

**The two forcing terms fail independently, and the consequences differ**, so one overall
status cannot express both. No currents means there is no drift result at all; no wind means a
wind-driven slick has its origin *under-displaced* in a direction the report states. An analyst
needs to know which of those they are reading, so the origin estimate carries three fields, not
one:

| Field | Values |
|---|---|
| `status` | `OK` · `DEGRADED` · `UNAVAILABLE` — the overall verdict |
| `currentStatus` | `OBSERVED` · `UNAVAILABLE` |
| `windStatus` | `OBSERVED` · `UNKNOWN` · `NOT_ATTEMPTED` |

`windStatusReason` carries the prose consequence, and `providerAttempts[]` carries the full
per-provider record described in §7.3.2.

| Condition | `status` | `currentStatus` | `windStatus` | Behaviour |
|---|---|---|---|---|
| Both available | `OK` | `OBSERVED` | `OBSERVED` | Full back-track |
| Currents available, wind missing | `DEGRADED` | `OBSERVED` | `UNKNOWN` | Run with currents only, **`α = 0`**. UI and report state that wind forcing was unavailable and that a wind-driven slick is under-displaced. |
| Currents missing | `DEGRADED` | `UNAVAILABLE` | `NOT_ATTEMPTED` | Fall back to `FOOTPRINT_PROXIMITY`: the "origin zone" becomes the slick polygon buffered by 40 km, explicitly labelled a proximity envelope, **not** a drift result |
| Region/date outside all model coverage | `UNAVAILABLE` | `UNAVAILABLE` | `NOT_ATTEMPTED` | No origin estimate produced; correlation runs against the footprint with a prominent banner |

`NOT_ATTEMPTED` is a distinct state from `UNKNOWN` on purpose: without a current field there is
no trajectory to apply wind to, so the wind chain is never called, and reporting that as
"wind unavailable" would blame a provider that was never asked.

**`UNKNOWN` wind is never silently replaced with a constant or a climatological mean.** The
wind-drift coefficient goes to zero and the run labels itself degraded. A "typical" wind would
produce a displaced origin zone with no observational basis, which is precisely the failure
this system exists to avoid.

In every degraded case the confidence intervals on all downstream attribution scores widen,
and the tier thresholds are not adjusted to compensate — a degraded run should produce
fewer `STRONG` results, and it does.

---

## 7.4 Training data — real sources only

### 7.4.1 Primary labelled dataset

**MKLab / CERTH Oil Spill Detection Dataset** (Krestenitis et al., *Remote Sensing*, 2019,
"Oil Spill Identification from Satellite Images Using Deep Neural Networks").

| Property | Value |
|---|---|
| Source imagery | **Real Sentinel-1 SAR** acquisitions |
| Size | ~1,112 annotated image patches (train + test splits provided) |
| Classes | Exactly the five we use: sea surface, oil spill, look-alike, ship, land |
| Labelling | Derived from **EMSA CleanSeaNet verified events** — i.e. expert-confirmed real incidents, not crowd-sourced guesses |
| Access | `mklab.iti.gr/results/oil-spill-detection-dataset/` — request form |
| Licence | Research use; cite the paper |

This dataset is the reason our five-class formulation is possible and the reason our target
metrics in [01_PRD §9.1](01_PRD_Product_Requirements.md) are benchmarked rather than
invented.

### 7.4.2 Supplementary real datasets

| Dataset | Content | Use |
|---|---|---|
| **SOS / Deep-SAR Oil Spill dataset** | Real GaoFen-3 and Sentinel-1 SAR with oil annotations | Cross-sensor generalisation testing |
| **Scenes from documented incidents** | Sentinel-1 acquisitions over verified spills (see [10_DATASETS §10.6](10_DATASETS_and_Sources.md)) | Held-out real-world validation; end-to-end demonstration |
| **NOAA Marine Pollution Surveillance Reports** | Analyst-confirmed slick locations and times | Ground truth for validating detections |
| **Analyst corrections from the product itself** | Real reviewed detections from `spill_detections.reviewHistory` | Phase-2 continual learning; each carries the reviewing user and timestamp |

Full acquisition instructions, licences and volumes are in
[10_DATASETS_and_Sources.md](10_DATASETS_and_Sources.md).

### 7.4.3 Attribution model labels

M3 requires labelled `(incident, vessel, was_source)` pairs. These are scarce and must be
real:

| Source of labels | Nature |
|---|---|
| Publicly documented prosecutions and enforcement actions for illegal discharge | Confirmed positive |
| Official incident investigation reports (national maritime authorities, ITOPF case records, Cedre) | Confirmed positive |
| Vessel casualties with a known grounding/collision position and time | Confirmed positive with a known release point |
| Vessels present in the same envelope but excluded by an official investigation | Confirmed negative |

Because these number in the dozens, M3 is deliberately low-capacity (§7.1.1) and the
default weight profile is **expert-elicited rather than fitted**, with fitting used only
for calibration once enough labels accumulate. The UI labels an uncalibrated score
`UNCALIBRATED` — it does not silently present an expert prior as a learned probability.

### 7.4.4 What counts as augmentation and what counts as fabrication

This distinction is load-bearing for the no-fake-data policy, so it is stated precisely.

**Permitted — label-preserving transforms of real observations:**

| Transform | Justification |
|---|---|
| Horizontal / vertical flip | A slick is not orientation-privileged; flipping a real acquisition yields a physically plausible real-world configuration |
| Rotation (90°/180°/270°) | Same |
| Random crop within a real scene | Sub-sampling real observation |
| Brightness / contrast jitter (±10%) within observed calibration variance | Emulates real incidence-angle and calibration variation across real acquisitions |
| Additive speckle consistent with the sensor's known statistics | Emulates real sensor noise that is present in every real acquisition |

**Forbidden — anything that invents an observation:**

| Forbidden | Why |
|---|---|
| GAN- or diffusion-generated SAR imagery | The model would learn a generator's artefacts, and reported metrics would not describe real-world performance |
| Synthetic slicks pasted onto real sea backgrounds | Creates a boundary artefact the network trivially learns; metrics become meaningless |
| Simulated AIS tracks | The attribution model would learn simulator assumptions instead of real vessel behaviour |
| Physics-simulated "training spills" | Circular: the model would learn the drift model we are separately using |
| Oversampling to the point of duplication passed off as dataset size | Misrepresents the evidence base |

Class imbalance is handled by **loss weighting and sampling of real tiles**, never by
generating oil.

### 7.4.5 Dataset manifest

Every training run is driven by a manifest, and the run refuses to start if any entry is
incomplete:

```yaml
dataset_manifest:
  version: "2026.03.01"
  entries:
    - id: mklab-certh-oil-spill-v1
      provider: "MKLab, CERTH"
      citation: >
        Krestenitis, M. et al. (2019). Oil Spill Identification from Satellite Images
        Using Deep Neural Networks. Remote Sensing, 11(15), 1762.
      licence: "Research use, attribution required"
      access_url: "https://mklab.iti.gr/results/oil-spill-detection-dataset/"
      retrieved_at: "2026-02-14T09:20:00Z"
      sha256: "…"
      real_data: true
      synthetic_content: none
      tiles: 1112
      split: {train: 0.70, val: 0.15, test: 0.15}
      split_strategy: "by scene and geography, never by random tile"
  augmentation:
    permitted: [hflip, vflip, rot90, random_crop, brightness_jitter_10pct, sensor_speckle]
    forbidden: [gan_synthesis, diffusion_synthesis, pasted_slicks, simulated_ais]
  assertion: "no_synthetic_samples"
```

```python
def validate_manifest(m):
    for e in m['entries']:
        for field in ('provider','citation','licence','access_url','retrieved_at','sha256'):
            if not e.get(field):
                raise DataPolicyViolation(f"{e['id']} missing required field: {field}")
        if not e.get('real_data') or e.get('synthetic_content') != 'none':
            raise DataPolicyViolation(f"{e['id']} declares non-real content")
    forbidden = set(m['augmentation']['forbidden'])
    if forbidden & set(m['augmentation']['permitted']):
        raise DataPolicyViolation("forbidden augmentation appears in permitted list")
```

---

## 7.5 M3 — Attribution scoring

### 7.5.1 What the score is and is not

| It is | It is not |
|---|---|
| An **investigative priority ranking** | A probability of legal guilt |
| A weighted combination of measurable spatiotemporal evidence | A determination of responsibility |
| Accompanied by a confidence interval and a measured-feature count | A single authoritative number |
| Renormalised over *measured* features only | Imputed to fill gaps |

### 7.5.2 The model

```python
def score_candidate(features, weights, calibrator=None):
    """Transparent additive model over normalised evidence features.

    Crucially, the denominator sums only the weights of features that were actually
    MEASURED. If we divided by the total weight instead, a vessel with missing data
    would be silently penalised as though every missing feature scored zero — which
    would let data gaps masquerade as exonerating evidence.
    """
    contributions, num, den, measured = [], 0.0, 0.0, 0

    for key, spec in FEATURE_SPECS.items():
        f = features.get(key)
        if f is None or f.value is None:
            contributions.append(Contribution(key, None, spec.unit, None,
                                              weights[key], None, 'MISSING', []))
            continue
        if not spec.applicable(features):
            contributions.append(Contribution(key, f.value, spec.unit, None,
                                              weights[key], None, 'NOT_APPLICABLE', f.refs))
            continue

        n = spec.normalise(f.value)                  # → [0,1]
        w = weights[key]
        num += w * n
        den += w
        measured += 1
        contributions.append(Contribution(key, f.value, spec.unit, n, w,
                                          round(100*w*n, 2), 'MEASURED', f.refs))

    if den == 0 or measured < MIN_MEASURED_FEATURES:      # MIN = 6
        return Score(0.0, (0.0, 0.0), 'INSUFFICIENT_EVIDENCE', contributions,
                     measured, calibrated=False)

    raw = num / den
    final = calibrator.transform(raw) if calibrator else raw
    score = round(100 * final, 1)

    return Score(score, bootstrap_ci(features, weights, calibrator),
                 tier_for(score, measured), contributions, measured,
                 calibrated=calibrator is not None)


def tier_for(score, measured):
    if measured < MIN_MEASURED_FEATURES: return 'INSUFFICIENT_EVIDENCE'
    if score >= 70: return 'STRONG'
    if score >= 50: return 'MODERATE'
    if score >= 30: return 'WEAK'
    return 'INSUFFICIENT_EVIDENCE'
```

### 7.5.3 Confidence intervals, and whether the ranking is real

```python
def bootstrap_ci(features, weights, calibrator, n=500):
    """Propagate the two dominant uncertainty sources into the score.

    1. Drift ensemble spread — resample which ensemble members define the origin field,
       so a wide, uncertain origin zone produces a wide score interval.
    2. AIS interpolation uncertainty — perturb interpolated positions by the observed
       sampling-interval-dependent error.

    Real fixes are never perturbed. Only interpolated positions carry this uncertainty,
    because only they are estimates.
    """
    samples = []
    for _ in range(n):
        f2 = resample_origin_ensemble(features)
        f2 = perturb_interpolated_positions(f2)
        samples.append(score_candidate(f2, weights, calibrator).value)
    return (float(np.percentile(samples, 5)), float(np.percentile(samples, 95)))
```

#### Is the top candidate actually ahead of the second?

A ranked list invites the reader to act on its order, and nothing above tells them whether the
order is real. **Two bootstrap intervals cannot answer this**, for a reason that matters:

`bootstrap_ci` resamples each candidate **independently** — that candidate's own origin-zone
jitter from that candidate's own seed. That is correct for a *marginal* interval on one vessel.
But there is only **one origin zone**, and its uncertainty is **common-mode**: when the release
zone is drawn further north, it moves further north for *every* vessel at once. Comparing two
independently-drawn intervals treats a shared cause as two separate accidents, and answers a
question nobody asked.

So `apps/api/src/modules/attribution/separation.ts` resamples the whole field **together**: one
origin-zone draw per iteration, applied to every candidate in that iteration, recording the
resulting *rank order*. What comes out is the number a reader actually needs —

> in N draws of the evidence, how often does this vessel still come first?

**Positional error stays independent per vessel, deliberately.** An AIS reporting gap on one
ship tells you nothing about the gap on another. The shared term is the physics; the
independent term is the measurement. Conflating them either way would be wrong.

| Output | Meaning |
|---|---|
| `topRankShare[]` | P(this vessel ranks first) across paired draws, descending |
| `leader.winShare` | P(leader outscores the runner-up **in the same draw**) — the decision-relevant number |
| `leader.meanMargin` | Mean score gap across draws. A large win share on a 0.4-point margin is still thin, and both are shown. |
| `leader.distinguishable` | `winShare ≥ DISTINGUISHABLE_WIN_SHARE` |

`DISTINGUISHABLE_WIN_SHARE = 0.9` is **a convention, not a measurement** — the same status as
the twelve feature weights, and labelled as such wherever it is reported. It is set at 0.9 to
match the one-sided reading of the 5th/95th interval already used for scores, so a reader does
not have to hold two different notions of "confident" in their head while reading one dossier.

Only the front of the field is resampled (`SEPARATION_FIELD_SIZE = 10`): ranking beyond it is
not decision-relevant and costs N × iterations. Nothing here re-measures anything — it re-asks
the existing scoring function under drawn inputs, so a separation result can never disagree
with the score it describes.

---

## 7.6 The twelve evidence features

| # | Key | Measures | Unit | Default weight | Normalisation | Rationale |
|---|---|---|---|---|---|---|
| F1 | `spatial_proximity` | Minimum geodesic distance from the vessel track to the origin 90% support polygon | km | **0.18** | `exp(-d / 8)` | The closer a track passes to the reconstructed release zone, the more plausible the vessel. Exponential decay because plausibility falls off sharply, not linearly. |
| F2 | `temporal_alignment` | Overlap between the vessel's presence in the origin zone and the estimated release window | fraction | **0.16** | `overlap / window_duration`, clipped to [0,1] | Being in the right place at the wrong time is not evidence. This is the feature that most distinguishes VARUNA from footprint-proximity systems. |
| F3 | `track_intersection` | Length of track passing inside the 50% origin support | km | **0.13** | `min(len / 5, 1)` | A track that *transits* the origin zone is much stronger evidence than one that merely approaches it. |
| F4 | `heading_alignment` | Angular difference between the vessel's course in the zone and the slick's major-axis bearing | degrees | **0.10** | `cos²(Δ)` for Δ in [0,90] | A slick discharged by a moving vessel is laid down along its course. Alignment is a genuine physical signature — this is standard practice in operational SAR analysis. |
| F5 | `ais_dark_period` | Duration of AIS silence overlapping the release window while in/near the zone | minutes | **0.10** | `min(minutes / 90, 1)` | Deliberate discharge is frequently accompanied by transponder silence. Treating a gap as *positive evidence* rather than missing data is a deliberate and important choice. |
| F6 | `speed_consistency` | Whether the vessel's speed profile is consistent with discharge while underway | 0–1 | **0.08** | Trapezoid peaking over 4–14 kn | Operational discharge typically happens at a steady transit speed, not at anchor or at full speed. |
| F7 | `vessel_type_prior` | Prior from AIS ship-type code | 0–1 | **0.07** | Tanker 1.0, bulk/cargo 0.7, other 0.3, unknown → `MISSING` | A weak prior, weighted low on purpose, and never used to *exclude* a vessel. |
| F8 | `origin_density_at_track` | Value of the origin probability density sampled along the vessel's track | normalised | **0.07** | `density / max_density` | Uses the full probability field rather than a hard contour, so a track through a high-density region scores above one clipping the contour edge. |
| F9 | `draught_change` | Change in reported AIS draught before versus after the window | metres | **0.05** | `min(Δ / 0.5, 1)` | A genuine discharge of volume can change reported draught. Frequently `MISSING` — reported honestly rather than imputed. |
| F10 | `slick_axis_continuity` | Whether the slick's major axis, extended backwards, intersects the track | 0–1 | **0.03** | Binary with a distance tolerance | Geometric corroboration of F4. |
| F11 | `manoeuvre_anomaly` | Unusual course/speed change coincident with the window | 0–1 | **0.02** | Z-score of turn rate versus the vessel's own baseline | Weak, supportive only. |
| F12 | `prior_incident_history` | Prior documented incidents for this MMSI/IMO | count | **0.01** | `min(n / 3, 1)` | Deliberately the lowest weight. Past record must never dominate present evidence. |

**Total: 1.00.** Weights are user-adjustable; any change is recorded in the investigation
and printed in the report.

### 7.6.1 Feature specification code

```python
FEATURE_SPECS = {
  'spatial_proximity': FeatureSpec(
      unit='km', weight=0.18,
      normalise=lambda d: math.exp(-d / 8.0),
      applicable=lambda f: True,
      description='Minimum geodesic distance from the vessel track to the 90% origin support.',
      method_note='METHOD_F1'),

  'temporal_alignment': FeatureSpec(
      unit='fraction', weight=0.16,
      normalise=lambda o: min(max(o, 0.0), 1.0),
      applicable=lambda f: f.get('release_window_status') == 'OK',
      description='Overlap between vessel presence in the origin zone and the estimated release window.',
      method_note='METHOD_F2'),

  'heading_alignment': FeatureSpec(
      unit='degrees', weight=0.10,
      normalise=lambda d: math.cos(math.radians(min(abs(d), 90.0)))**2,
      applicable=lambda f: f.get('elongation_ratio', 0) >= 2.5,   # only meaningful for linear slicks
      description='Angular difference between vessel course in the zone and slick major-axis bearing.',
      method_note='METHOD_F4'),
  # … F3, F5–F12 defined identically
}
```

Note `heading_alignment.applicable`: for a near-circular slick the major axis is not
meaningful, so the feature returns `NOT_APPLICABLE` rather than a noise value. This is the
mechanism that keeps meaningless numbers out of the evidence dossier.

### 7.6.2 Calibration

```python
def fit_calibrator(validated_incidents):
    """Isotonic regression mapping raw scores to observed positive rates.

    Isotonic rather than Platt because we have no reason to assume a sigmoid shape, and
    isotonic only assumes monotonicity — more raw evidence should never mean a lower
    calibrated score.

    Below MIN_CALIBRATION_SAMPLES the identity function is returned and every score is
    flagged UNCALIBRATED in the UI and the report.
    """
    if len(validated_incidents) < MIN_CALIBRATION_SAMPLES:   # 30
        return None
    raw = np.array([i.raw_score for i in validated_incidents])
    y   = np.array([1 if i.was_source else 0 for i in validated_incidents])
    return IsotonicRegression(out_of_bounds='clip').fit(raw, y)
```

### 7.6.3 Evaluation of M3

| Metric | Definition |
|---|---|
| Top-1 / Top-3 / Top-5 containment | Fraction of validated incidents where the true source is ranked in the top-k |
| Mean reciprocal rank | Average of `1/rank_of_true_source` |
| Calibration error (ECE) | Binned difference between calibrated score and observed positive rate |
| Feature ablation | Δ in top-3 containment when each feature is removed — quantifies which evidence actually carries the signal |
| Robustness to degradation | Top-3 containment when drift runs in `DEGRADED` mode, quantifying the value of M2 |
| Abstention rate | Fraction of cases correctly returning `INSUFFICIENT_EVIDENCE` |

The feature-ablation table is published in the report appendix. If a feature contributes
nothing on real validated incidents, it is removed rather than kept for appearance.

---

## 7.7 Model registry and reproducibility

```python
def register_model(path, name, arch, metrics, dataset_manifest_hash, git_sha):
    """Content-addressed model registry.

    The SHA-256 of the weights file is the model's identity. It is written into every
    inference result and every generated report, so any published finding can be traced
    to the exact weights that produced it.
    """
    sha = sha256_file(path)
    key = f"models/{sha}/model.pt"
    s3.upload_file(path, BUCKET, key)
    registry.insert_one({
        '_id': sha, 'name': name, 'architecture': arch, 'key': key,
        'metrics': metrics,                        # on the held-out REAL test split
        'datasetManifestHash': dataset_manifest_hash,
        'gitSha': git_sha,
        'trainedAt': datetime.now(timezone.utc),
        'framework': f'torch=={torch.__version__}',
        'realDataOnly': True,
    })
    return sha
```

**CI evaluation gate:** a model may not be promoted if oil-class IoU on the held-out real
test split falls below the committed threshold, or if the look-alike→oil confusion rate
rises above its threshold. The gate compares against the currently deployed model, so
regressions cannot ship.

---

## 7.8 FastAPI service contract

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/preprocess` | `{ rawKey, sensor, mode, polarisations }` | `{ cogKeys, manifest, crs, gsdMeters, checksum }` |
| POST | `/segment` | `{ cogKeys, modelSha?, minAreaKm2, minProbability }` | `{ polygons[], classCounts, maskKey, probabilityKey, modelSha }` |
| POST | `/vectorise` | `{ maskKey, transform, crs, params }` | `{ polygons[] }` |
| POST | `/backtrack` | `{ polygon, tObs, horizonHours, particleCount, windDriftRange, deflectionRange }` | `{ status, frames[], support50, support90, releaseWindow, forcingProvenance, params }` |
| POST | `/score` | `{ detection, origin, tracks[], weightProfileId }` | `{ candidates[] }` each with features, contributions, CI, tier |
| GET | `/models` | — | Registry listing with metrics |
| GET | `/health` | — | `{ status, gpu, modelLoaded, forcingCacheAge }` |

Every response includes a `provenance` block. Requests require `X-Service-Token`. The
service is never exposed publicly.

---

## 7.9 Known limitations (stated, not hidden)

| Limitation | Effect | How the product handles it |
|---|---|---|
| SAR cannot distinguish oil type or thickness | Volume estimates are not possible from imagery alone | No volume is reported. Area only. |
| Look-alikes cannot be fully eliminated | Some false positives remain | Explicit `look_alike` class, wind gate, confidence terms, mandatory human review before any report is finalised |
| Detection is unreliable outside ~3–10 m/s wind | Some real spills are undetectable | `windSuitability` is computed from real wind data and shown; low-wind detections are flagged |
| Drift models have finite resolution (1/12° currents, 0.25° winds) | Origin error grows with horizon | Ensemble spread makes this visible; error is quantified against known incidents in §9.2 of the PRD |
| AIS coverage is incomplete, especially offshore and for non-cooperative vessels | Some sources are simply absent | `NO_AIS_COVERAGE` is a first-class result; SAR ship detections without AIS are surfaced as dark-vessel candidates |
| Attribution labels are scarce | Calibration is weak initially | Scores are flagged `UNCALIBRATED` until 30+ validated incidents exist |
| The system cannot prove responsibility | — | It never claims to. Tiering, uncertainty and mandatory report language enforce this. |
