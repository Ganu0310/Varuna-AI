"""Ingest + detection endpoints — 07_AIML 7.8.

Internal only: every route is behind `require_service_token`, because these endpoints
consume provider quota and write to object storage (02_TRD SEC-10).
"""

from __future__ import annotations

import logging

import numpy as np
import rasterio
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from rasterio.session import AWSSession
import boto3

from ..config import get_settings
from ..detect.darkspot import detect, to_geojson
from ..ingest.preprocess import ingest_scene, result_to_dict
from ..provenance import derived
from ..security import require_service_token

log = logging.getLogger("varuna_ml.ingest")
router = APIRouter(tags=["ingest"], dependencies=[Depends(require_service_token)])


class IngestRequest(BaseModel):
    productId: str
    """[west, south, east, north] in EPSG:4326."""
    aoi: list[float] = Field(min_length=4, max_length=4)
    collection: str = "sentinel-1-rtc"


@router.post("/ingest")
async def ingest(req: IngestRequest) -> dict:
    """Fetch the AOI window of one scene, write COGs to object storage, return metadata."""
    try:
        result = ingest_scene(
            req.productId, (req.aoi[0], req.aoi[1], req.aoi[2], req.aoi[3]), req.collection
        )
    except LookupError as e:
        # The scene is genuinely absent from that collection — a real answer, not a fault.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
    return result_to_dict(result)


class DetectRequest(BaseModel):
    bucket: str
    key: str
    """dB contrast against the local sea background that counts as 'dark'."""
    contrastDb: float = 3.0
    minAreaKm2: float = 0.05
    windMs: float | None = None


@router.post("/detect")
async def run_detection(req: DetectRequest) -> dict:
    """Run the classical dark-spot detector over a stored COG.

    Returns georeferenced polygons with their metrics and an explicit look-alike risk per
    detection. `windMs` is optional; when absent the wind-suitability term reports 0.5
    (unknown) rather than assuming conditions were good (07_AIML 7.2.3).
    """
    settings = get_settings()
    session = boto3.Session(
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
        region_name=settings.s3_region,
    )

    with rasterio.Env(
        AWSSession(session, endpoint_url=settings.s3_endpoint.replace("http://", "")),
        AWS_HTTPS="NO",
        AWS_VIRTUAL_HOSTING="FALSE",
    ):
        with rasterio.open(f"s3://{req.bucket}/{req.key}") as ds:
            arr = ds.read(1)
            transform = ds.transform
            crs = ds.crs
            pixel_m = float(abs(ds.transform.a))

    spots = detect(
        arr,
        pixel_size_m=pixel_m,
        contrast_db=req.contrastDb,
        min_area_km2=req.minAreaKm2,
        wind_ms=req.windMs,
    )
    features = to_geojson(spots, transform, crs)

    return {
        "detections": features,
        "detector": {
            "name": "classical-darkspot",
            "version": "1.0.0",
            "method": "adaptive local threshold + morphology + shape scoring",
            "contrastDb": req.contrastDb,
            "minAreaKm2": req.minAreaKm2,
            "windSuitabilityKnown": req.windMs is not None,
            # Stated in the response so a consumer cannot mistake this for a learned model.
            "limitation": (
                "Classical detector: it locates dark features and scores how oil-like each "
                "is, but cannot separate oil from look-alikes by texture. Read lookAlikeRisk "
                "alongside confidence."
            ),
        },
        "scene": {"bucket": req.bucket, "key": req.key, "pixelSizeM": pixel_m},
        "provenance": derived(
            external_id=f"detect:{req.key}", parents=[], dataset_id="classical-darkspot-v1"
        ).model_dump(),
    }
