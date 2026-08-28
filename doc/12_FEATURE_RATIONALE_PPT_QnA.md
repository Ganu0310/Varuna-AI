# 12 — Feature Rationale & Presentation Q&A

**Product:** VARUNA
**Problem Statement:** SIH26143
**Document version:** 1.0

> **Purpose:** for every feature — how it works, why it exists, and what breaks without it.
> Then the questions judges actually ask, with answers you can give in under ninety seconds.
>
> Read this before the presentation. The pattern that wins is: **state the mechanism,
> state the reason, state the limit.** Never claim more than the evidence supports — the
> product's whole thesis is intellectual honesty, and a presenter who over-claims destroys
> it in one sentence.

---

## Part 1 — Feature rationale

Every feature below follows the same four-part structure.

---

### F-01 · Five-class segmentation (not binary oil/not-oil)

**How it works.** A U-Net-family network classifies every pixel into one of five classes:
sea surface, oil spill, **look-alike**, ship, land. Trained on the MKLab/CERTH Sentinel-1
dataset whose labels derive from EMSA CleanSeaNet verified events.

**Why we use it.** Oil suppresses capillary waves and therefore radar backscatter,
producing a dark patch. But so do low-wind zones, biogenic slicks, rain cells, upwelling
and algal films. A binary model has **no vocabulary** for "this is dark but it is not oil"
— it must force every dark patch into one of two boxes, and the wrong box is a false
alarm that sends an aircraft to the wrong place.

**What breaks without it.** False-positive rate rises sharply. Because look-alikes are the
dominant error mode in the published literature, a binary model would be worse in exactly
the situation that matters.

**The limit.** Look-alike confusion is the unsolved problem in this field. We reduce it; we
do not eliminate it. SkyTruth state the same thing about their own system: SAR alone cannot
definitively identify oil.

---

### F-02 · Full SAR preprocessing chain

**How it works.** Orbit correction → thermal-noise removal → border-noise removal →
radiometric calibration to sigma-nought → Refined Lee speckle filtering → Range-Doppler
terrain correction → dB conversion. Every step is recorded in a processing manifest.

**Why we use it.** Each step removes a specific, known artefact:

| Step | The artefact it removes | What happens if you skip it |
|---|---|---|
| Orbit file | Geolocation error | Slick polygons are offset by tens of metres — and every distance in the attribution model inherits that error |
| Thermal noise | Additive sensor noise | Noise **dominates low-backscatter regions** — which is precisely where oil lives. Skipping this corrupts the target signal specifically. |
| Border noise | Invalid edge pixels | The scene edge looks like an enormous dark slick |
| Calibration | Sensor-dependent digital numbers | Scenes are not comparable to each other or to the training data |
| Speckle filter | Multiplicative speckle | The network learns speckle patterns instead of oil |
| Terrain correction | Geometric distortion | Pixels do not correspond to true ground coordinates |

**What breaks without it.** The single worst is thermal noise: it degrades the exact
signal we are trying to detect.

**The limit.** Processing takes about 10 minutes per scene. Microsoft Planetary Computer's
Sentinel-1 RTC products have steps 1–6 already applied, which is why we prefer that route.

---

### F-03 · Cosine-window tiled inference

**How it works.** A Sentinel-1 scene is far too large for one forward pass, so we tile it
into 256×256 patches with 25% overlap. Rather than averaging the overlaps, each tile's
prediction is weighted by a 2D Hann (cosine) window before summation.

**Why we use it.** A pixel at a tile edge was seen by the network with only half the
surrounding context of a pixel at the tile centre. Simple averaging treats those two
predictions as equally reliable, producing a visible grid of seams — and seams cross
slicks, fragmenting a single polygon into pieces.

**What breaks without it.** Seam artefacts fragment slicks. A fragmented slick produces
wrong morphology, wrong area, and a wrong drift seed. The error propagates all the way to
the ranking.

**Presentation note.** This is a small, concrete engineering detail that demonstrates
real implementation depth. Worth mentioning if asked "what was technically hard?"

---

### F-04 · Geodesic area and distance (never degrees)

**How it works.** Areas are computed on the WGS84 ellipsoid via `pyproj.Geod`; distances
via great-circle or ellipsoidal methods in Turf/pyproj; intersections on a locally
appropriate equal-area projection.

**Why we use it.** One degree of longitude is about 111 km at the equator and about 0 km at
the poles. Computing an area in square degrees produces a number that varies with latitude
and means nothing physically.

**What breaks without it.** Every area, distance and proximity score becomes
latitude-dependent nonsense — and the errors are subtle enough to go unnoticed until someone
checks.

**How we prevent regressions.** A known-answer test suite runs in CI on both the JavaScript
and Python paths and requires them to agree within 0.1%.

---

### F-05 · Backward Lagrangian drift — the core differentiator ⭐

**How it works.** Five thousand particles are seeded uniformly inside the detected slick
polygon and integrated **backwards** in time over real CMEMS surface currents and real
ERA5/GFS 10 m winds:

```
u_particle = u_current + α · R(θ) · u_wind
```

with `α ~ Uniform(0.02, 0.04)` (the empirical wind-drift factor) and `θ ~ Uniform(0°, 20°)`
(Ekman/Coriolis deflection) **sampled per particle**, plus a horizontal diffusion term. The
resulting cloud is kernel-density-estimated into an **origin probability surface** with 50%
and 90% support contours.

**Why we use it.** *The observed slick is not where the oil was released.* Over a typical
6–24 hour interval between release and satellite overpass, the slick is transported by
currents and pushed by wind. Correlating vessels against the *observed* footprint
systematically favours vessels that happened to be downstream — and systematically excludes
the actual source.

**Why the parameters are sampled rather than fixed.** The 2–4% wind-drift factor is a
*range* because it is genuinely uncertain — it depends on oil properties, sea state and
emulsification. Fixing it at 3% would produce a single confident-looking origin point that
hides that uncertainty. Sampling propagates the uncertainty into the ensemble spread, which
becomes a visible probability field and a wider confidence interval on every downstream
score.

**What breaks without it.** You get proximity-to-footprint, which is what most comparable
systems do — and it is measurably wrong as elapsed time grows.

**The limit.** Current fields are 1/12° (~8 km) and winds 0.25° (~28 km). Origin error
grows with the back-track horizon. We commit to measuring this: target median origin
centroid error ≤ 12 km at a 24 h horizon, against known release points.

**This is the single most important thing to explain in the presentation.**

---

### F-06 · Release-time window estimation

**How it works.**

```
elapsed_estimate = slick_major_axis_length / median_drift_speed
window = [t_obs − 1.5 × elapsed,  t_obs − 0.4 × elapsed]
```

further bounded below by the acquisition time of the most recent prior scene over the same
footprint in which **no** slick was detected.

**Why we use it.** A satellite gives one timestamp: when the slick was *seen*. The release
happened at some unknown earlier time. A system that treats detection time as release time
will score the wrong vessels highly. And the physical basis is real: a slick released by a
moving vessel is stretched along the drift direction, so its length divided by drift speed
estimates elapsed time.

**Why the prior-scene bound matters.** It is the only part of the estimate that comes from
*observation* rather than *modelling*. If Sentinel-1 saw clean water at 06:00 and a slick at
18:00, the release was after 06:00 — no model required. That hard bound often narrows the
window dramatically and it is the most defensible element of the estimate.

**What breaks without it.** Temporal evidence becomes a fixed window around the image, which
cannot discriminate between a vessel that transited 40 minutes before the overpass and one
that transited 20 hours before.

**The limit.** Where drift speed is very low the window becomes uninformative. We return
`status: WIDE` and say so rather than producing a falsely narrow interval.

---

### F-07 · Origin probability field (not an origin point)

**How it works.** Gaussian KDE over the back-tracked particle cloud, exported as a
georeferenced raster and contoured to 50% and 90% support polygons.

**Why we use it.** A single "most likely origin point" is false precision. What the physics
supports is a probability density. Rendering a point would invite an analyst to treat a
15 km uncertainty as a 15 m certainty.

**What breaks without it.** Over-confidence. And the downstream scoring loses its most
informative input — feature F8 samples the density *along* a track, which is more
discriminating than a binary in/out test against a hard contour.

---

### F-08 · MongoDB time-series collections for AIS

**How it works.** `ais_positions` is created as a time-series collection with
`timeField: 't'`, `metaField: 'meta'` (containing `mmsi`), granularity `seconds`, plus a
compound `{meta.mmsi, t}` index and a `2dsphere` index on position.

**Why we use it.** AIS is by far the highest-cardinality data in the system — a busy strait
generates tens of millions of positions per month. Time-series collections bucket documents
by metadata and time, giving order-of-magnitude storage reduction and much faster range
scans. `mmsi` **must** be the `metaField` because every query we run is "this vessel, this
time range" or "this box, this time range".

**What breaks without it.** At 10⁸ documents a standard collection makes the envelope query
too slow for interactive use, and storage costs multiply.

**Presentation note.** If a judge asks why MongoDB rather than PostGIS, this is the honest
answer to lead with: MongoDB genuinely wins on AIS time-series, and we compensate for its
geometry gaps explicitly (see F-09).

---

### F-09 · The Turf.js / Shapely compensation layer ⭐

**How it works.** MongoDB performs the **coarse spatial filter** — `$geoWithin`,
`$geoIntersects`, `$geoNear` against a `2dsphere` index — reducing millions of rows to
hundreds. Exact geometry is then computed in **Turf.js** (Node) and **Shapely/pyproj**
(Python), and the results are **written back** into MongoDB as derived, indexed GeoJSON so
subsequent queries are again index-accelerated.

**Why we use it.** MongoDB is not PostGIS. It has no `ST_Distance` to a polygon edge, no
`ST_Buffer`, no `ST_ClosestPoint`, no geodesic `ST_Area`, no `ST_Union`, no spatial joins.
The MERN mandate is real, so rather than pretending the gap does not exist, we identified
each missing function and assigned it an explicit home.

**The specific danger this avoids.** Without `ST_Distance` to a polygon edge, the tempting
shortcut is centroid distance. For a large slick, centroid distance **overstates** proximity
for a vessel near the far edge and understates it for one near the near edge — a direct
source of false attribution. `turf.pointToLineDistance` and
`turf.nearestPointOnLine` give the correct answer.

**What breaks without it.** Silently wrong distances. Not crashes — wrong numbers that look
plausible, which is the worst failure mode this system can have.

**Presentation note.** This is the strongest answer to "how did you handle MERN's
geospatial limitations?" — it demonstrates you *knew* the limitation rather than
discovering it late.

---

### F-10 · Polygon winding validation

**How it works.** Every polygon is passed through `@turf/rewind` on write to enforce
right-hand-rule winding, and a Mongoose validator rejects incorrectly wound rings.

**Why we use it.** MongoDB interprets a wrongly-wound `2dsphere` polygon as its
**complement** — the entire globe minus the intended area. A `$geoWithin` query against
such a polygon matches nearly every AIS position on Earth.

**What breaks without it.** Your search envelope silently becomes "the whole planet," you
get 40 million candidate positions instead of 400, and the bug looks like a performance
problem rather than a correctness problem.

**Presentation note.** A specific, real, non-obvious bug class. Excellent material if asked
"what nearly went wrong?"

---

### F-11 · Gap-aware track reconstruction

**How it works.** Positions are sorted per MMSI; a kinematic gate removes fixes implying
impossible speeds (>45 kn between consecutive fixes); the remainder is segmented wherever
the interval exceeds 20 minutes. Each gap is recorded with duration, entry and exit points,
straight-line distance and implied speed. Quality flags are attached: `AIS_GAP`,
`POSITION_JUMP`, `MMSI_INVALID`, `MMSI_DUPLICATE`, `STATIC_MISMATCH`, `LOW_SAMPLING`.

**Why we use it.** AIS is not a clean time series. It has dropouts, duplicate MMSIs,
spoofed identities and transmission errors. Naively connecting consecutive fixes draws a
straight line across a two-hour gap, and that fabricated line then gets scored as though it
were observed evidence.

**What breaks without it.** The attribution model scores invented track geometry. And the
outlier count is itself informative — a vessel with 41 removed outliers is telling you
something about its AIS integrity.

**The design principle.** Removed outliers are **counted and surfaced**, never silently
dropped.

---

### F-12 · AIS dark period as *positive* evidence ⭐

**How it works.** A gap in AIS transmission that overlaps the estimated release window,
while the vessel was in or near the origin zone, is scored as feature **F5** with weight
0.10 — normalised as `min(duration_minutes / 90, 1)`.

**Why we use it.** Deliberate discharge is frequently accompanied by transponder silence.
Most pipelines treat a gap as *missing data* — a reason to score the vessel lower. That is
backwards. In this specific context, a gap at that specific place and time is a
**behavioural signal**.

**What breaks without it.** The system is easiest to evade for the most deliberate
offenders, which inverts its purpose.

**The limit.** AIS gaps have innocent causes: equipment failure, terrestrial receiver
coverage holes, satellite AIS revisit gaps. The weight is 0.10 — meaningful, not
dominant — and the UI always shows the raw duration alongside the contribution so an analyst
can judge for themselves.

---

### F-13 · Twelve evidence features across four families

**How it works.** Twelve features spanning **spatial** (F1, F3, F8), **temporal** (F2),
**kinematic** (F4, F6, F10, F11) and **behavioural/identity** (F5, F7, F9, F12) evidence.
Each has a defined unit, a normalisation curve, a weight, and a click-through to the source
records.

**Why we use it — and why four *families* specifically.** Features within a family are
correlated; features across families are more nearly independent. A vessel that scores
highly on spatial evidence alone might simply have been passing through. A vessel that
scores highly across *all four* families is a genuinely different proposition. The
family structure is why the `measuredFeatureCount` floor is meaningful.

**What breaks without it.** With three geometric metrics you cannot distinguish "close to
the slick" from "plausibly responsible for the slick."

---

### F-14 · Renormalisation over measured features only ⭐

**How it works.**

```
score = 100 × calibrate( Σ(w_k · f_k) / Σ(w_k) )    ← both sums over MEASURED features only
```

**Why we use it.** If the denominator were the *total* weight, a vessel with missing data
would score as though every missing feature had scored zero. Missing draught data would then
act as *exonerating evidence*. That is not merely wrong; it is exploitable — a vessel that
broadcasts less would be scored lower.

**What breaks without it.** Data gaps masquerade as evidence of innocence.

**The safeguard.** A hard floor: fewer than 6 measured features forces
`INSUFFICIENT_EVIDENCE` regardless of the computed score. Renormalisation prevents
*penalising* absence; the floor prevents *rewarding* it.

**Presentation note.** If you explain only one thing about the scoring model, explain this.
It demonstrates that the team thought about how the model could be wrong.

---

### F-15 · `NOT_MEASURED` rows are rendered, not hidden

**How it works.** The evidence waterfall displays every one of the twelve features. Those
that could not be measured appear with a hatched bar, a `NOT MEASURED` token, and the
reason.

**Why we use it.** Hiding unmeasured features would make the evidence base look more
complete than it is. An analyst seeing seven solid bars would reasonably assume seven was
all there was.

**What breaks without it.** The dossier misrepresents the strength of its own evidence — the
central failure mode for an investigative tool.

---

### F-16 · Explicit `INSUFFICIENT_EVIDENCE` outcome

**How it works.** A first-class tier, triggered by fewer than 6 measured features, a top
score below 30, or a degenerate score distribution. When triggered, the UI leads with an
explanatory panel *instead of* a ranking.

**Why we use it.** A ranking always produces a number one. Presenting a rank-1 vessel when
the evidence cannot support any conclusion is how a tool like this causes real harm.

**What breaks without it.** The system always points at somebody.

**Presentation note.** Demonstrating this outcome is more persuasive than demonstrating a
confident ranking, because it shows the guardrails are real.

---

### F-17 · Wind-suitability gate on detections

**How it works.** Real ERA5/GFS 10 m wind speed at the acquisition time and location is
converted to a suitability factor: 0 below ~1.5 m/s, ramping to 1.0 across 3–10 m/s, then
falling to 0 by ~14 m/s. It is one of the four terms in the detection confidence.

**Why we use it.** SAR oil detection has a **physical** wind window. Below ~3 m/s the whole
sea surface is smooth and oil is indistinguishable. Above ~10–12 m/s wind mixes and disperses
the slick and the contrast collapses. A network can be confidently wrong in both regimes.

**What breaks without it.** A detection made at 1.8 m/s presents with the same confidence as
one at 6 m/s, when the first is physically unreliable.

**Presentation note.** This is the clearest demonstration in the whole system that the team
understands the *physics* and not just the machine learning. Judges notice.

---

### F-18 · Four-term detection confidence (not one number)

**How it works.** Model probability, look-alike separation, wind suitability and shape
plausibility are combined into an overall figure — **and all four are displayed
individually**.

**Why we use it.** A single blended number hides *which* factor is limiting. "Confidence
0.62" is not actionable. "Model 0.88, separation 0.71, **wind 0.20**, shape 0.65" tells the
analyst immediately that the problem is sensing conditions, not the model.

---

### F-19 · Slick morphology as evidence

**How it works.** Minimum rotated rectangle gives the major and minor axes; PCA gives the
orientation bearing; the elongation ratio and convexity are computed on an equal-area
projection.

**Why we use it.** Shape is diagnostic. A slick released by a **moving** vessel is
characteristically long, narrow and linear, and its major-axis bearing approximates the
vessel's course at the moment of discharge. A slick from a **stationary** source — platform,
seep, anchored vessel — is more isotropic. This feeds features F4 (heading alignment) and F10
(axis continuity), and it feeds the release-time estimate through the major-axis length.

**What breaks without it.** You lose the only evidence linking slick geometry to vessel
*heading*, which is one of the more compelling correlations to show visually.

**The limit.** `heading_alignment` returns `NOT_APPLICABLE` when the elongation ratio is
below 2.5, because the major axis of a near-circular slick is not meaningful.

---

### F-20 · Bootstrap confidence intervals

**How it works.** 500 bootstrap iterations resample which drift-ensemble members define the
origin field and perturb *interpolated* AIS positions by their sampling-interval-dependent
error. The 5th and 95th percentiles become the score interval.

**Why we use it.** A score of 71 with an interval of ±3 and a score of 71 with an interval
of ±22 warrant entirely different responses. Without the interval both display as "71".

**The design detail.** **Real AIS fixes are never perturbed.** Only interpolated positions
carry this uncertainty, because only they are estimates.

---

### F-21 · Interpolation guardrail

**How it works.** `positionAt()` returns `null` — the vessel is simply not drawn — when the
requested time falls inside a gap longer than 20 minutes. Interpolated markers render at 70%
opacity with a hollow centre; real fixes render solid.

**Why we use it.** Drawing a vessel at a position derived by interpolating across a two-hour
gap is fabricating an observation, and it would be indistinguishable on screen from real
data.

**What breaks without it.** The map shows invented positions. Under the real-data policy
that is not a bug, it is a policy violation.

---

### F-22 · Provenance as a required schema field ⭐

**How it works.** Every observed or derived document has a required `provenance`
sub-document (source type, provider, dataset ID, external ID, retrieval timestamp, licence,
checksum, parent lineage). A Mongoose `pre('validate')` hook rejects saves without it. The
API serialiser strips and alerts on unprovenanced objects. The React `<DataObject>` boundary
renders a red `PROVENANCE MISSING` panel instead of the data.

**Why we use it.** The no-fake-data commitment cannot be a promise in a document — it has to
be a structural constraint that makes violation impossible rather than merely discouraged.
There is no `MOCK` or `SYNTHETIC` member of the `sourceType` enum.

**What breaks without it.** The policy becomes an aspiration, and a single well-meaning
placeholder during a late-night debugging session ships to the demo.

**Presentation note.** This is the answer to "how do we know your demo isn't faked?" Open
the provenance inspector on any object on screen: provider, dataset, exact product
identifier, retrieval timestamp, licence, checksum.

---

### F-23 · Persistent map instance

**How it works.** One MapLibre instance is mounted at the app root and never unmounts.
Route changes swap the panels around it.

**Why we use it.** Remounting a map on every navigation re-fetches tiles, resets the camera
and re-uploads GPU buffers — a visible stall and wasted bandwidth on every screen change.

---

### F-24 · The animation channel (60 Hz outside React)

**How it works.** During timeline playback the time cursor is written to a plain mutable
object read inside a `requestAnimationFrame` loop that calls `overlay.setProps()` directly.
The React store is synchronised at only 4 Hz, for panels that display the time as text.

**Why we use it.** At 300× playback every vessel marker moves every frame. Routing that
through React state would re-render the component tree 60 times per second.

**What breaks without it.** The map drops to single-digit frame rates during exactly the
interaction that makes the correlation intuitive.

**The measured difference.** ~55 fps versus ~6 fps at 250k points.

---

### F-25 · Binary AIS transfer

**How it works.** Tracks are transferred as a packed binary buffer, decoded in a Web Worker
into `Float64Array`/`Float32Array`, and handed to deck.gl as binary attributes with zero
per-point object allocation.

**Why we use it.** 250,000 AIS positions as JSON objects is roughly 60 MB of text and
250,000 JavaScript objects for the garbage collector to manage. As a typed array it is about
6 MB and one allocation.

---

### F-26 · Cloud-Optimised GeoTIFF + TiTiler

**How it works.** Scenes are stored as COGs with internal tiling and overviews. TiTiler
renders XYZ map tiles from them on demand via HTTP range requests.

**Why we use it.** Three benefits from one decision: the browser never downloads the
gigabyte-scale scene; inference reads only the windows it needs; and the map displays the
**real raster** rather than a pre-rendered screenshot.

**Presentation note.** "The imagery you are looking at is being read from the actual
Sentinel-1 product, tile by tile" is a strong, checkable statement.

---

### F-27 · Space-time prism (3D)

**How it works.** A deck.gl 3D view where X/Y are geography and **Z is time**. Vessel tracks
become helices; origin probability frames become stacked translucent slices. A track passing
*through* a bright slice is compelling evidence.

**Why we use it.** The hardest idea to convey is that space and time are *both* constraints.
In 2D, a vessel that was in the right place at the wrong time looks identical to one that
was there at the right time. In the prism it is obvious: the helix passes through the same
column at a different height.

**Why it is not decoration.** Every axis encodes data. It passes the test in
[04_UIUX §4.6](04_UIUX_Design_System.md): any 3D element that cannot answer "what does this
let the user understand?" is cut.

---

### F-28 · Slick relief (3D terrain)

**How it works.** Calibrated sigma-nought is encoded as a `raster-dem` tile source and
rendered as MapLibre 3D terrain with user-controlled vertical exaggeration.

**Why we use it.** SAR backscatter is a *quantitative* surface. A flat greyscale image
discards the viewer's ability to judge gradient. Extruded, the dampening signature of oil —
a smooth depression in an otherwise textured sea — becomes immediately visible.

**The honesty guardrail.** A permanent, non-dismissible caption reads: *"Vertical
exaggeration 12× — relief encodes SAR backscatter (σ⁰ dB), not sea-surface height."* Without
it a viewer would reasonably believe they are seeing wave height.

---

### F-29 · Typography system

**How it works.** Three families: **Space Grotesk** (display), **IBM Plex Sans** (UI),
**IBM Plex Mono** (all identifiers, coordinates, timestamps and measurements). Tabular
numerals everywhere numeric. Coordinates to 5 decimal places with explicit hemisphere
letters. All timestamps as `2023-08-14 06:12:47 Z`.

**Why we use it.** These are not aesthetic preferences, they are error-prevention measures:

| Rule | The error it prevents |
|---|---|
| Mono for identifiers | MMSI and IMO numbers are read character by character; proportional digits invite transcription errors |
| Tabular numerals | A score changing 71→68 must not shift the layout |
| Hemisphere letters, not signs | Sign-based coordinates are a classic transcription error |
| Explicit `Z` on every timestamp | Timezone ambiguity directly corrupts spatiotemporal correlation |
| Units always rendered | Unit assumptions are how attribution goes wrong |

---

### F-30 · Four-channel confidence encoding

**How it works.** Confidence is conveyed by **position** (rank), **label** (the tier token),
**numeric interval** (`71 ±6`), and only then **colour**.

**Why we use it.** Colour alone fails colour-blind users and fails WCAG. In a
safety-relevant tool that is unacceptable. Colour is the fourth channel, never the first.

---

### F-31 · Immutable model output with versioned review

**How it works.** Analyst corrections create a **new version**. The original model output is
never overwritten. Every transition records actor, timestamp and reason.

**Why we use it.** Two reasons: an evidence trail must show what the system said *before*
human intervention; and the correction itself is real labelled training data.

---

### F-32 · Mandatory report sections

**How it works.** `Uncertainty & Limitations` and `Data Provenance` cannot be deselected.
The API rejects a generation request that omits them.

**Why we use it.** A report that omits its own limitations is worse than no report — it
transfers unwarranted confidence to whoever reads it. Making this an API-level constraint
rather than a UI default means it cannot be worked around.

---

### F-33 · Playwright-rendered PDF

**How it works.** A dedicated `/report` route renders the same React components in light
theme; headless Chromium converts it to PDF once `data-report-ready="true"` is set.

**Why we use it.** The report's evidence visualisations and typography are identical to what
the analyst reviewed on screen. A separately-built PDF template would inevitably drift.

---

### F-34 · Reproducible run manifest

**How it works.** Every run records scene product IDs, model artefact SHA-256, all
parameters, data-source versions, weight profile hash, and the git SHA.

**Why we use it.** A finding that cannot be reproduced cannot be defended. Content-addressing
the model means any published result traces to the exact weights that produced it.

---

### F-35 · Provider chains with `UNAVAILABLE` semantics

**How it works.** Each data type has a priority-ordered provider chain with a circuit
breaker. A provider *failure* advances the chain; a provider returning *no results* does
**not** — an empty result is a real answer. Chain exhaustion returns a structured error that
states the **consequence**.

**Why we use it.** Free services have downtime and quotas. But the fallback must never be
fabrication, and the error must tell the analyst what the degradation means, not just that
it happened.

---

## Part 2 — Presentation Q&A

### Category A — Scope and ethics

> **"Are you saying this vessel caused the spill?"**

No, and the system is built to make that claim impossible. We produce an *investigative
priority score* with an explicit tier and a confidence interval. The copy under a `STRONG`
result reads "Highest investigative priority. This is not a determination of
responsibility," and that sentence is in the component, not a dismissible banner. Every
export carries a mandatory uncertainty section. The product ranks; humans decide.

> **"What if someone uses this to accuse an innocent ship?"**

That is the primary risk we designed against. Four safeguards: `INSUFFICIENT_EVIDENCE` is a
first-class outcome that suppresses the ranking entirely; every score carries a confidence
interval; every factor drills down to the source records so a claim can be checked rather
than trusted; and unmeasured features are displayed rather than hidden, so the evidence base
never looks stronger than it is. We cannot prevent misuse, but we can refuse to make
over-claiming easy.

> **"Isn't this already solved by EMSA?"**

EMSA CleanSeaNet is excellent and has been operational since 2007 — we are not claiming to
beat it. Two gaps: it is restricted to EU member-state authorities, so most of the world
including India has no equivalent; and its attribution step is expert operator judgement,
which is real expertise but is not parameterised, calibrated, auditable feature-by-feature,
or scalable beyond roughly 3,000 images a year. We are building the reproducible, open
version of that reasoning step.

---

### Category B — Technical depth

> **"Why MongoDB instead of PostGIS? PostGIS is better for this."**

For geometry functions, yes — and we say so explicitly in our TRD. MERN was the mandate, and
rather than pretend the gap does not exist we enumerated every missing function and assigned
it a home. MongoDB does the coarse spatial filter, which it does genuinely well and where it
actually beats PostGIS: AIS is our highest-cardinality data, and MongoDB time-series
collections give order-of-magnitude storage and scan improvements at 10⁸ documents. Exact
geometry — buffering, point-to-polygon-edge distance, geodesic area, nearest-point-on-line —
runs in Turf.js and Shapely and is written back as indexed GeoJSON. There is a known-answer
geodesy test suite in CI requiring both stacks to agree within 0.1%.

> **"Why is there a Python service? That's not MERN."**

MongoDB, Express, React and Node own the product: auth, RBAC, orchestration, persistence,
API, realtime, reporting. Python is a compute sidecar behind an internal HTTP boundary — the
same pattern as calling an image-processing service. It exists because rasterio, GDAL,
Shapely and OpenDrift have no Node equivalent. Reimplementing them would have been the
single largest source of correctness bugs in the project. Choosing the right tool for
raster geodesy is engineering judgement, not a deviation from the stack.

> **"How accurate is your model?"**

Our MVP targets are oil-class IoU ≥ 0.55 and Dice ≥ 0.70, measured on a held-out real test
split. Those targets are anchored to published benchmarks on the same five-class Sentinel-1
dataset, where mean IoU sits in the mid-60s and the look-alike class is the hardest. If we
claimed 0.95 you should be sceptical — this is a hard problem and the published state of the
art says so. We also split by scene and geography, never by random tile, because random tile
splitting leaks overlapping views of the same slick into train and test and inflates
metrics.

> **"What's genuinely novel here?"**

The origin reconstruction layer. Comparable systems, including SkyTruth's Cerulean, anchor
attribution on the observed slick — Cerulean specifically uses the slick head, with a fixed
−8 h/+6 h AIS window. We run backward Lagrangian transport over real currents and winds to
estimate where the oil *started* and when, producing a probability field and a release-time
window. Then twelve evidence features instead of three geometric metrics, with per-feature
drill-down. Physics for the origin, transparent modelling for the evidence.

> **"How do you handle look-alikes?"**

Four ways. An explicit `look_alike` class in the segmentation, so the model has vocabulary
for "dark but not oil". Cross-polarisation input (VV, VH and their ratio) rather than VV
alone. A wind-suitability gate computed from real ERA5 wind — SAR oil detection only works
between roughly 3 and 10 m/s, and outside that window we flag the detection as unreliable
regardless of model confidence. And mandatory human review before any dossier is finalised.
We reduce look-alike confusion; we do not claim to eliminate it, and neither does anyone
else.

> **"What was the hardest technical problem?"**

Three candidates. Polygon winding: MongoDB treats a wrongly-wound polygon as its complement,
so a `$geoWithin` against it matches nearly every position on Earth — it presents as a
performance problem and is actually a correctness catastrophe. Keeping the map at 60 fps
with 250k animated AIS points, solved by moving the animation loop outside React entirely
and transferring positions as binary typed arrays. And getting the drift back-tracking
uncertainty to propagate honestly instead of collapsing into a falsely precise point.

---

### Category C — Data

> **"Is your demo using real data, or is it mocked?"**

Entirely real, and it is checkable live. Every object on screen has a provenance record —
provider, dataset ID, exact product identifier, retrieval timestamp, licence and checksum —
and there is a provenance inspector you can open on anything. There is no `MOCK` or
`SYNTHETIC` value in the source-type enum; an object without provenance fails schema
validation and the UI renders a red error block instead of the data. If you would like, we
can run the catalogue search live against a date you choose.

> **"Where does your training data come from?"**

The MKLab/CERTH Oil Spill Detection Dataset — roughly 1,100 annotated Sentinel-1 patches
across those same five classes, with labels derived from EMSA CleanSeaNet *verified* events,
published with the Krestenitis et al. 2019 paper in Remote Sensing. Real satellite
acquisitions, real expert annotations.

> **"Did you generate synthetic training data to handle class imbalance?"**

No. Oil is under 2% of pixels, and the standard shortcut is to synthesise slicks or paste
them onto real sea backgrounds. We handle imbalance with loss weighting — combined Dice and
Focal loss with inverse-frequency class weights — and sampling of real tiles. Our
augmentation is limited to label-preserving transforms of real imagery: flips, rotations,
crops, and radiometric jitter within observed calibration variance. That is re-sampling
reality. GAN or diffusion synthesis is explicitly forbidden in our dataset manifest, and the
training pipeline refuses to start if the manifest declares any non-real content.

> **"What happens when the data isn't available?"**

Every module has an explicit `UNAVAILABLE` or `DEGRADED` state that propagates to the UI and
into the PDF. If current data is missing we fall back to footprint proximity, label it, and
widen every downstream confidence interval — we do not adjust tier thresholds to compensate,
so a degraded run genuinely produces fewer `STRONG` results. If there is no AIS coverage we
return `NO_AIS_COVERAGE` and list every source queried with its coverage window. No failure
path produces a plausible-looking wrong number.

> **"How much does this cost to run?"**

The entire MVP is free. Sentinel-1 and Sentinel-2 from Copernicus, currents from CMEMS,
winds from ERA5, AIS from NOAA Marine Cadastre and the Danish Maritime Authority — all
open government or ESA data. Local MongoDB, Redis and MinIO. A small hosted deployment is
single-digit dollars a month. That is a direct consequence of building on open data, and it
matters for deployability in exactly the places that currently have no CleanSeaNet.

---

### Category D — Product and deployment

> **"Who actually uses this?"**

Four roles, in priority order: a Coast Guard pollution response officer deciding within 90
minutes whether to launch an aircraft; an environmental analyst building a case file weeks
later who needs defensibility over speed; a port authority duty officer monitoring a
standing area; and a researcher validating the detection model. The first two have opposite
needs — speed versus completeness — which is why the workspace surfaces a ranked shortlist
immediately but keeps every source record one click away.

> **"How does this apply to India specifically?"**

The components already exist here and are not joined up. ISRO's EOS-04 provides C-band SAR;
INCOIS runs an operational oil spill trajectory model and publishes Indian Ocean currents;
the Indian Coast Guard operates under the NOS-DCP. What is missing is the integrating
attribution layer. VARUNA is designed to consume INCOIS currents and ISRO SAR alongside
Copernicus data. For the MVP we use Sentinel-1 because it has an automatable API and a
matching public labelled dataset — that is a tooling decision, and we state it as one.

> **"Why isn't this real-time?"**

It can be for monitoring — Phase 2 adds standing AOI monitoring with automatic ingest and
alerting, and Sentinel-1 imagery is typically available within 6–12 hours of overpass. But
attribution is inherently retrospective: you need AIS covering a release window that ended
before the satellite saw anything, and free AIS archives themselves carry latency. Building
for investigation first and monitoring second reflects what the problem actually is.

> **"What would you build next with more time?"**

Three things in order. Calibration against a larger validated-incident set, so scores stop
being labelled `UNCALIBRATED`. Optical–SAR fusion for look-alike disambiguation, since a
true slick often shows a sheen signature that a low-wind zone does not. And multi-scene
temporal tracking — following the same slick across consecutive overpasses, which would
constrain the drift model far more tightly than a single observation can.

---

## Part 3 — Presentation discipline

| Do | Don't |
|---|---|
| Say "investigative priority" | Say "the guilty vessel" |
| Give ranges: "IoU around 0.55–0.65" | Give false precision: "94.7% accurate" |
| Name the limitation before you are asked | Wait to be caught |
| Show the `INSUFFICIENT_EVIDENCE` case | Only show the clean success |
| Open the provenance inspector unprompted | Assert "it's all real data" |
| Say "Cerulean does global monitoring better than we do" | Pretend you have no competitors |
| Say "we don't know yet, we'd measure it this way" | Guess a number |

**The closing line:**

> Detection is solved. Attribution is not. We built the layer that gets from a detected
> slick to a defensible shortlist — with the physics of drift accounted for, the
> uncertainty quantified, and every number traceable to a source record.
