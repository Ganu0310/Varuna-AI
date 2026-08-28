"""Backward Lagrangian drift back-tracking — 07_AIML 7.3.

Runs particles BACKWARD in time from an observed slick to the water they came from, giving
a probability surface over where the release happened rather than a single point.

The physics, per particle:

    dx/dt = u_current + alpha * R(theta) * u_wind + random walk(K_h)

  u_current   surface current from a real ocean model
  alpha       wind-drift coefficient, sampled per particle from U(0.02, 0.04)
  theta       Ekman deflection, sampled from U(0, 20) degrees, sign by hemisphere
              (right in the northern hemisphere, left in the southern)
  K_h         horizontal eddy diffusivity, 10 m^2/s, as an isotropic random walk

Why alpha and theta are SAMPLED rather than fixed: their true values depend on slick
thickness, sea state and oil properties that we do not know. Fixing them would produce a
tight, confident-looking origin blob whose apparent precision is fictional. Sampling across
the plausible range makes the resulting spread an honest expression of that ignorance — the
uncertainty in the answer comes from uncertainty in the physics, not from tuning.

Backward integration is `-dt` on the same equations. That is exact for advection and
correct-in-distribution for the diffusive term, since a symmetric random walk run backwards
has the same statistics.

NOTE ON OpenDrift: 07_AIML 7.3.3 designates OpenDrift as the integrator with this stepper as
a cross-check. OpenDrift requires cartopy/GEOS, which would not install in this environment,
so the roles are inverted here: this stepper is primary and is directly tested against
analytic solutions. The forcing interface is deliberately the same shape OpenDrift expects,
so swapping it in later touches only this file.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np

from .forcing import ForcingField

log = logging.getLogger("varuna_ml.drift.backtrack")

EARTH_RADIUS_M = 6_371_008.8

DEFAULTS = {
    "particle_count": 5000,
    "time_step_minutes": 15,
    "horizon_hours": 24,
    "wind_drift_range": (0.02, 0.04),
    "deflection_range_deg": (0.0, 20.0),
    "horizontal_diffusivity": 10.0,  # m^2/s
}


@dataclass
class BacktrackResult:
    """Particle positions per frame, oldest frame last (frames run backwards in time)."""

    frames: list[dict]  # {"atTime": iso, "lon": np.ndarray, "lat": np.ndarray}
    times: list[datetime]
    lon0: np.ndarray
    lat0: np.ndarray
    particle_count: int
    median_drift_speed_ms: float
    wind_used: bool
    params: dict


def seed_particles(
    polygon_lonlat: list[tuple[float, float]], n: int, rng: np.random.Generator
) -> tuple[np.ndarray, np.ndarray]:
    """Rejection-sample `n` points uniformly inside the slick polygon.

    Uniform-in-polygon rather than on the centroid or boundary, because the release could
    have produced any part of the observed slick; seeding only the centre would understate
    the origin zone's true extent.
    """
    from shapely.geometry import Point, Polygon

    poly = Polygon(polygon_lonlat)
    minx, miny, maxx, maxy = poly.bounds
    lons: list[float] = []
    lats: list[float] = []
    attempts = 0
    max_attempts = n * 200

    while len(lons) < n and attempts < max_attempts:
        batch = max(n - len(lons), 64)
        xs = rng.uniform(minx, maxx, batch)
        ys = rng.uniform(miny, maxy, batch)
        for x, y in zip(xs, ys):
            attempts += 1
            if poly.contains(Point(x, y)):
                lons.append(float(x))
                lats.append(float(y))
                if len(lons) >= n:
                    break

    if len(lons) < n:
        # A very thin sliver can defeat rejection sampling; fall back to the centroid for
        # the remainder rather than returning fewer particles than requested.
        c = poly.centroid
        lons.extend([float(c.x)] * (n - len(lons)))
        lats.extend([float(c.y)] * (n - len(lats)))

    return np.asarray(lons), np.asarray(lats)


def backtrack(
    polygon_lonlat: list[tuple[float, float]],
    observed_at: datetime,
    currents: ForcingField,
    winds: ForcingField | None = None,
    *,
    particle_count: int = DEFAULTS["particle_count"],
    time_step_minutes: int = DEFAULTS["time_step_minutes"],
    horizon_hours: int = DEFAULTS["horizon_hours"],
    wind_drift_range: tuple[float, float] = DEFAULTS["wind_drift_range"],
    deflection_range_deg: tuple[float, float] = DEFAULTS["deflection_range_deg"],
    horizontal_diffusivity: float = DEFAULTS["horizontal_diffusivity"],
    seed: int | None = None,
    frame_every_minutes: int = 60,
) -> BacktrackResult:
    """Integrate particles backwards from the observed slick."""
    rng = np.random.default_rng(seed)

    lon, lat = seed_particles(polygon_lonlat, particle_count, rng)
    lon0, lat0 = lon.copy(), lat.copy()

    # One alpha and theta per particle, held fixed for its whole trajectory: a single
    # particle represents one plausible physical realisation, not an average of many.
    alpha = rng.uniform(*wind_drift_range, size=particle_count)
    theta = np.deg2rad(rng.uniform(*deflection_range_deg, size=particle_count))
    # Ekman deflection is to the right of the wind in the northern hemisphere, left in the
    # southern. Applying one sign globally would push southern-hemisphere origins the wrong way.
    theta = np.where(lat0 >= 0, theta, -theta)

    dt = time_step_minutes * 60.0
    steps = int(horizon_hours * 60 / time_step_minutes)
    frame_stride = max(1, int(frame_every_minutes / time_step_minutes))

    # Random-walk step for diffusivity K_h: sigma = sqrt(2 * K_h * dt) per axis.
    sigma = float(np.sqrt(2.0 * horizontal_diffusivity * dt))

    speeds: list[float] = []
    frames: list[dict] = []
    times: list[datetime] = []

    t = observed_at
    frames.append({"atTime": t.isoformat().replace("+00:00", "Z"),
                   "lon": lon.copy(), "lat": lat.copy()})
    times.append(t)

    for step in range(1, steps + 1):
        cu, cv = currents.sample(t, lat, lon)

        if winds is not None:
            wu, wv = winds.sample(t, lat, lon)
            # Rotate the wind vector by the Ekman angle, then scale by the wind-drift factor.
            cos_t, sin_t = np.cos(theta), np.sin(theta)
            du = alpha * (wu * cos_t - wv * sin_t)
            dv = alpha * (wu * sin_t + wv * cos_t)
        else:
            du = np.zeros_like(cu)
            dv = np.zeros_like(cv)

        u = cu + du
        v = cv + dv
        speeds.append(float(np.median(np.hypot(u, v))))

        # Backward advection, plus a symmetric random walk (whose statistics are unchanged
        # under time reversal).
        dx = -u * dt + rng.normal(0.0, sigma, size=particle_count)
        dy = -v * dt + rng.normal(0.0, sigma, size=particle_count)

        # Metres -> degrees on a sphere; the longitude scale shrinks with latitude.
        dlat = np.rad2deg(dy / EARTH_RADIUS_M)
        coslat = np.cos(np.deg2rad(np.clip(lat, -89.5, 89.5)))
        dlon = np.rad2deg(dx / (EARTH_RADIUS_M * np.maximum(coslat, 1e-6)))

        lat = np.clip(lat + dlat, -90.0, 90.0)
        lon = ((lon + dlon + 180.0) % 360.0) - 180.0

        t = t - timedelta(seconds=dt)

        if step % frame_stride == 0 or step == steps:
            frames.append({"atTime": t.isoformat().replace("+00:00", "Z"),
                           "lon": lon.copy(), "lat": lat.copy()})
            times.append(t)

    return BacktrackResult(
        frames=frames,
        times=times,
        lon0=lon0,
        lat0=lat0,
        particle_count=particle_count,
        median_drift_speed_ms=float(np.median(speeds)) if speeds else 0.0,
        wind_used=winds is not None,
        params={
            "particleCount": particle_count,
            "timeStepMinutes": time_step_minutes,
            "horizonHours": horizon_hours,
            "windDriftCoefficientRange": list(wind_drift_range) if winds else [0.0, 0.0],
            "ekmanDeflectionRangeDeg": list(deflection_range_deg) if winds else [0.0, 0.0],
            "horizontalDiffusivity": horizontal_diffusivity,
            "integrator": "euler-backward",
            "seed": seed,
        },
    )
