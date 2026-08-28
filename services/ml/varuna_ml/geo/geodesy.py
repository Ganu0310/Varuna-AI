"""Ellipsoidal geodesy on WGS84 via pyproj.Geod (PROJ's GeographicLib implementation).

Must agree with the Node stack (apps/api/src/geo/geodesy.ts, geographiclib-geodesic) within
0.1% — the known-answer suite in tests/test_geodesy_known_answers.py enforces this against
the shared packages/shared/geo-known-answers.json (02_TRD §2.6.4 / §2.15).

Coordinates are [longitude, latitude] everywhere, matching the rest of the system
(02_TRD TR-2). Area and distance are NEVER computed in degrees (02_TRD TR-3).
"""

from __future__ import annotations

from pyproj import Geod
from shapely.geometry import Polygon, mapping
from shapely.geometry.base import BaseGeometry

_GEOD = Geod(ellps="WGS84")


def geodesic_distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Shortest ellipsoidal distance between two (lon, lat) points, in metres."""
    _, _, dist = _GEOD.inv(a[0], a[1], b[0], b[1])
    return abs(dist)


def geodesic_bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial bearing from a to b, degrees true in [0, 360)."""
    fwd_az, _, _ = _GEOD.inv(a[0], a[1], b[0], b[1])
    return fwd_az % 360.0


def geodesic_polygon_area_m2(ring_lonlat: list[tuple[float, float]]) -> float:
    """Ellipsoidal area of a single ring given as (lon, lat) vertices, in m²."""
    lons = [p[0] for p in ring_lonlat]
    lats = [p[1] for p in ring_lonlat]
    area, _perimeter = _GEOD.polygon_area_perimeter(lons, lats)
    return abs(area)


def geodesic_area_perimeter(geom: BaseGeometry) -> tuple[float, float]:
    """Ellipsoidal (area_m2, perimeter_m) of a shapely Polygon in EPSG:4326.

    Holes are subtracted. Used for slick polygons — the value that becomes evidence
    (07_AIML §7.2.10).
    """
    if not isinstance(geom, Polygon):
        raise TypeError(f"expected Polygon, got {geom.geom_type}")
    gj = mapping(geom)
    rings = gj["coordinates"]
    total_area = 0.0
    total_per = 0.0
    for i, ring in enumerate(rings):
        lons = [c[0] for c in ring]
        lats = [c[1] for c in ring]
        a, p = _GEOD.polygon_area_perimeter(lons, lats)
        total_area += abs(a) if i == 0 else -abs(a)
        total_per += abs(p)
    return total_area, total_per


def geodesic_line_length_km(coords_lonlat: list[tuple[float, float]]) -> float:
    """Geodesic length of a polyline given as (lon, lat) vertices, in km."""
    total = 0.0
    for prev, cur in zip(coords_lonlat, coords_lonlat[1:]):
        total += geodesic_distance_m(prev, cur)
    return total / 1000.0
