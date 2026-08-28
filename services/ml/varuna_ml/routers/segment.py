"""`/segment` and `/vectorise` — the 07_AIML 7.8 contract.

`/segment` runs the detector over a stored scene COG and returns georeferenced polygons.
`/vectorise` converts an already-computed mask into polygons with morphology, for the case
where segmentation and vectorisation are separated (a learned model writes a mask COG, then
vectorisation runs against it).

Both responses carry `modelSha`, provenance, and the four confidence terms separately. The
`modelSha` resolves in the registry to exactly one artefact, so a report citing a detection
can be traced to the precise algorithm that produced it (07_AIML 7.7).
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

import boto3
import rasterio
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from rasterio.session import AWSSession
from shapely.geometry import shape

from ..config import get_settings
from ..detect.darkspot import detect, to_geojson
from ..geo.morphology import compute_morphology, morphology_to_dict
from ..models.confidence import confidence_to_dict, detection_confidence
from ..models.registry import get_model
from ..provenance import derived
from ..security import require_service_token

log = logging.getLogger("varuna_ml.segment")
router = APIRouter(tags=["segment"], dependencies=[Depends(require_service_token)])

DETECTOR_SOURCE = Path(__file__).resolve().parents[1] / "detect" / "darkspot.py"
# routers -> varuna_ml -> ml -> services -> <repo root>
REGISTRY_PATH = Path(__file__).resolve().parents[4] / "data" / "models" / "registry.json"


def detector_sha() -> str:
    """The classical detector is content-addressed by its own source, since it has no
    weights file — the source is what determines its output."""
    return hashlib.sha256(DETECTOR_SOURCE.read_bytes()).hexdigest()


def _open_cog(bucket: str, key: str):
    s = get_settings()
    session = boto3.Session(
        aws_access_key_id=s.s3_access_key_id,
        aws_secret_access_key=s.s3_secret_access_key,
        region_name=s.s3_region,
    )
    with rasterio.Env(
        AWSSession(session, endpoint_url=s.s3_endpoint.replace("http://", "")),
        AWS_HTTPS="NO",
        AWS_VIRTUAL_HOSTING="FALSE",
    ):
        with rasterio.open(f"s3://{bucket}/{key}") as ds:
            return ds.read(1), ds.transform, ds.crs, float(abs(ds.transform.a))


class SegmentRequest(BaseModel):
    bucket: str
    key: str
    contrastDb: float = Field(default=3.0, ge=0.5, le=12.0)
    minAreaKm2: float = Field(default=0.05, ge=0.001)
    """10 m wind at acquisition, from the WIND provider chain. Omit when unavailable — the
    wind term then reports 0.5 (unknown) rather than assuming good conditions."""
    windMs: float | None = None


@router.post("/segment")
async def segment_scene(req: SegmentRequest) -> dict:
    try:
        arr, transform, crs, pixel_m = _open_cog(req.bucket, req.key)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"could not read s3://{req.bucket}/{req.key}: {e}",
        ) from e

    spots = detect(
        arr,
        pixel_size_m=pixel_m,
        contrast_db=req.contrastDb,
        min_area_km2=req.minAreaKm2,
        wind_ms=req.windMs,
    )
    features = to_geojson(spots, transform, crs)

    sha = detector_sha()
    entry = get_model(REGISTRY_PATH, sha)

    detections = []
    for feat, spot in zip(features, spots):
        # Morphology is recomputed on a local equal-area projection rather than reused from
        # pixel space: measuring shape in degrees distorts the axis ratio by ~cos(latitude),
        # and elongation is a primary oil-versus-look-alike discriminator (07_AIML 7.2.10).
        morph = compute_morphology(shape(feat["geometry"]))
        conf = detection_confidence(
            mean_oil_probability=None,  # the classical detector produces no calibrated probability
            contrast_db=spot.contrast_db,
            wind_ms=req.windMs,
            look_alike_risk=spot.look_alike_risk,
        )
        detections.append(
            {
                "rank": feat["rank"],
                "geometry": feat["geometry"],
                "areaKm2": round(morph.area_km2, 4),
                "perimeterKm": round(morph.perimeter_km, 4),
                "morphology": morphology_to_dict(morph),
                "backscatter": feat["backscatter"],
                "lookAlikeRisk": feat["lookAlikeRisk"],
                "confidence": confidence_to_dict(conf),
            }
        )

    return {
        "detections": detections,
        "modelSha": sha,
        "model": {
            "name": "classical-darkspot",
            "version": "1.0.0",
            "registered": entry is not None,
            "metrics": (entry or {}).get("metrics"),
            "metricsAbsentReason": (entry or {}).get("metrics_absent_reason"),
        },
        "params": {
            "contrastDb": req.contrastDb,
            "minAreaKm2": req.minAreaKm2,
            "pixelSizeM": pixel_m,
            "windMs": req.windMs,
            "windKnown": req.windMs is not None,
        },
        "scene": {"bucket": req.bucket, "key": req.key},
        "provenance": derived(
            external_id=f"segment:{req.key}", parents=[], dataset_id=f"classical-darkspot@{sha[:12]}"
        ).model_dump(),
    }


class VectoriseRequest(BaseModel):
    """Vectorise a GeoJSON geometry that already exists, returning its morphology."""

    geometry: dict


@router.post("/vectorise")
async def vectorise(req: VectoriseRequest) -> dict:
    try:
        geom = shape(req.geometry)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"invalid geometry: {e}"
        ) from e

    if geom.geom_type != "Polygon":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"expected a Polygon, got {geom.geom_type}",
        )

    morph = compute_morphology(geom)
    return {
        "morphology": morphology_to_dict(morph),
        "areaKm2": round(morph.area_km2, 4),
        "perimeterKm": round(morph.perimeter_km, 4),
        "projection": "local Lambert Azimuthal Equal-Area centred on the feature",
        "provenance": derived(
            external_id="vectorise", parents=[], dataset_id="varuna-morphology"
        ).model_dump(),
    }
