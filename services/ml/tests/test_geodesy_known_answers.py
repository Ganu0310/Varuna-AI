"""Known-answer geodesy suite — Python side.

Reads the SAME contract as the Node stack (packages/shared/geo-known-answers.json) and
asserts pyproj.Geod reproduces every value within 0.1%. Paired with
apps/api/src/geo/geodesy.test.ts. CI gate (02_TRD §2.6.4 / §2.15).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from varuna_ml.geo.geodesy import (
    geodesic_bearing_deg,
    geodesic_distance_m,
    geodesic_line_length_km,
    geodesic_polygon_area_m2,
)

_CONTRACT = json.loads(
    (Path(__file__).parents[3] / "packages" / "shared" / "geo-known-answers.json").read_text()
)


@pytest.mark.parametrize("case", _CONTRACT["geodesicInverse"], ids=lambda c: c["name"])
def test_geodesic_inverse(case):
    d = geodesic_distance_m(tuple(case["from"]), tuple(case["to"]))
    assert abs(d - case["expectedMetres"]) <= case["tolMetres"]
    assert abs(d - case["expectedMetres"]) / case["expectedMetres"] < 1e-3


@pytest.mark.parametrize("case", _CONTRACT["polygonAreaGeodesic"], ids=lambda c: c["name"])
def test_geodesic_polygon_area(case):
    ring = [tuple(p) for p in case["ringLonLat"]]
    a = geodesic_polygon_area_m2(ring)
    assert abs(a - case["expectedSquareMetres"]) <= case["tolSquareMetres"]
    assert abs(a - case["expectedSquareMetres"]) / case["expectedSquareMetres"] < 1e-3


def test_bearing_due_east_is_90():
    assert abs(geodesic_bearing_deg((0.0, 0.0), (1.0, 0.0)) - 90.0) < 1e-4


def test_bearing_due_north_is_0():
    b = geodesic_bearing_deg((0.0, 0.0), (0.0, 1.0))
    assert min(b, abs(360.0 - b)) < 1e-4


def test_line_length_sums_legs():
    length = geodesic_line_length_km([(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)])
    assert length == pytest.approx(2 * 111.3195, abs=0.05)
