"""Geometric coastline mask.

`land_mask_from_backscatter` in :mod:`darkspot` removes land by brightness, which works
because land generally backscatters far more strongly than the sea. Generally is doing a lot
of work in that sentence. Wet asphalt, airport runways, calm inland water, dry lake beds,
tidal flats and freshly-ploughed fields are all *dark* in C-band, all pass a brightness test
as sea, and all have the compact-to-elongated shapes the dark-spot detector is looking for.
That is the mechanism by which a car park becomes a slick.

Brightness cannot fix this, because the failure is that the feature is genuinely dark. Only
knowing where the coast is fixes it. So this module rasterises a real coastline onto the
scene grid and the two masks are unioned: backscatter catches ships and bright targets the
vector data does not know about, geometry catches dark land the brightness test waves
through.

**The buffer grows the land, and that direction is deliberate.** Vector coastlines do not
agree with a 10 m SAR pixel — Natural Earth 10 m resolves to a few hundred metres, tides
move the line daily, and the scene's own geolocation has error of its own. Somebody has to
absorb that disagreement. Growing the land loses a strip of genuinely coastal water and with
it any slick inside that strip; growing the sea admits land pixels as candidates. The first
is a false negative the analyst can see and account for — the mask is reported, and it is
returned as coverage numbers rather than silently applied. The second is a false positive
that discredits every other detection in the scene. Near-shore recall is the cheaper thing
to spend, so the buffer only ever runs one way.

Source is the vendored Natural Earth land polygons (public domain), the same data the web
client draws, for the same reason: 02_TRD TR-7 forbids the client holding a provider
credential, and a detector that needs a network call to a coastline service cannot run
offline or reproducibly. Provenance travels with the mask (13_REAL_DATA_POLICY §13.2).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

# Natural Earth 10 m is roughly 1:10,000,000 cartography. Its coastline is good to a few
# hundred metres, not to a SAR pixel. 500 m is that error plus tidal movement, rounded to
# something an analyst can hold in their head when they read "coastal water excluded".
DEFAULT_BUFFER_M = 500.0

# Where `scripts/build-basemap.mjs` writes the vendored coastline.
DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "coastline"


class CoastlineUnavailable(RuntimeError):
    """No vendored coastline covers the scene.

    Raised rather than returning an empty mask. An empty mask is indistinguishable from
    "this scene is entirely open ocean", and the difference between *no land here* and *we
    do not know where the land is* is the whole point of this module.
    """


@dataclass(frozen=True)
class LandMask:
    """A rasterised coastline plus what it cost and where it came from."""

    mask: np.ndarray
    """True where the pixel is land (or within the buffer of it)."""

    resolution: str
    """`'10m'` or `'50m'` — which vendored source covered this scene."""

    buffer_m: float

    land_fraction: float
    """Fraction of the scene masked out. Near 1.0 means there is almost no sea to search."""

    buffered_fraction: float
    """Fraction masked by the buffer ALONE — the coastal water given up to absorb coastline
    error. Reported so an analyst reading a null result near a shore knows how much of the
    near-shore was never examined."""

    provenance: dict


@lru_cache(maxsize=4)
def _load(resolution: str) -> tuple:
    """Vendored land polygons as (rings, provenance). Cached: this is read per scene."""
    path = DATA_DIR / f"land-{resolution}.json"
    if not path.exists():
        raise CoastlineUnavailable(
            f"no vendored coastline at {path}. Run `node scripts/build-basemap.mjs`."
        )
    fc = json.loads(path.read_text(encoding="utf-8"))
    prov_path = DATA_DIR / "provenance.json"
    prov = json.loads(prov_path.read_text(encoding="utf-8")) if prov_path.exists() else {}
    return tuple(f["geometry"] for f in fc["features"]), prov


def _covers(geometries, bbox: tuple[float, float, float, float]) -> bool:
    """Does this source have any polygon touching the scene bbox?

    The 10 m file is clipped to the regions this deployment works in, so outside them it is
    not merely sparse, it is absent — and an absent 10 m file must fall through to 50 m
    rather than produce a confident empty mask.
    """
    from shapely.geometry import box, shape

    scene = box(*bbox)
    return any(shape(g).intersects(scene) for g in geometries)


def coastline_mask(
    shape_hw: tuple[int, int],
    transform,
    crs,
    buffer_m: float = DEFAULT_BUFFER_M,
) -> LandMask:
    """Rasterise the vendored coastline onto a scene grid.

    `transform` and `crs` are the scene's, as read from the COG. The polygons are reprojected
    into the scene CRS before rasterising, so this works for any UTM zone without assuming
    the scene is in degrees.
    """
    from rasterio.features import rasterize
    from rasterio.warp import transform_geom
    from shapely.geometry import mapping, shape

    height, width = shape_hw
    bbox = _scene_bbox_wgs84(transform, crs, width, height)

    resolution = "10m"
    geoms, prov = _load(resolution)
    if not _covers(geoms, bbox):
        resolution = "50m"
        geoms, prov = _load(resolution)
        if not _covers(geoms, bbox):
            # Genuinely open ocean: the 50 m file is global, so nothing intersecting means
            # no land within the scene. That is a real answer, not a missing one.
            return LandMask(
                mask=np.zeros(shape_hw, dtype=bool),
                resolution=resolution,
                buffer_m=buffer_m,
                land_fraction=0.0,
                buffered_fraction=0.0,
                provenance={**prov, "resolution": resolution, "coversScene": False},
            )

    from shapely.geometry import box as shapely_box

    scene_box = shapely_box(*bbox)
    projected = []
    for g in geoms:
        geom = shape(g)
        if not geom.intersects(scene_box):
            continue
        # Clip before reprojecting. A MultiPolygon spanning a continent costs far more to
        # reproject than the part of it inside one Sentinel-1 frame.
        clipped = geom.intersection(scene_box)
        if clipped.is_empty:
            continue
        projected.append(shape(transform_geom("EPSG:4326", crs, mapping(clipped))))

    if not projected:
        return LandMask(
            mask=np.zeros(shape_hw, dtype=bool),
            resolution=resolution,
            buffer_m=buffer_m,
            land_fraction=0.0,
            buffered_fraction=0.0,
            provenance={**prov, "resolution": resolution, "coversScene": False},
        )

    bare = rasterize(
        [(g, 1) for g in projected],
        out_shape=shape_hw,
        transform=transform,
        fill=0,
        dtype="uint8",
        all_touched=True,
    ).astype(bool)

    if buffer_m > 0:
        buffered_geoms = [g.buffer(_buffer_in_crs_units(buffer_m, crs, bbox)) for g in projected]
        grown = rasterize(
            [(g, 1) for g in buffered_geoms],
            out_shape=shape_hw,
            transform=transform,
            fill=0,
            dtype="uint8",
            all_touched=True,
        ).astype(bool)
    else:
        grown = bare

    total = float(height * width)
    return LandMask(
        mask=grown,
        resolution=resolution,
        buffer_m=buffer_m,
        land_fraction=float(grown.sum()) / total,
        buffered_fraction=float((grown & ~bare).sum()) / total,
        provenance={
            **prov,
            "resolution": resolution,
            "coversScene": True,
            "bufferMetres": buffer_m,
            "note": (
                "Land grown by the buffer, never the sea. A near-shore slick inside the "
                "buffer is not examined; see buffered_fraction."
            ),
        },
    )


def _buffer_in_crs_units(buffer_m: float, crs, bbox: tuple) -> float:
    """The buffer is specified in metres; `shapely.buffer` works in CRS units.

    A Sentinel-1 scene is UTM, where those are the same thing. A scene in a geographic CRS is
    not, and `buffer(500)` there means 500 DEGREES — a mask covering the planet, which is
    "safe" in the sense that it rejects everything and useless in every other sense.

    Converting uses the LARGER of the two degree-per-metre rates (longitude, which grows with
    latitude) rather than a mean. That over-buffers in the north–south direction by up to
    1/cos(lat). Over-buffering grows the land, which is the direction this module already
    accepts everywhere else; the alternative under-buffers east–west and reopens the hole.
    """
    from pyproj import CRS

    if not CRS.from_user_input(crs).is_geographic:
        return buffer_m

    import math

    mid_lat = (bbox[1] + bbox[3]) / 2.0
    deg_per_m_lat = 1.0 / 110_540.0
    deg_per_m_lon = 1.0 / max(111_320.0 * math.cos(math.radians(mid_lat)), 1.0)
    return buffer_m * max(deg_per_m_lat, deg_per_m_lon)


def _scene_bbox_wgs84(transform, crs, width: int, height: int) -> tuple:
    """Scene bounds in lon/lat, for selecting which polygons are worth reprojecting."""
    from rasterio.transform import array_bounds
    from rasterio.warp import transform_bounds

    bounds = array_bounds(height, width, transform)
    return transform_bounds(crs, "EPSG:4326", *bounds, densify_pts=21)
