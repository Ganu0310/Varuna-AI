"""Ground sample distance in metres, whatever the raster's CRS.

`abs(transform.a)` is the pixel width in CRS UNITS. For a projected CRS those are metres and
the two are the same number, which is why this was written as `abs(transform.a)` in two places
and worked for every Sentinel-1 RTC product — those arrive in UTM.

For a geographic CRS they are DEGREES. A 10 m scene in EPSG:4326 has a transform of about
0.0001, so the detector was told each pixel was 0.0001 m across. The minimum-area gate of
0.05 km² then required five trillion pixels, and every detection was silently dropped: not an
error, not a warning, just zero results on a scene with an obvious slick in it.

Uploaded scenes are frequently in EPSG:4326, so this stopped being theoretical the moment the
browse-and-attribute path existed.
"""

from __future__ import annotations

import math


def pixel_size_metres(transform, crs, bounds_wgs84: tuple[float, float, float, float]) -> float:
    """Pixel width in metres.

    `bounds_wgs84` is (west, south, east, north); only the latitudes are used, to take the
    longitude scale at the scene centre.
    """
    from pyproj import CRS

    px = abs(transform.a)
    if not CRS.from_user_input(crs).is_geographic:
        return float(px)

    mid_lat = (bounds_wgs84[1] + bounds_wgs84[3]) / 2.0
    return float(px * 111_320.0 * math.cos(math.radians(mid_lat)))
