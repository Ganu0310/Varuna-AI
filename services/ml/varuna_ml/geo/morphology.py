"""Slick morphology on a local equal-area projection — 07_AIML 7.2.10.

Why the projection matters: morphology is measured in metres, and measuring it in degrees
is wrong by roughly cos(latitude) in the east-west direction. At Guam (13.4 degrees N) that
is a ~2.6% error; in the Baltic it is over 40%. Since elongation is one of the primary
oil-versus-look-alike discriminators, a latitude-dependent distortion of the axis ratio
would bias the classification itself, not merely the reported numbers.

So every shape measurement is taken after reprojecting into a Lambert Azimuthal Equal-Area
CRS centred on the feature. Distances that become evidence still use the ellipsoidal
geodesic routines in geodesy.py; this module covers shape only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from shapely.geometry import Polygon, mapping
from shapely.geometry.base import BaseGeometry

from .projections import to_local_equal_area


@dataclass
class Morphology:
    """Shape descriptors, all metric, all measured on an equal-area projection."""

    major_axis_km: float
    minor_axis_km: float
    elongation_ratio: float
    """Bearing of the long axis, degrees clockwise from north, mod 180 (an axis has no
    direction of travel, only an orientation)."""
    orientation_deg: float
    convexity: float
    """Isoperimetric compactness: 1 for a circle, lower for a ragged outline."""
    compactness: float
    centroid_lonlat: tuple[float, float]
    area_km2: float
    perimeter_km: float


def _min_rotated_rect_axes(geom_m: BaseGeometry) -> tuple[float, float, float]:
    """Major axis (m), minor axis (m), and major-axis bearing (degrees) of the minimum
    rotated rectangle.

    The minimum rotated rectangle is used rather than the axis-aligned bounding box because
    a slick drawn out along a vessel's course is rarely aligned to north; an axis-aligned
    box would report the elongation of the box, not of the slick.
    """
    rect = geom_m.minimum_rotated_rectangle
    coords = list(rect.exterior.coords)[:4] if hasattr(rect, "exterior") else []
    if len(coords) < 4:
        return 0.0, 0.0, 0.0

    edges = []
    for i in range(4):
        x1, y1 = coords[i]
        x2, y2 = coords[(i + 1) % 4]
        edges.append((math.hypot(x2 - x1, y2 - y1), math.atan2(x2 - x1, y2 - y1)))

    edges.sort(key=lambda e: -e[0])
    major_len, major_ang = edges[0]
    minor_len = edges[2][0] if len(edges) > 2 else edges[-1][0]

    # atan2(dx, dy) already gives a compass-style bearing from north; fold onto [0, 180).
    bearing = math.degrees(major_ang) % 180.0
    return major_len, minor_len, bearing


def compute_morphology(geom_wgs84: BaseGeometry) -> Morphology:
    """Compute shape descriptors for a polygon given in EPSG:4326."""
    if not isinstance(geom_wgs84, Polygon):
        raise TypeError(f"expected Polygon, got {geom_wgs84.geom_type}")

    centroid = geom_wgs84.centroid
    lon, lat = float(centroid.x), float(centroid.y)

    geom_m = to_local_equal_area(geom_wgs84, lon, lat)

    area_m2 = float(geom_m.area)
    perimeter_m = float(geom_m.length)

    major_m, minor_m, bearing = _min_rotated_rect_axes(geom_m)
    minor_m = max(minor_m, 1.0)  # a degenerate sliver must not divide by zero

    hull_area = float(geom_m.convex_hull.area)
    convexity = area_m2 / hull_area if hull_area > 0 else 1.0

    # Isoperimetric ratio: 4*pi*A / P^2. A circle scores 1; a ragged slick scores well below.
    compactness = (4 * math.pi * area_m2 / (perimeter_m**2)) if perimeter_m > 0 else 0.0

    return Morphology(
        major_axis_km=major_m / 1000.0,
        minor_axis_km=minor_m / 1000.0,
        elongation_ratio=major_m / minor_m,
        orientation_deg=bearing,
        convexity=min(1.0, convexity),
        compactness=min(1.0, compactness),
        centroid_lonlat=(lon, lat),
        area_km2=area_m2 / 1e6,
        perimeter_km=perimeter_m / 1000.0,
    )


def morphology_to_dict(m: Morphology) -> dict:
    return {
        "majorAxisKm": round(m.major_axis_km, 4),
        "minorAxisKm": round(m.minor_axis_km, 4),
        "elongationRatio": round(m.elongation_ratio, 3),
        "orientationDeg": round(m.orientation_deg, 1),
        "convexity": round(m.convexity, 3),
        "compactness": round(m.compactness, 3),
        "centroid": {"type": "Point", "coordinates": [round(m.centroid_lonlat[0], 6),
                                                      round(m.centroid_lonlat[1], 6)]},
        "areaKm2": round(m.area_km2, 4),
        "perimeterKm": round(m.perimeter_km, 4),
    }


__all__ = ["Morphology", "compute_morphology", "morphology_to_dict", "mapping"]
