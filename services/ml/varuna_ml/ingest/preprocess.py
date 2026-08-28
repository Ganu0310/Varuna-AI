"""Scene ingest: windowed provider read to a Cloud-Optimised GeoTIFF in object storage.

Phase 4 (IMPLEMENTATION_PLAN 14.6). The design decision that shapes this module:

    We do NOT download the whole product. A Sentinel-1 GRD swath is ~250 km wide and
    1-2 GB per polarisation, while an investigation AOI is typically a few tens of km.
    Because the provider serves Cloud-Optimised GeoTIFFs, GDAL can issue HTTP range
    requests for just the tiles covering the AOI. In practice that is ~15 s and a few tens
    of MB instead of a multi-gigabyte transfer, and it is why ingest fits inside an
    interactive workflow at all.

The second decision: we read from the **RTC** collection, not GRD. Sentinel-1 GRD is
delivered in radar geometry with no CRS - it must be terrain-corrected before any pixel can
be given a coordinate. Planetary Computer's `sentinel-1-rtc` is already radiometrically
terrain-corrected and map-projected (UTM), which removes the entire SNAP dependency from
the critical path (07_AIML 7.2.4). When RTC does not cover a scene, ingest reports that
plainly rather than silently falling back to ungeocoded data.

Everything written here carries the provider's own identifiers so the output can be traced
back to the exact product (13_REAL_DATA_POLICY 13.5).
"""

from __future__ import annotations

import io
import json
import os
import time
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

import boto3
import numpy as np
import rasterio
from botocore.client import Config
from rasterio.io import MemoryFile
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds
from rio_cogeo.cogeo import cog_translate
from rio_cogeo.profiles import cog_profiles

from ..config import get_settings

STAC_SEARCH = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
SAS_TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/{collection}"

# GDAL must not list the whole blob container, and must only consider raster extensions;
# without these a windowed read over HTTP degrades into hundreds of pointless requests.
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")


@dataclass
class IngestResult:
    product_id: str
    collection: str
    acquired_at: str
    platform: str
    polarisations: list[str]
    orbit_direction: str | None
    mode: str | None
    crs: str
    pixel_size_m: float
    width: int
    height: int
    bucket: str
    cog_keys: dict[str, str]
    size_bytes: int
    aoi_bounds: list[float]
    valid_pixel_fraction: float
    preprocessing: str
    seconds: float
    provenance: dict


def _sas(collection: str) -> str:
    with urllib.request.urlopen(SAS_TOKEN.format(collection=collection), timeout=30) as r:
        return json.load(r)["token"]


def _stac_item(collection: str, product_id: str) -> dict:
    req = urllib.request.Request(
        STAC_SEARCH,
        data=json.dumps({"collections": [collection], "ids": [product_id]}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        feats = json.load(r).get("features", [])
    if not feats:
        raise LookupError(f"{product_id} not found in collection {collection}")
    return feats[0]


def _s3():
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint,
        aws_access_key_id=s.s3_access_key_id,
        aws_secret_access_key=s.s3_secret_access_key,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        region_name=s.s3_region,
    )


def _read_window(href: str, aoi: tuple[float, float, float, float]):
    """Read only the AOI window, returning (array, transform, crs, pixel_size_m)."""
    with rasterio.open(href) as ds:
        if ds.crs is None:
            raise ValueError(
                "asset has no CRS - this is a radar-geometry product and must be "
                "terrain-corrected before ingest (use the RTC collection)"
            )
        left, bottom, right, top = transform_bounds("EPSG:4326", ds.crs, *aoi)
        win = from_bounds(left, bottom, right, top, ds.transform)
        arr = ds.read(1, window=win)
        return arr, ds.window_transform(win), ds.crs, float(abs(ds.transform.a))


def _write_cog(arr: np.ndarray, transform, crs) -> bytes:
    """Write an in-memory Cloud-Optimised GeoTIFF (tiled + internal overviews).

    COG is what lets TiTiler serve XYZ tiles straight from object storage with no tile
    pre-generation step (03_ARCHITECTURE 3.7.2) - the map reads the same bytes the analysis
    ran on, so what is displayed cannot drift from what was measured.
    """
    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "count": 1,
        "height": arr.shape[0],
        "width": arr.shape[1],
        "crs": crs,
        "transform": transform,
        "nodata": float("nan"),
    }
    with MemoryFile() as src_mem:
        with src_mem.open(**profile) as src:
            src.write(arr.astype("float32"), 1)
        with MemoryFile() as dst_mem:
            with src_mem.open() as src:
                cog_translate(
                    src,
                    dst_mem.name,
                    cog_profiles.get("deflate"),
                    in_memory=True,
                    quiet=True,
                )
            return dst_mem.read()


def ingest_scene(
    product_id: str,
    aoi: tuple[float, float, float, float],
    collection: str = "sentinel-1-rtc",
    polarisations: tuple[str, ...] = ("vv", "vh"),
) -> IngestResult:
    """Fetch the AOI window of one scene, convert to COG, and store it.

    `aoi` is (west, south, east, north) in EPSG:4326.
    """
    started = time.time()
    settings = get_settings()

    item = _stac_item(collection, product_id)
    token = _sas(collection)
    props = item.get("properties", {})

    acquired_at = props.get("datetime") or props.get("start_datetime")
    if not acquired_at:
        # A scene with no acquisition time cannot be correlated in time; refuse it rather
        # than inventing one (02_TRD TR-9).
        raise ValueError(f"{product_id} has no acquisition timestamp")

    s3 = _s3()
    cog_keys: dict[str, str] = {}
    total_bytes = 0
    meta = {"crs": "", "pixel": 0.0, "w": 0, "h": 0, "valid": 0.0}

    for pol in polarisations:
        asset = item["assets"].get(pol)
        if asset is None:
            continue

        arr, transform, crs, pixel_m = _read_window(f"{asset['href']}?{token}", aoi)
        if arr.size == 0:
            raise ValueError(f"AOI does not intersect {product_id} ({pol})")

        finite = np.isfinite(arr) & (arr > 0)
        valid_fraction = float(finite.sum() / arr.size) if arr.size else 0.0

        # Store NaN outside the valid footprint so the tiler renders it transparent rather
        # than as a black rectangle that could be mistaken for a very dark sea surface.
        clean = np.where(finite, arr, np.nan).astype("float32")

        blob = _write_cog(clean, transform, crs)
        key = f"scenes/{product_id}/{pol}.tif"
        s3.put_object(
            Bucket=settings.s3_bucket,
            Key=key,
            Body=io.BytesIO(blob),
            ContentType="image/tiff; application=geotiff; profile=cloud-optimized",
        )
        cog_keys[pol] = key
        total_bytes += len(blob)
        meta = {
            "crs": str(crs),
            "pixel": pixel_m,
            "w": int(arr.shape[1]),
            "h": int(arr.shape[0]),
            "valid": valid_fraction,
        }

    if not cog_keys:
        raise ValueError(f"{product_id} exposes none of the requested polarisations")

    provenance = {
        "sourceType": "SATELLITE_SCENE",
        "provider": "Microsoft Planetary Computer",
        "datasetId": collection,
        "externalId": product_id,
        "retrievedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "licence": "Copernicus Sentinel Data - free, full and open",
        "accessUrl": f"https://planetarycomputer.microsoft.com/api/stac/v1/collections/{collection}/items/{product_id}",
        "derivedFrom": [],
    }

    return IngestResult(
        product_id=product_id,
        collection=collection,
        acquired_at=acquired_at,
        platform=str(props.get("platform", "")).upper(),
        polarisations=[p.upper() for p in cog_keys],
        orbit_direction=(
            str(props["sat:orbit_state"]).upper() if props.get("sat:orbit_state") else None
        ),
        mode=props.get("sar:instrument_mode"),
        crs=meta["crs"],
        pixel_size_m=meta["pixel"],
        width=meta["w"],
        height=meta["h"],
        bucket=settings.s3_bucket,
        cog_keys=cog_keys,
        size_bytes=total_bytes,
        aoi_bounds=list(aoi),
        valid_pixel_fraction=meta["valid"],
        # RTC arrives already radiometrically terrain corrected: SNAP steps 1-6 of
        # 07_AIML 7.2.4 were applied by the provider, not skipped.
        preprocessing="MPC_RTC" if collection.endswith("rtc") else "NONE",
        seconds=round(time.time() - started, 1),
        provenance=provenance,
    )


def result_to_dict(r: IngestResult) -> dict:
    return asdict(r)
