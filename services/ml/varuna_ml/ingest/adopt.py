"""Adopt an operator-supplied SAR scene.

The catalogue path (`ingest_scene`) knows the product it is fetching: the STAC item states the
acquisition time, the platform, the polarisations and the processing level, and the pixels
arrive already radiometrically terrain-corrected. None of that is true of a file somebody
uploads.

So this reads what the file itself can prove and REFUSES to guess the rest:

  * CRS, transform, size and bounds come from the GeoTIFF and are authoritative.
  * Pixel size is computed from the transform, reprojected to metres when the file is in a
    geographic CRS — a scene in EPSG:4326 has a transform in degrees, and treating 0.0001° as
    0.0001 m would report a 10 m scene as a 10 cm one and make every area wrong by 10^10.
  * Acquisition time is taken from the CALLER, not from the file. `TIFFTAG_DATETIME` is when
    the file was written, which for a re-exported product is the day someone opened it in
    QGIS. Attributing a spill using that as the observation time would search AIS in the wrong
    window entirely, so a wrong answer here is worse than no answer.
  * Platform, mode and orbit direction are left null unless the caller supplies them. An
    uploaded scene is not known to be Sentinel-1.

Radiometry is the honest limit and is recorded rather than assumed. The detector expects
linear Sigma0; an upload might be Sigma0, Beta0, amplitude, or 8-bit greyscale from a
screenshot. `probe_radiometry` reports what the values look like so the caller can label the
result, and the manifest says `OPERATOR_SUPPLIED` so nothing downstream can mistake this for a
provider product.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np

from ..geo.gsd import pixel_size_metres


@dataclass
class AdoptedScene:
    product_id: str
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
    radiometry: dict


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def probe_radiometry(arr: np.ndarray) -> dict:
    """What kind of values are these, and can the detector read them?

    The dark-spot detector converts linear Sigma0 to dB. Handing it 8-bit greyscale, or values
    already in dB, produces a plausible-looking result computed from the wrong quantity — the
    worst failure mode available, because nothing about the output looks wrong.

    This does not correct anything. It reports, so the label travels with the detection.
    """
    finite = arr[np.isfinite(arr)]
    if finite.size == 0:
        return {"kind": "EMPTY", "usable": False, "note": "No finite pixels in the scene."}

    lo = float(np.percentile(finite, 2))
    hi = float(np.percentile(finite, 98))
    vmin, vmax = float(finite.min()), float(finite.max())

    # Linear Sigma0 over water sits well below 1; land pushes the top end up but rarely past a
    # few units.
    if vmin >= 0.0 and hi <= 5.0:
        return {
            "kind": "LINEAR_SIGMA0",
            "usable": True,
            "p2": lo,
            "p98": hi,
            "note": "Values are consistent with linear Sigma0, which is what the detector expects.",
        }

    # Already in dB: backscatter in dB is negative over water, typically -25 to -5.
    if vmin < 0.0 and vmax <= 40.0:
        return {
            "kind": "DECIBELS",
            "usable": False,
            "p2": lo,
            "p98": hi,
            "note": (
                "Values look like dB, not linear Sigma0. The detector converts to dB itself, so "
                "it would take the logarithm twice and the contrast threshold would mean nothing. "
                "Upload the linear product."
            ),
        }

    # 8-bit or 16-bit integer imagery — a quicklook or a screenshot, not calibrated radar.
    if vmin >= 0.0 and vmax > 5.0:
        return {
            "kind": "UNCALIBRATED_DN",
            "usable": False,
            "p2": lo,
            "p98": hi,
            "note": (
                "Values look like uncalibrated digital numbers (a quicklook or a rendered "
                "image), not calibrated backscatter. Dark features can still be seen by eye, but "
                "the contrast threshold and every derived confidence would be meaningless."
            ),
        }

    return {
        "kind": "UNKNOWN",
        "usable": False,
        "p2": lo,
        "p98": hi,
        "note": "Value range does not match any expected SAR product.",
    }


def adopt_upload(
    bucket: str,
    key: str,
    acquired_at: str,
    *,
    product_id: str,
    platform: str | None = None,
    polarisation: str = "VV",
    uploaded_by: str | None = None,
    original_name: str | None = None,
    checksum: str | None = None,
) -> AdoptedScene:
    """Read an uploaded GeoTIFF already in object storage and describe it honestly.

    Raises `ValueError` when the file cannot be positioned on the Earth — the same refusal the
    API makes on the header, repeated here because this is the first point where the CRS is
    actually resolved rather than merely present.
    """
    import boto3
    import rasterio
    from rasterio.session import AWSSession
    from rasterio.warp import transform_bounds

    from ..config import get_settings

    started = time.time()
    s = get_settings()
    session = boto3.Session(
        aws_access_key_id=s.s3_access_key_id,
        aws_secret_access_key=s.s3_secret_access_key,
        region_name=s.s3_region,
    )

    with (
        rasterio.Env(
            AWSSession(session, endpoint_url=s.s3_endpoint.replace("http://", "")),
            AWS_HTTPS="NO",
            AWS_VIRTUAL_HOSTING="FALSE",
        ),
        rasterio.open(f"s3://{bucket}/{key}") as ds,
    ):
        if ds.crs is None:
            raise ValueError(
                "The file has no coordinate reference system, so its pixels cannot be "
                "placed on the Earth."
            )
        if ds.transform is None or ds.transform.is_identity:
            raise ValueError(
                "The file has no geotransform (its transform is the identity), so its "
                "pixels have no position. Detections from it would be in pixel space."
            )

        arr = ds.read(1)
        bounds_native = ds.bounds
        crs = ds.crs.to_string()
        width, height = ds.width, ds.height
        transform = ds.transform

    bounds_wgs84 = list(transform_bounds(crs, "EPSG:4326", *bounds_native, densify_pts=21))
    pixel_m = pixel_size_metres(transform, crs, bounds_wgs84)
    radiometry = probe_radiometry(arr)

    finite = int(np.isfinite(arr).sum())
    valid_fraction = finite / float(arr.size) if arr.size else 0.0

    return AdoptedScene(
        product_id=product_id,
        acquired_at=acquired_at,
        # Never guessed. An uploaded scene is not known to be Sentinel-1, and writing a
        # platform name the file does not state would put a fabricated fact in the dossier.
        platform=platform or "OPERATOR_SUPPLIED",
        polarisations=[polarisation],
        orbit_direction=None,
        mode=None,
        crs=crs,
        pixel_size_m=pixel_m,
        width=width,
        height=height,
        bucket=bucket,
        cog_keys={polarisation.lower(): key},
        # Not read back from the raster: the API already knows the uploaded byte count and
        # records it. Asking rasterio would only re-derive it, less reliably.
        size_bytes=0,
        aoi_bounds=bounds_wgs84,
        valid_pixel_fraction=valid_fraction,
        preprocessing="NONE — supplied already processed by the operator",
        seconds=time.time() - started,
        radiometry=radiometry,
        provenance={
            "sourceType": "SATELLITE_SCENE",
            "provider": "OPERATOR_SUPPLIED",
            "datasetId": "operator-upload",
            "externalId": checksum or product_id,
            # When the scene entered VARUNA's custody. Not a retrieval from a published
            # archive — `provider` already says that — but a real, recorded moment, and the
            # field means custody rather than provenance-of-origin.
            "retrievedAt": _now_iso(),
            "licence": "Unknown — supplied by the operator",
            # ABSENT, not null: there is no URL an evaluator could fetch this from, and
            # writing an empty string or a placeholder would imply there is.
            "uploadedBy": uploaded_by,
            "originalName": original_name,
            "checksum": checksum,
            "note": (
                "VARUNA did not retrieve this scene from a published archive and cannot verify "
                "its origin, processing history or acquisition time. The acquisition time was "
                "supplied by the uploader, and every AIS correlation depends on it being right."
            ),
        },
    )
