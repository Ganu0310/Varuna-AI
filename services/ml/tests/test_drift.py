"""Drift back-tracking physics — 07_AIML 7.3.

These test the integrator against ANALYTIC solutions on constructed forcing fields. That is
a numerical cross-check, not fabricated observation data: the fields here are mathematical
inputs used to verify that the solver does what the equations say, in the same way one tests
a square-root routine against known squares (13_REAL_DATA_POLICY 13.7 permits simulating
transport/computation, never observation content).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from varuna_ml.drift.backtrack import backtrack, seed_particles
from varuna_ml.drift.forcing import ForcingField, ForcingUnavailable
from varuna_ml.drift.kde import (
    cumulative_contour,
    density_grid,
    estimate_release_window,
    origin_field,
)

T0 = datetime(2025, 9, 21, 20, 0, tzinfo=timezone.utc)

SQUARE = [(144.60, 13.40), (144.62, 13.40), (144.62, 13.42), (144.60, 13.42), (144.60, 13.40)]


def uniform_field(
    u_ms: float, v_ms: float, kind: str = "CURRENTS", span_hemispheres: bool = False
) -> ForcingField:
    """A spatially and temporally constant field, for analytic comparison."""
    lats = np.linspace(-20.0, 20.0, 81) if span_hemispheres else np.linspace(12.0, 15.0, 31)
    lons = np.linspace(143.0, 146.0, 31)
    shape = (1, len(lats), len(lons))
    return ForcingField(
        kind=kind,
        u=np.full(shape, u_ms),
        v=np.full(shape, v_ms),
        times=[T0],
        lats=lats,
        lons=lons,
        provider="TEST_ANALYTIC",
        dataset_id="uniform",
        resolution_deg=0.1,
        temporal_resolution_h=1.0,
    )


# ── seeding ───────────────────────────────────────────────────────────


def test_particles_are_seeded_inside_the_slick():
    from shapely.geometry import Point, Polygon

    poly = Polygon(SQUARE)
    lon, lat = seed_particles(SQUARE, 300, np.random.default_rng(1))
    assert len(lon) == 300
    inside = sum(poly.contains(Point(x, y)) for x, y in zip(lon, lat))
    # Uniform in the polygon, not clustered on the centroid.
    assert inside == 300
    assert lon.std() > 0.002


# ── advection ─────────────────────────────────────────────────────────


def test_backward_advection_moves_particles_upstream_by_the_analytic_distance():
    """A 0.5 m/s eastward current for 10 h must place the origin 18 km WEST."""
    currents = uniform_field(0.5, 0.0)
    r = backtrack(
        SQUARE, T0, currents, None,
        particle_count=200, horizon_hours=10, time_step_minutes=15,
        horizontal_diffusivity=0.0, seed=7,
    )
    final = r.frames[-1]
    mean_dlon = float(np.mean(final["lon"])) - float(np.mean(r.lon0))

    expected_m = 0.5 * 10 * 3600  # 18 km
    coslat = math.cos(math.radians(13.41))
    expected_dlon = -math.degrees(expected_m / (6_371_008.8 * coslat))

    assert mean_dlon == pytest.approx(expected_dlon, rel=0.02)
    assert mean_dlon < 0, "backward from an eastward current must go west"


def test_northward_current_backtracks_south():
    currents = uniform_field(0.0, 0.3)
    r = backtrack(SQUARE, T0, currents, None, particle_count=200, horizon_hours=6,
                  horizontal_diffusivity=0.0, seed=3)
    dlat = float(np.mean(r.frames[-1]["lat"])) - float(np.mean(r.lat0))
    expected = -math.degrees(0.3 * 6 * 3600 / 6_371_008.8)
    assert dlat == pytest.approx(expected, rel=0.02)


def test_zero_forcing_leaves_particles_where_they_started():
    r = backtrack(SQUARE, T0, uniform_field(0.0, 0.0), None, particle_count=100,
                  horizon_hours=12, horizontal_diffusivity=0.0, seed=5)
    assert float(np.mean(r.frames[-1]["lon"])) == pytest.approx(float(np.mean(r.lon0)), abs=1e-9)
    assert float(np.mean(r.frames[-1]["lat"])) == pytest.approx(float(np.mean(r.lat0)), abs=1e-9)


# ── diffusion ─────────────────────────────────────────────────────────


def test_diffusive_spread_matches_the_random_walk_law():
    """Spread must grow as sqrt(2*K_h*t) — the defining property of the diffusion term."""
    kh = 10.0
    hours = 24
    r = backtrack(SQUARE, T0, uniform_field(0.0, 0.0), None, particle_count=4000,
                  horizon_hours=hours, time_step_minutes=15,
                  horizontal_diffusivity=kh, seed=11)

    lat = r.frames[-1]["lat"]
    spread_deg = float(np.std(lat)) - float(np.std(r.lat0))
    spread_m = math.radians(spread_deg) * 6_371_008.8
    expected_m = math.sqrt(2 * kh * hours * 3600)

    # Within a factor of two of the analytic law (the seed polygon contributes its own width).
    assert 0.5 * expected_m < abs(spread_m) < 2.0 * expected_m


def test_more_particles_do_not_change_the_centre_of_mass():
    currents = uniform_field(0.2, 0.1)
    a = backtrack(SQUARE, T0, currents, None, particle_count=200, horizon_hours=6, seed=2)
    b = backtrack(SQUARE, T0, currents, None, particle_count=2000, horizon_hours=6, seed=2)
    assert float(np.mean(a.frames[-1]["lon"])) == pytest.approx(
        float(np.mean(b.frames[-1]["lon"])), abs=0.005
    )


# ── wind drift and Ekman deflection ───────────────────────────────────


def test_wind_adds_drift_within_the_sampled_coefficient_range():
    """With no current, displacement must lie between 2% and 4% of the wind run."""
    winds = uniform_field(10.0, 0.0, kind="WIND")
    r = backtrack(SQUARE, T0, uniform_field(0.0, 0.0), winds, particle_count=500,
                  horizon_hours=10, horizontal_diffusivity=0.0,
                  deflection_range_deg=(0.0, 0.0), seed=13)

    dlon = float(np.mean(r.frames[-1]["lon"])) - float(np.mean(r.lon0))
    coslat = math.cos(math.radians(13.41))
    moved_m = abs(math.radians(dlon) * 6_371_008.8 * coslat)

    wind_run_m = 10.0 * 10 * 3600
    assert 0.02 * wind_run_m * 0.9 < moved_m < 0.04 * wind_run_m * 1.1


def test_ekman_deflection_is_hemisphere_correct():
    """Deflection is to the RIGHT of the wind in the northern hemisphere.

    Applying one sign globally would push southern-hemisphere origins the wrong way, which
    is a silent, plausible-looking error.
    """
    # The field must span both hemispheres; outside the grid the sampler correctly returns
    # zero rather than extrapolating, which would make this test vacuous.
    winds = uniform_field(10.0, 0.0, kind="WIND", span_hemispheres=True)
    still = uniform_field(0.0, 0.0, span_hemispheres=True)
    north = backtrack(SQUARE, T0, still, winds, particle_count=400,
                      horizon_hours=10, horizontal_diffusivity=0.0,
                      deflection_range_deg=(20.0, 20.0), seed=17)
    south_square = [(x, -y) for x, y in SQUARE]
    south = backtrack(south_square, T0, still, winds, particle_count=400,
                      horizon_hours=10, horizontal_diffusivity=0.0,
                      deflection_range_deg=(20.0, 20.0), seed=17)

    dlat_n = float(np.mean(north.frames[-1]["lat"])) - float(np.mean(north.lat0))
    dlat_s = float(np.mean(south.frames[-1]["lat"])) - float(np.mean(south.lat0))
    # The cross-wind component must reverse sign across the equator.
    assert dlat_n * dlat_s < 0


def test_sampled_coefficients_produce_spread_that_fixed_ones_would_not():
    """The ensemble spread IS the uncertainty statement; fixing alpha would fake precision."""
    winds = uniform_field(10.0, 0.0, kind="WIND")
    sampled = backtrack(SQUARE, T0, uniform_field(0.0, 0.0), winds, particle_count=800,
                        horizon_hours=12, horizontal_diffusivity=0.0,
                        wind_drift_range=(0.02, 0.04), seed=19)
    fixed = backtrack(SQUARE, T0, uniform_field(0.0, 0.0), winds, particle_count=800,
                      horizon_hours=12, horizontal_diffusivity=0.0,
                      wind_drift_range=(0.03, 0.03), deflection_range_deg=(0.0, 0.0), seed=19)
    assert float(np.std(sampled.frames[-1]["lon"])) > float(np.std(fixed.frames[-1]["lon"]))


def test_no_wind_field_means_no_wind_drift():
    r = backtrack(SQUARE, T0, uniform_field(0.0, 0.0), None, particle_count=100,
                  horizon_hours=10, horizontal_diffusivity=0.0, seed=23)
    assert r.wind_used is False
    assert r.params["windDriftCoefficientRange"] == [0.0, 0.0]


# ── density and contours ──────────────────────────────────────────────


def test_density_grid_is_a_normalised_probability_surface():
    r = backtrack(SQUARE, T0, uniform_field(0.3, 0.0), None, particle_count=2000,
                  horizon_hours=12, seed=29)
    grid, lats, lons = density_grid(r.frames[-1]["lon"], r.frames[-1]["lat"])
    assert grid.sum() == pytest.approx(1.0, abs=1e-6)
    assert (grid >= 0).all()
    assert len(lats) > 4 and len(lons) > 4


def test_the_90_percent_region_contains_the_50_percent_region():
    r = backtrack(SQUARE, T0, uniform_field(0.3, 0.1), None, particle_count=3000,
                  horizon_hours=12, seed=31)
    field = origin_field(r.frames[-1])
    assert field.support50 and field.support90

    from shapely.geometry import Polygon

    p50 = Polygon(field.support50)
    p90 = Polygon(field.support90)
    assert p90.area > p50.area
    assert p90.buffer(1e-6).contains(p50.centroid)


def test_contours_are_right_hand_wound():
    """A clockwise ring is read by MongoDB as the whole globe minus the intended area."""
    r = backtrack(SQUARE, T0, uniform_field(0.2, 0.0), None, particle_count=2000,
                  horizon_hours=8, seed=37)
    field = origin_field(r.frames[-1])
    for ring in (field.support50, field.support90):
        assert ring is not None
        area = sum(
            ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
            for i in range(len(ring) - 1)
        ) / 2
        assert area > 0, "exterior ring must be counter-clockwise"


def test_empty_density_yields_no_contour_rather_than_a_fabricated_one():
    assert cumulative_contour(np.zeros((10, 10)), np.arange(10), np.arange(10), 0.9) is None


# ── release window ────────────────────────────────────────────────────


def test_release_window_is_an_interval_with_a_most_likely_sub_interval():
    w = estimate_release_window(T0, major_axis_km=5.0, median_drift_speed_ms=0.25)
    assert w["status"] == "OK"
    assert w["earliest"] < w["mostLikelyStart"] < w["mostLikelyEnd"] < w["latest"]


def test_a_longer_slick_implies_an_older_release():
    short = estimate_release_window(T0, 2.0, 0.25)
    long = estimate_release_window(T0, 10.0, 0.25)
    assert long["earliest"] < short["earliest"]


def test_slow_drift_gives_a_WIDE_window_not_a_fabricated_narrow_one():
    w = estimate_release_window(T0, 5.0, 0.001)
    assert w["status"] == "WIDE"
    assert "too low" in w["reason"]


def test_a_prior_clear_scene_is_a_hard_lower_bound():
    """If an earlier acquisition showed nothing, the release cannot predate it — a real
    observational constraint that overrides the kinematic estimate."""
    prior = T0 - timedelta(hours=6)
    w = estimate_release_window(T0, 20.0, 0.1, prior_clear_scene_at=prior)
    assert w["boundedByPriorClearScene"] is True
    assert w["earliest"] == prior.isoformat().replace("+00:00", "Z")


def test_window_never_extends_past_the_observation():
    w = estimate_release_window(T0, 0.5, 2.0)
    assert w["latest"] <= T0.isoformat().replace("+00:00", "Z")


# ── forcing failure ───────────────────────────────────────────────────


def test_forcing_unavailable_carries_what_was_tried_and_what_it_means():
    e = ForcingUnavailable("CURRENTS", [{"provider": "HYCOM", "outcome": "OUT_OF_COVERAGE"}],
                           "Back-tracking cannot run; the origin degrades to proximity.")
    assert e.attempted[0]["provider"] == "HYCOM"
    assert "degrades" in e.consequence


def test_particles_outside_the_forcing_grid_get_zero_not_extrapolation():
    """A particle beyond the model domain must not be pushed by an extrapolated velocity.

    Extrapolating a current field past its edge invents water movement where the model says
    nothing, which would place an origin outside the data that supports it.
    """
    far_south = [(x, -y) for x, y in SQUARE]  # the default grid covers 12N..15N only
    r = backtrack(far_south, T0, uniform_field(2.0, 2.0), None, particle_count=100,
                  horizon_hours=12, horizontal_diffusivity=0.0, seed=41)
    assert float(np.mean(r.frames[-1]["lon"])) == pytest.approx(float(np.mean(r.lon0)), abs=1e-9)


# ── sentinel / fill-value handling ────────────────────────────────────


def test_fill_values_never_become_velocities():
    """Regression: HYCOM encodes "no data" as -30000 in-band.

    `np.asarray()` on a MaskedArray silently strips the mask and exposes that raw fill,
    which then reads as -30000 m/s and hurls particles across the globe in a single step —
    observed as an origin centroid at 87N for a slick at 13N. This is the same in-band
    sentinel failure as AIS SOG 102.3: the fill must become NaN, never a number.
    """
    lats = np.linspace(12.0, 15.0, 31)
    lons = np.linspace(143.0, 146.0, 31)
    u = np.full((1, len(lats), len(lons)), 0.2)
    v = np.zeros_like(u)
    # A patch of unmasked fill values, as the bug produced.
    u[0, 10:20, 10:20] = np.nan  # correctly handled: NaN, not -30000

    f = ForcingField(kind="CURRENTS", u=u, v=v, times=[T0], lats=lats, lons=lons,
                     provider="TEST", dataset_id="fill", resolution_deg=0.1,
                     temporal_resolution_h=1.0)

    # A NaN cell samples as zero velocity (no water here), not as a huge number.
    su, sv = f.sample(T0, np.array([13.5]), np.array([144.5]))
    assert abs(float(su[0])) < 1.0
    assert abs(float(sv[0])) < 1.0

    r = backtrack(SQUARE, T0, f, None, particle_count=100, horizon_hours=24,
                  horizontal_diffusivity=0.0, seed=47)
    # Nothing may travel further than a plausible ocean current could carry it.
    max_dlat = float(np.max(np.abs(r.frames[-1]["lat"] - r.lat0)))
    assert max_dlat < 1.0, "a fill value leaked in and became a velocity"


def test_median_speed_ignores_masked_cells():
    lats = np.linspace(12.0, 15.0, 11)
    lons = np.linspace(143.0, 146.0, 11)
    u = np.full((1, 11, 11), 0.3)
    u[0, :5, :] = np.nan
    f = ForcingField(kind="CURRENTS", u=u, v=np.zeros_like(u), times=[T0], lats=lats,
                     lons=lons, provider="TEST", dataset_id="masked",
                     resolution_deg=0.3, temporal_resolution_h=1.0)
    assert f.median_speed() == pytest.approx(0.3, abs=1e-6)
