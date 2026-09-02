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

The response reports `currentStatus` and `windStatus` alongside the overall `status`, because
the two forcing terms fail independently and the consequence differs. `windStatus` is one of:

    OBSERVED       a real ERA5 field was used; provenance names the route and the hours
    UNKNOWN        no wind field was available; alpha = 0 and the run says so
    NOT_ATTEMPTED  there was no trajectory to apply wind to (no currents either)

`UNKNOWN` is never silently replaced by a constant or a climatological mean.
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
# BLOCKING BY DESIGN, AND DECLARED AS SUCH.
#
# This handler is a plain `def`, not `async def`, and that is load-bearing. Everything it does
# is synchronous and slow — provider reads, GDAL, CMEMS, particle integration — and none of it
# awaits. An `async def` handler runs ON the event loop, so a single one of these stalls the
# entire service: while one drift run waited ~50 s for CMEMS, every other request queued behind
# it, `/health` included. The worker then reported `fetch failed` on unrelated jobs, which reads
# like a network fault and was really self-inflicted head-of-line blocking.
#
# Declared `def`, Starlette runs it in its threadpool instead, so slow work occupies one thread
# and the loop stays free to answer everything else.
def run_backtrack(req: BacktrackRequest) -> dict:
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
    wind_reason: str | None = None

    try:
        currents = fetch_currents(
            bbox,
            start,
            observed_at,
            cmems_username=settings.cmems_username,
            cmems_password=settings.cmems_password,
            timeout_s=settings.forcing_timeout_seconds,
            retries=settings.forcing_retries,
            attempted=attempted,
        )
    except ForcingUnavailable as e:
        # No current field means no back-tracking is possible. We return a proximity-based
        # origin and say plainly that it is NOT a drift result, rather than substituting a
        # climatological or nearest-in-time field that would look like one.
        buffered = geom.buffer(0.36)  # ~40 km at this latitude (07_AIML 7.3.6)
        return {
            "status": "DEGRADED",
            "method": "FOOTPRINT_PROXIMITY",
            "degradationReason": e.consequence,
            "currentStatus": "UNAVAILABLE",
            "windStatus": "NOT_ATTEMPTED",
            "windStatusReason": (
                "Wind was not requested: without a current field there is no trajectory to "
                "apply it to."
            ),
            "attempted": e.attempted,
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
        winds = fetch_winds(
            bbox,
            start,
            observed_at,
            cds_key=settings.cdsapi_key,
            cds_url=settings.cdsapi_url,
            local_path=settings.era5_local_path,
            timeout_s=settings.forcing_timeout_seconds,
            retries=settings.forcing_retries,
            attempted=attempted,
        )
    except ForcingUnavailable as e:
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
        # Reported separately from `status` because they degrade independently and an
        # analyst needs to know WHICH forcing term is missing: a run without wind
        # under-displaces a wind-driven slick, which is a different error from having no
        # current field at all.
        "currentStatus": "OBSERVED",
        "windStatus": "OBSERVED" if winds else "UNKNOWN",
        "windStatusReason": None if winds else wind_reason,
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
            "currents": _forcing_summary(currents),
            "winds": _forcing_summary(winds),
        },
        "params": result.params,
        "provenance": derived(
            external_id=f"origin:{observed_at:%Y%m%dT%H%M}",
            parents=[],
            dataset_id="lagrangian-backtrack-v1",
        ).model_dump(),
    }


def _forcing_summary(field) -> dict | None:
    """Provenance plus the grid metadata the caller must not have to guess.

    The API used to store `resolutionDeg: 0.08` and `temporalResolutionH: 3` for currents
    regardless of which provider actually answered - HYCOM's numbers, hard-coded. When CMEMS
    answers, the truth is 1/12 degree and hourly, and a provenance record that says otherwise
    is a provenance record that is wrong.
    """
    if field is None:
        return None
    out = dict(field.provenance)
    out.setdefault("resolutionDeg", field.resolution_deg)
    out.setdefault("temporalResolutionH", field.temporal_resolution_h)
    out["providerName"] = field.provider
    out["medianSpeedMs"] = round(field.median_speed(), 4)
    out["timeStepCount"] = len(field.times)
    return out


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
