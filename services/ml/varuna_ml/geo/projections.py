"""Local equal-area projection helpers for slick morphology and polygon-intersection area.

Measurement on an equal-area projection is used ONLY for morphology (major/minor axis,
orientation, convexity — 07_AIML §7.2.10) and polygon∩polygon area; distances that become
evidence use ellipsoidal geodesy (geodesy.py). Never measure in degrees (02_TRD TR-3).
"""

from __future__ import annotations

from pyproj import CRS, Transformer
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform as shp_transform


def local_azimuthal_equal_area_crs(lon: float, lat: float) -> CRS:
    """A Lambert Azimuthal Equal-Area CRS centred on the given point."""
    return CRS.from_proj4(
        f"+proj=laea +lat_0={lat} +lon_0={lon} +x_0=0 +y_0=0 "
        f"+datum=WGS84 +units=m +no_defs"
    )


def to_local_equal_area(geom: BaseGeometry, lon: float, lat: float) -> BaseGeometry:
    laea = local_azimuthal_equal_area_crs(lon, lat)
    t = Transformer.from_crs("EPSG:4326", laea, always_xy=True)
    return shp_transform(t.transform, geom)


def to_wgs84(geom: BaseGeometry, lon: float, lat: float) -> BaseGeometry:
    laea = local_azimuthal_equal_area_crs(lon, lat)
    t = Transformer.from_crs(laea, "EPSG:4326", always_xy=True)
    return shp_transform(t.transform, geom)
