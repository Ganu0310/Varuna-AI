"""`POST /backtrack` — 07_AIML 7.8.

Degradation ladder (07_AIML 7.3.6), applied here and reported verbatim to the caller:

    currents + winds        -> OK
    currents, no winds      -> DEGRADED, alpha = 0 (a wind-driven slick is under-displaced)
    no currents             -> DEGRADED, method FOOTPRINT_PROXIMITY, explicitly not a drift
                               result
    outside all coverage    -> UNAVAILABLE

A degraded run widens the honest uncertainty downstream. It never adjusts the tier
thresholds to compensate, because that would hide the degradation behind a number that still
looks confident.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from shapely.geometry import shape

from ..config import get_settings
from ..drift.backtrack import DEFAULTS, backtrack
from ..drift.forcing import ForcingUnavailable, fetch_currents, fetch_winds
from ..drift.kde import estimate_release_window, origin_field
from ..geo.morphology import compute_morphology
from ..provenance import derived
from ..security import require_service_token

log = logging.getLogger("varuna_ml.backtrack")
router = APIRouter(tags=["drift"], dependencies=[Depends(require_service_token)])


class BacktrackRequest(BaseModel):
    """GeoJSON Polygon of the reviewed slick, EPSG:4326."""

    geometry: dict
    observedAt: str
    horizonHours: int = Field(default=DEFAULTS["horizon_hours"], ge=1, le=72)
    particleCount: int = Field(default=DEFAULTS["particle_count"], ge=100, le=20000)
    windDriftRange: tuple[float, float] = DEFAULTS["wind_drift_range"]
    deflectionRangeDeg: tuple[float, float] = DEFAULTS["deflection_range_deg"]
    horizontalDiffusivity: float = DEFAULTS["horizontal_diffusivity"]
    """Acquisition time of the most recent prior scene over the same footprint that showed
    no slick. A hard lower bound on the release time when present."""
    priorClearSceneAt: str | None = None
    seed: int | None = None


@router.post("/backtrack")
async def run_backtrack(req: BacktrackRequest) -> dict:
    settings = get_settings()
    geom = shape(req.geometry)
    observed_at = datetime.fromisoformat(req.observedAt.replace("Z", "+00:00"))
    start = observed_at - timedelta(hours=req.horizonHours)

    w, s, e, n = geom.bounds
    # Pad the forcing request beyond the slick: particles drift out of the slick's own box.
    pad = max(0.5, req.horizonHours * 0.05)
    bbox = (w - pad, s - pad, e + pad, n + pad)

    morph = compute_morphology(geom)
    ring = [(float(x), float(y)) for x, y in geom.exterior.coords]

    attempted: list[dict] = []
    currents = None
    winds = None

    try:
        currents = fetch_currents(
            bbox,
            start,
            observed_at,
            cmems_username=settings.cmems_username,
            cmems_password=settings.cmems_password,
        )
        attempted.append({"provider": currents.provider, "outcome": "OK"})
    except ForcingUnavailable as e:
        attempted.extend(e.attempted)
        # No current field means no back-tracking is possible. We return a proximity-based
        # origin and say plainly that it is NOT a drift result, rather than substituting a
        # climatological or nearest-in-time field that would look like one.
        buffered = geom.buffer(0.36)  # ~40 km at this latitude (07_AIML 7.3.6)
        return {
            "status": "DEGRADED",
            "method": "FOOTPRINT_PROXIMITY",
            "degradationReason": e.consequence,
            "attempted": attempted,
            "frames": [],
            "support50": None,
            "support90": _ring(buffered),
            "centroid": [float(geom.centroid.x), float(geom.centroid.y)],
            "releaseWindow": estimate_release_window(
                observed_at,
                morph.major_axis_km,
                0.0,
                _parse_prior(req.priorClearSceneAt),
            ),
            "forcing": {"currents": None, "winds": None},
            "params": {
                "method": "FOOTPRINT_PROXIMITY",
                "bufferKm": 40,
                "note": "Not a drift result. The origin zone is the observed slick buffered "
                "by a fixed radius, which cannot distinguish upstream from downstream.",
            },
            "provenance": derived(
                external_id=f"origin:{observed_at:%Y%m%dT%H%M}",
                parents=[],
                dataset_id="footprint-proximity",
            ).model_dump(),
        }

    try:
        winds = fetch_winds(bbox, start, observed_at, cds_key=settings.cdsapi_key)
        attempted.append({"provider": winds.provider, "outcome": "OK"})
    except ForcingUnavailable as e:
        attempted.extend(e.attempted)
        wind_reason = e.consequence

    result = backtrack(
        ring,
        observed_at,
        currents,
        winds,
        particle_count=req.particleCount,
        horizon_hours=req.horizonHours,
        wind_drift_range=tuple(req.windDriftRange),
        deflection_range_deg=tuple(req.deflectionRangeDeg),
        horizontal_diffusivity=req.horizontalDiffusivity,
        seed=req.seed,
    )

    frames_out = []
    fields = [origin_field(f) for f in result.frames]
    for f in fields:
        frames_out.append(
            {
                "atTime": f.at_time,
                "bounds": [
                    float(f.lons.min()),
                    float(f.lats.min()),
                    float(f.lons.max()),
                    float(f.lats.max()),
                ],
                "cellSizeDeg": 0.01,
                "centroid": [f.centroid[0], f.centroid[1]],
            }
        )

    final = fields[-1]

    return {
        "status": "OK" if winds else "DEGRADED",
        "method": "LAGRANGIAN_BACKTRACK",
        "degradationReason": None if winds else wind_reason,
        "attempted": attempted,
        "frames": frames_out,
        "support50": _polygon(final.support50),
        "support90": _polygon(final.support90),
        "centroid": [final.centroid[0], final.centroid[1]],
        "particles": {
            "count": result.particle_count,
            "lon": [round(float(x), 5) for x in result.frames[-1]["lon"]],
            "lat": [round(float(y), 5) for y in result.frames[-1]["lat"]],
        },
        "releaseWindow": estimate_release_window(
            observed_at,
            morph.major_axis_km,
            result.median_drift_speed_ms,
            _parse_prior(req.priorClearSceneAt),
        ),
        "medianDriftSpeedMs": round(result.median_drift_speed_ms, 4),
        "forcing": {
            "currents": currents.provenance if currents else None,
            "winds": winds.provenance if winds else None,
        },
        "params": result.params,
        "provenance": derived(
            external_id=f"origin:{observed_at:%Y%m%dT%H%M}",
            parents=[],
            dataset_id="lagrangian-backtrack-v1",
        ).model_dump(),
    }


def _polygon(ring: list[list[float]] | None) -> dict | None:
    return {"type": "Polygon", "coordinates": [ring]} if ring else None


def _ring(geom) -> dict:
    return {
        "type": "Polygon",
        "coordinates": [[[float(x), float(y)] for x, y in geom.exterior.coords]],
    }


def _parse_prior(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
