"""Classical dark-spot (oil-slick candidate) detection on Sentinel-1 RTC Sigma0.

This is the v1 detector. It is the pre-deep-learning literature standard: adaptive local
thresholding against the sea background, morphological cleanup, connected-component
extraction, then shape/context scoring. It needs no training data, which is why it ships
first; a learned segmentation model (07_AIML 7.2) is the next iteration and would replace
`segment()` alone, leaving the rest of this module intact.

What it does NOT do, stated plainly because it changes how results must be read: it cannot
classify oil versus look-alike from texture the way a trained model can. It finds *dark
features* and scores how oil-like each one's shape and context is. Every detection
therefore carries an explicit `look_alike_risk`, and weak candidates are returned rather
than silently dropped, so an analyst sees what the algorithm saw.

The physics the thresholds rest on: oil damps short capillary and gravity waves, so a slick
returns much less energy than the surrounding sea and appears dark. Low-wind zones,
biogenic films, rain cells and wind shadows do the same thing, which is what look-alikes
are. Below roughly 3 m/s wind the sea itself goes dark and detection is meaningless; above
roughly 12 m/s a slick is re-roughened and disappears. That gate is `wind_suitability()`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage as ndi
from skimage import measure, morphology

MIN_VALID_SIGMA0 = 1e-6

# A feature must be at least this large to report. 0.05 km2 at 10 m/px = 500 px
# (02_TRD 2.8.2, DETECTION_MIN_AREA_KM2).
MIN_AREA_KM2 = 0.05


@dataclass
class DarkSpot:
    """One candidate dark feature, in pixel space plus derived metrics."""

    label: int
    area_px: int
    area_km2: float
    perimeter_km: float
    centroid_rc: tuple[float, float]
    major_axis_km: float
    minor_axis_km: float
    elongation: float
    orientation_deg: float
    convexity: float
    mean_db: float
    background_db: float
    contrast_db: float
    look_alike_risk: float
    confidence: float
    mask: np.ndarray = field(repr=False)


def to_db(sigma0: np.ndarray) -> np.ndarray:
    """Linear Sigma0 to dB, with invalid/zero pixels as NaN rather than -inf."""
    out = np.full(sigma0.shape, np.nan, dtype=np.float32)
    valid = np.isfinite(sigma0) & (sigma0 > MIN_VALID_SIGMA0)
    out[valid] = 10.0 * np.log10(sigma0[valid])
    return out


def land_mask_from_backscatter(db: np.ndarray, threshold_db: float = -8.0) -> np.ndarray:
    """Coarse land / bright-target mask.

    Land and ships backscatter far more strongly than the sea. This stands in for a proper
    GSHHG coastline mask (10_DATASETS 10.7). It is deliberately conservative, removing only
    clearly bright areas, so it cannot erase a dark slick.
    """
    land = np.zeros(db.shape, dtype=bool)
    finite = np.isfinite(db)
    land[finite] = db[finite] > threshold_db
    # Close speckle gaps so a broken coastline becomes one region, then grow slightly: a
    # slick abutting a bright shoreline must not inherit the shoreline's pixels.
    land = morphology.closing(land, morphology.disk(3))
    land = morphology.dilation(land, morphology.disk(5))
    return land


def segment(
    db: np.ndarray,
    valid: np.ndarray,
    contrast_db: float = 3.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Adaptive local threshold: pixels darker than their neighbourhood by `contrast_db`.

    A GLOBAL threshold fails on SAR because mean backscatter varies across a swath with
    incidence angle and wind. Comparing each pixel against a large local median makes the
    test scale-invariant, which is what lets a single threshold work over a whole scene.

    The background field is estimated on a heavily downsampled grid: a true median filter at
    this window size would dominate runtime, and the sea background is smooth by
    construction, so the approximation costs nothing real.
    """
    fill = float(np.nanmedian(db[valid])) if valid.any() else 0.0
    filled = np.where(valid & np.isfinite(db), db, fill)

    step = 32
    small = filled[::step, ::step]
    bg_small = ndi.median_filter(small, size=9, mode="nearest")

    zoom = (filled.shape[0] / bg_small.shape[0], filled.shape[1] / bg_small.shape[1])
    bg = ndi.zoom(bg_small, zoom, order=1)

    # zoom rounding can leave the array a pixel short or long
    bg = bg[: filled.shape[0], : filled.shape[1]]
    if bg.shape != filled.shape:
        bg = np.pad(
            bg,
            ((0, max(0, filled.shape[0] - bg.shape[0])), (0, max(0, filled.shape[1] - bg.shape[1]))),
            mode="edge",
        )

    dark = np.zeros(db.shape, dtype=bool)
    ok = valid & np.isfinite(db)
    dark[ok] = db[ok] < (bg[ok] - contrast_db)
    return dark, bg


def clean(dark: np.ndarray, min_px: int) -> np.ndarray:
    """Morphological cleanup: drop speckle, close interior holes, keep coherent regions.

    Speckle is multiplicative noise inherent to SAR. Without this step every scene yields
    tens of thousands of single-pixel "detections".
    """
    out = morphology.opening(dark, morphology.disk(2))
    out = morphology.closing(out, morphology.disk(4))
    out = morphology.remove_small_objects(out, max_size=min_px)
    out = morphology.remove_small_holes(out, max_size=max(1, min_px // 4))
    return out


def look_alike_risk(
    elongation: float, convexity: float, contrast: float, area_km2: float
) -> float:
    """0 = strongly oil-like, 1 = strongly look-alike.

    Discriminators taken from the SAR oil-spill literature (07_AIML 7.2.2, 09_RESEARCH):
      - real slicks are ELONGATED, drawn out by wind and current shear; low-wind zones and
        rain cells are blobby
      - real slicks have RAGGED, low-convexity boundaries; look-alikes are smoother
      - stronger CONTRAST favours oil, because wave damping by oil is strong
      - very large features are more often meteorological than a discrete release
    """
    r_shape = 1.0 / (1.0 + max(0.0, elongation - 1.0))
    r_convex = float(np.clip((convexity - 0.75) / 0.25, 0, 1))
    r_contrast = float(np.clip((6.0 - contrast) / 4.0, 0, 1))
    r_size = float(np.clip((area_km2 - 40.0) / 60.0, 0, 1))
    return float(
        np.clip(0.35 * r_shape + 0.25 * r_convex + 0.25 * r_contrast + 0.15 * r_size, 0, 1)
    )


def wind_suitability(wind_ms: float | None) -> float:
    """0-1 detectability gate from wind speed (07_AIML 7.2.3).

    Below ~3 m/s the sea is glassy and everything looks like oil; above ~12 m/s a slick is
    re-roughened and vanishes. This is returned separately rather than folded silently into
    the score, so the UI can say WHY confidence is low.
    """
    if wind_ms is None:
        return 0.5  # unknown is not the same as good
    if wind_ms < 2.0 or wind_ms > 14.0:
        return 0.05
    if wind_ms < 3.0 or wind_ms > 12.0:
        return 0.3
    if 4.0 <= wind_ms <= 9.0:
        return 1.0
    return 0.7


def detect(
    sigma0_vv: np.ndarray,
    pixel_size_m: float = 10.0,
    contrast_db: float = 3.0,
    min_area_km2: float = MIN_AREA_KM2,
    wind_ms: float | None = None,
) -> list[DarkSpot]:
    """Run the detector over one Sigma0 VV array. Returns candidates, most confident first."""
    db = to_db(sigma0_vv)
    finite = np.isfinite(db)
    land = land_mask_from_backscatter(db)
    sea = finite & ~land

    if int(sea.sum()) < 1000:
        return []

    px_area_km2 = (pixel_size_m**2) / 1e6
    min_px = max(50, int(min_area_km2 / px_area_km2))

    dark, bg = segment(db, sea, contrast_db=contrast_db)
    dark &= sea
    dark = clean(dark, min_px)

    labels = measure.label(dark, connectivity=2)
    if labels.max() == 0:
        return []

    wind_term = wind_suitability(wind_ms)
    spots: list[DarkSpot] = []

    for region in measure.regionprops(labels):
        if region.area < min_px:
            continue
        comp = labels == region.label
        mean_db = float(np.nanmean(db[comp]))
        back_db = float(np.nanmean(bg[comp]))
        contrast = back_db - mean_db

        area_km2 = region.area * px_area_km2
        major_km = region.axis_major_length * pixel_size_m / 1000.0
        minor_km = max(region.axis_minor_length, 1.0) * pixel_size_m / 1000.0
        elong = major_km / minor_km
        convexity = float(region.area / region.area_convex) if region.area_convex else 1.0
        perimeter_km = region.perimeter * pixel_size_m / 1000.0

        risk = look_alike_risk(elong, convexity, contrast, area_km2)

        # Confidence is built from separable terms so the UI can show WHY it is what it is,
        # rather than presenting one opaque number (07_AIML 7.2.11).
        sep_term = float(np.clip(contrast / 10.0, 0, 1))
        shape_term = 1.0 - risk
        size_term = float(np.clip(area_km2 / 1.0, 0.2, 1.0))
        confidence = float(
            np.clip(
                0.40 * sep_term + 0.35 * shape_term + 0.15 * wind_term + 0.10 * size_term, 0, 1
            )
        )

        spots.append(
            DarkSpot(
                label=int(region.label),
                area_px=int(region.area),
                area_km2=area_km2,
                perimeter_km=perimeter_km,
                centroid_rc=(float(region.centroid[0]), float(region.centroid[1])),
                major_axis_km=major_km,
                minor_axis_km=minor_km,
                elongation=float(elong),
                orientation_deg=float(np.degrees(region.orientation) % 180.0),
                convexity=convexity,
                mean_db=mean_db,
                background_db=back_db,
                contrast_db=float(contrast),
                look_alike_risk=risk,
                confidence=confidence,
                mask=comp,
            )
        )

    spots.sort(key=lambda s: -s.confidence)
    return spots


def to_geojson(
    spots: list[DarkSpot],
    transform,
    crs,
    simplify_m: float = 30.0,
) -> list[dict]:
    """Vectorise each detection into an EPSG:4326 GeoJSON Polygon with its metrics.

    Raster masks are converted to polygons, simplified (the pixel staircase carries no
    information), reprojected to WGS84, and wound right-hand per RFC 7946 so MongoDB does
    not read the ring as its own complement (06_BACKEND 6.3.2).

    Area and perimeter stay as measured on the 10 m grid rather than being recomputed from
    the simplified outline: simplification is for display, not for measurement.
    """
    import rasterio.features
    from rasterio.warp import transform_geom
    from shapely.geometry import shape, mapping
    from shapely.ops import orient

    out: list[dict] = []
    for rank, spot in enumerate(spots):
        shapes = list(
            rasterio.features.shapes(
                spot.mask.astype("uint8"), mask=spot.mask, transform=transform
            )
        )
        if not shapes:
            continue
        # Largest ring wins: `shapes` can emit slivers where the mask touches the window edge
        geom_utm, _ = max(shapes, key=lambda sv: shape(sv[0]).area)
        poly = shape(geom_utm).simplify(simplify_m, preserve_topology=True)
        poly = orient(poly, sign=1.0)  # counter-clockwise exterior = RFC 7946 right-hand rule
        geom_wgs84 = transform_geom(crs, "EPSG:4326", mapping(poly), precision=6)

        out.append(
            {
                "rank": rank,
                "geometry": geom_wgs84,
                "areaKm2": round(spot.area_km2, 4),
                "perimeterKm": round(spot.perimeter_km, 4),
                "morphology": {
                    "majorAxisKm": round(spot.major_axis_km, 4),
                    "minorAxisKm": round(spot.minor_axis_km, 4),
                    "elongationRatio": round(spot.elongation, 3),
                    "orientationDeg": round(spot.orientation_deg, 1),
                    "convexity": round(spot.convexity, 3),
                },
                "backscatter": {
                    "meanDb": round(spot.mean_db, 2),
                    "backgroundDb": round(spot.background_db, 2),
                    "contrastDb": round(spot.contrast_db, 2),
                },
                "lookAlikeRisk": round(spot.look_alike_risk, 3),
                "confidence": round(spot.confidence, 3),
            }
        )
    return out
