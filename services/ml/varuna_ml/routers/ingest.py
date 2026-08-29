"""Ingest + detection endpoints — 07_AIML 7.8.

Internal only: every route is behind `require_service_token`, because these endpoints
consume provider quota and write to object storage (02_TRD SEC-10).
"""

from __future__ import annotations

import logging

import boto3
import rasterio
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from rasterio.session import AWSSession
from rasterio.warp import transform_bounds

from ..config import get_settings
from ..detect.darkspot import detect, to_geojson
from ..detect.landmask import CoastlineUnavailable, coastline_mask
from ..geo.gsd import pixel_size_metres
from ..ingest.adopt import adopt_upload
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


class AdoptRequest(BaseModel):
    """An operator-supplied scene already written to object storage."""

    bucket: str
    key: str
    productId: str
    """Observation time, from the UPLOADER — never read from the file.

    `TIFFTAG_DATETIME` records when the file was WRITTEN, which for a re-exported product is
    the day someone opened it in a GIS. Every AIS correlation is a query in a window around
    this instant, so taking it from the file would search the wrong day and rank vessels that
    were nowhere near the spill.
    """
    acquiredAt: str
    platform: str | None = None
    polarisation: str = "VV"
    uploadedBy: str | None = None
    originalName: str | None = None
    checksum: str | None = None


@router.post("/adopt")
async def adopt(req: AdoptRequest) -> dict:
    """Describe an uploaded GeoTIFF: CRS, bounds, ground sample distance, radiometry.

    This is where the CRS is actually RESOLVED, as opposed to merely being present in the
    header — the check the API makes on upload is a header check, and a GeoTIFF can name a
    coordinate system that pyproj cannot construct. Refusing here is the last chance before
    detections are produced in pixel space and written out as positions on the Earth.
    """
    try:
        result = adopt_upload(
            req.bucket,
            req.key,
            req.acquiredAt,
            product_id=req.productId,
            platform=req.platform,
            polarisation=req.polarisation,
            uploaded_by=req.uploadedBy,
            original_name=req.originalName,
            checksum=req.checksum,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"could not read s3://{req.bucket}/{req.key}: {e}",
        ) from e

    d = result.__dict__.copy()
    return d


class DetectRequest(BaseModel):
    bucket: str
    key: str
    """dB contrast against the local sea background that counts as 'dark'."""
    contrastDb: float = 3.0
    minAreaKm2: float = 0.05
    windMs: float | None = None
    """Metres of coastal water given up to absorb coastline-versus-SAR disagreement.
    See `detect/landmask.py` for why the buffer only ever grows the land."""
    coastBufferM: float = 500.0


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

    with (
        rasterio.Env(
            AWSSession(session, endpoint_url=settings.s3_endpoint.replace("http://", "")),
            AWS_HTTPS="NO",
            AWS_VIRTUAL_HOSTING="FALSE",
        ),
        rasterio.open(f"s3://{req.bucket}/{req.key}") as ds,
    ):
        arr = ds.read(1)
        transform = ds.transform
        crs = ds.crs
        shape_hw = (ds.height, ds.width)
        # NOT `abs(transform.a)`. That is the pixel width in CRS UNITS, which are metres only
        # for a projected CRS. Every Sentinel-1 RTC product arrives in UTM, so it was right by
        # accident until uploaded scenes — frequently EPSG:4326 — reached this path, where it
        # reported 0.0001 m per pixel and the min-area gate silently dropped every detection.
        bounds_wgs84 = transform_bounds(ds.crs, "EPSG:4326", *ds.bounds, densify_pts=21)
        pixel_m = pixel_size_metres(ds.transform, ds.crs, bounds_wgs84)

    # The GEOMETRIC land mask, unioned with the brightness one inside `detect`.
    #
    # This was originally wired only into `/segment`, which the ingest chain does not call —
    # so the mask existed, was tested, and never ran on a single real detection. Anything that
    # protects a result has to sit on the path the result actually takes.
    try:
        land = coastline_mask(shape_hw, transform, crs, buffer_m=req.coastBufferM)
    except CoastlineUnavailable as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"coastline mask unavailable, refusing to detect on brightness alone: {e}",
        ) from e

    spots = detect(
        arr,
        pixel_size_m=pixel_m,
        contrast_db=req.contrastDb,
        min_area_km2=req.minAreaKm2,
        wind_ms=req.windMs,
        coastline=land.mask,
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
        # Reported, not merely applied. An analyst reading a null result on a coastal scene
        # has to know how much of the near-shore was never examined, and a scene that comes
        # back 96% land was never going to find anything.
        "landMask": {
            "source": "Natural Earth (vendored, public domain)",
            "resolution": land.resolution,
            "bufferMetres": land.buffer_m,
            "landFraction": round(land.land_fraction, 4),
            "coastalWaterExcludedFraction": round(land.buffered_fraction, 4),
        },
        "provenance": derived(
            external_id=f"detect:{req.key}", parents=[], dataset_id="classical-darkspot-v1"
        ).model_dump(),
    }
