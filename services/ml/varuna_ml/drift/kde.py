"""Origin probability surface and release-time window — 07_AIML 7.3.4 / 7.3.5.

The output of back-tracking is a CLOUD of particles, not a point. This module turns that
cloud into a normalised density surface and cumulative-probability contours, because the
honest answer to "where did it come from?" is an area with a probability attached, not a
coordinate.

The 50% and 90% contours are CUMULATIVE-mass contours: the 90% polygon is the smallest
region containing 90% of the particles. That is the quantity an analyst actually wants, and
it is not the same as a fixed-density isoline.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np


@dataclass
class OriginField:
    grid: np.ndarray  # (nlat, nlon) normalised so it sums to 1
    lats: np.ndarray
    lons: np.ndarray
    support50: list[list[float]] | None  # polygon ring, [lon, lat]
    support90: list[list[float]] | None
    centroid: tuple[float, float]
    at_time: str


def density_grid(
    lon: np.ndarray, lat: np.ndarray, cell_size_deg: float = 0.01, pad_deg: float = 0.05
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """2-D histogram of particle positions, smoothed to a density.

    A histogram alone is noisy at 5,000 particles; a Gaussian smooth with a bandwidth tied
    to the particle spread gives a stable surface without inventing structure.
    """
    from scipy import ndimage

    lon_min, lon_max = float(lon.min()) - pad_deg, float(lon.max()) + pad_deg
    lat_min, lat_max = float(lat.min()) - pad_deg, float(lat.max()) + pad_deg

    nlon = max(8, int(np.ceil((lon_max - lon_min) / cell_size_deg)))
    nlat = max(8, int(np.ceil((lat_max - lat_min) / cell_size_deg)))

    hist, lat_edges, lon_edges = np.histogram2d(
        lat, lon, bins=[nlat, nlon], range=[[lat_min, lat_max], [lon_min, lon_max]]
    )

    # Bandwidth from the spread of the cloud itself (a Scott's-rule flavour), so a tight
    # cloud is not over-smoothed into a broad, falsely uncertain blob.
    spread_cells = max(1.0, float(np.std(lat)) / max(cell_size_deg, 1e-9)) * 0.25
    smoothed = ndimage.gaussian_filter(hist, sigma=min(spread_cells, 6.0), mode="constant")

    total = smoothed.sum()
    grid = smoothed / total if total > 0 else smoothed

    lats = (lat_edges[:-1] + lat_edges[1:]) / 2
    lons = (lon_edges[:-1] + lon_edges[1:]) / 2
    return grid, lats, lons


def cumulative_contour(
    grid: np.ndarray, lats: np.ndarray, lons: np.ndarray, mass: float
) -> list[list[float]] | None:
    """Smallest region containing `mass` of the probability, as a polygon ring.

    Cells are ranked by density and taken until the cumulative mass is reached; the
    resulting binary region is outlined. This is the correct construction for a credible
    region and differs from a fixed-density isoline.
    """
    from skimage import measure

    if grid.sum() <= 0:
        return None

    flat = np.sort(grid.ravel())[::-1]
    cumulative = np.cumsum(flat)
    idx = int(np.searchsorted(cumulative, mass * cumulative[-1]))
    threshold = flat[min(idx, len(flat) - 1)]

    binary = (grid >= threshold).astype(float)
    contours = measure.find_contours(binary, 0.5)
    if not contours:
        return None

    contour = max(contours, key=len)  # the dominant region

    ring: list[list[float]] = []
    for r, c in contour:
        ri = int(np.clip(round(r), 0, len(lats) - 1))
        ci = int(np.clip(round(c), 0, len(lons) - 1))
        ring.append([float(lons[ci]), float(lats[ri])])

    if len(ring) < 4:
        return None
    if ring[0] != ring[-1]:
        ring.append(ring[0])

    # Right-hand rule (counter-clockwise exterior) so MongoDB does not read the polygon as
    # its own complement (06_BACKEND 6.3.2).
    if _signed_area(ring) < 0:
        ring.reverse()
    return ring


def _signed_area(ring: list[list[float]]) -> float:
    s = 0.0
    for i in range(len(ring) - 1):
        s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return s / 2.0


def origin_field(frame: dict, cell_size_deg: float = 0.01) -> OriginField:
    """Build the density surface and contours for one back-tracked frame."""
    lon = np.asarray(frame["lon"])
    lat = np.asarray(frame["lat"])
    grid, lats, lons = density_grid(lon, lat, cell_size_deg=cell_size_deg)

    # Probability-weighted centroid, which is the density's centre of mass rather than the
    # arithmetic mean of particle positions.
    if grid.sum() > 0:
        lat_c = float((grid.sum(axis=1) * lats).sum() / grid.sum())
        lon_c = float((grid.sum(axis=0) * lons).sum() / grid.sum())
    else:
        lat_c, lon_c = float(lat.mean()), float(lon.mean())

    return OriginField(
        grid=grid,
        lats=lats,
        lons=lons,
        support50=cumulative_contour(grid, lats, lons, 0.50),
        support90=cumulative_contour(grid, lats, lons, 0.90),
        centroid=(lon_c, lat_c),
        at_time=frame["atTime"],
    )


def estimate_release_window(
    observed_at: datetime,
    major_axis_km: float,
    median_drift_speed_ms: float,
    prior_clear_scene_at: datetime | None = None,
) -> dict:
    """Release-time window — 07_AIML 7.3.5.

        elapsed = majorAxisKm / median drift speed
        window  = [t_obs - 1.5*elapsed, t_obs - 0.4*elapsed]

    The reasoning: a slick is stretched along its long axis by the drift that carried it, so
    the time needed to reach that length is a first-order estimate of its age. The 0.4-1.5
    band expresses how rough that is.

    `prior_clear_scene_at` is a HARD lower bound: if an earlier acquisition covered the same
    footprint and showed nothing, the release cannot predate it. That is a real observational
    constraint and it overrides the kinematic estimate.

    When drift is too slow to have stretched the slick meaningfully, the age is
    indeterminate and the status is WIDE rather than a fabricated narrow interval.
    """
    if median_drift_speed_ms <= 0.01 or major_axis_km <= 0:
        earliest = observed_at - timedelta(hours=24)
        latest = observed_at
        status = "WIDE"
        reason = (
            "Drift speed is too low to infer an age from the slick's length; the window is "
            "the full back-tracking horizon rather than a narrower estimate."
        )
    else:
        elapsed_s = (major_axis_km * 1000.0) / median_drift_speed_ms
        earliest = observed_at - timedelta(seconds=1.5 * elapsed_s)
        latest = observed_at - timedelta(seconds=0.4 * elapsed_s)
        status = "OK"
        reason = None

    bounded_by_prior_scene = False
    if prior_clear_scene_at and earliest < prior_clear_scene_at:
        earliest = prior_clear_scene_at
        bounded_by_prior_scene = True

    if latest <= earliest:
        latest = min(observed_at, earliest + timedelta(hours=1))

    span = (latest - earliest).total_seconds()
    most_likely_start = earliest + timedelta(seconds=span * 0.3)
    most_likely_end = earliest + timedelta(seconds=span * 0.7)

    out = {
        "earliest": earliest.isoformat().replace("+00:00", "Z"),
        "latest": latest.isoformat().replace("+00:00", "Z"),
        "mostLikelyStart": most_likely_start.isoformat().replace("+00:00", "Z"),
        "mostLikelyEnd": most_likely_end.isoformat().replace("+00:00", "Z"),
        "status": status,
        "boundedByPriorClearScene": bounded_by_prior_scene,
    }
    if reason:
        out["reason"] = reason
    if bounded_by_prior_scene:
        out["priorClearSceneAt"] = prior_clear_scene_at.isoformat().replace("+00:00", "Z")
    return out
