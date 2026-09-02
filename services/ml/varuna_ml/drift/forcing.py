"""Environmental forcing for drift back-tracking — 07_AIML 7.3, 10_DATASETS 10.5.

Currents and winds come from real ocean/atmosphere models. There is no synthetic fallback:
if no provider covers the region and date, the drift run degrades and says so
(13_REAL_DATA_POLICY 13.8). Inventing a current field would produce an origin zone that
looks authoritative and means nothing.

Provider chains, best-quality first, keyless last:

    CURRENTS   CMEMS (credentials) -> HYCOM (keyless OPeNDAP)
    WIND       ERA5 local file (operator-supplied) -> ERA5 CDS API (credentials)

Every attempt against every provider is recorded and returned to the caller, whether it
succeeded, timed out, was not configured, or had no data for the window. A chain that falls
through silently is indistinguishable from a chain that was never tried, and the difference
is exactly what an analyst needs to know when the origin estimate comes back degraded.

A real and load-bearing gap, discovered by probing rather than assumed: HYCOM's reanalysis
archive (GLBy0.08/expt_93.0) ends 2024-09-05 while its operational feed only covers roughly
the last two weeks. Dates in between have NO keyless current coverage, so an incident in
that gap requires CMEMS credentials. `coverage()` reports this honestly instead of silently
returning the nearest available field, which would attribute a spill using currents from a
different year.
"""

from __future__ import annotations

import contextlib
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import numpy as np

log = logging.getLogger("varuna_ml.drift.forcing")

HYCOM_ARCHIVE = "https://tds.hycom.org/thredds/dodsC/GLBy0.08/expt_93.0/uv3z"
HYCOM_OPERATIONAL = (
    "https://tds.hycom.org/thredds/dodsC/FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd"
)

# GLOBAL_ANALYSISFORECAST_PHY_001_024, hourly-mean surface fields at 1/12 degree.
CMEMS_DATASET_ID = "cmems_mod_glo_phy_anfc_0.083deg_PT1H-m"

# ERA5 10 m wind never approaches this anywhere on Earth; the record surface gust is
# well under it and a reanalysis mean is lower still. Anything above is a different
# variable, not a strong wind.
MAX_PLAUSIBLE_WIND_MS = 60.0

# The Climate Data Store endpoint. Overridable per deployment via CDSAPI_URL.
CDS_DEFAULT_URL = "https://cds.climate.copernicus.eu/api"


class ForcingUnavailable(RuntimeError):
    """No provider covers this region and time. Carries what was tried and what it means."""

    def __init__(self, kind: str, attempted: list[dict], consequence: str):
        self.kind = kind
        self.attempted = attempted
        self.consequence = consequence
        super().__init__(f"{kind} forcing unavailable: {consequence}")


class ForcingTimeout(RuntimeError):
    """One provider exceeded its deadline. Distinct from "no data": the difference decides
    whether retrying is worth anything."""


def _classify(exc: BaseException) -> str:
    """Map a provider exception onto a stable outcome code for the `attempted` record.

    The codes are what the UI and the dossier display, so they are deliberately coarse and
    stable rather than echoing a library's error text, which changes between versions.
    """
    if isinstance(exc, ForcingTimeout | TimeoutError):
        return "TIMEOUT"
    if isinstance(exc, FileNotFoundError):
        return "NOT_FOUND_404"
    if isinstance(exc, ConnectionError):
        return "UNREACHABLE"
    text = f"{type(exc).__name__}: {exc}".lower()
    if "401" in text or "unauthor" in text or "invalid username or password" in text:
        return "AUTH_FAILED_401"
    if "403" in text or "forbidden" in text:
        return "FORBIDDEN_403"
    if "404" in text or "not found" in text:
        return "NOT_FOUND_404"
    if "no data" in text or "empty" in text or "out of range" in text:
        return "NO_DATA"
    if "timed out" in text or "timeout" in text:
        return "TIMEOUT"
    if "connection" in text or "network" in text or "resolve" in text or "dns" in text:
        return "UNREACHABLE"
    return "ERROR"


def _call_with_deadline(fn, timeout_s: float, retries: int, label: str) -> object:
    """Run a blocking provider call with a wall-clock deadline and bounded retries.

    The provider libraries here (copernicusmarine, netCDF4/OPeNDAP, cdsapi) are synchronous
    and have no uniform timeout parameter, so the deadline is imposed from outside on a
    worker thread. A thread that overruns cannot be killed; it is abandoned, and the drift
    run degrades on schedule rather than hanging a job queue behind a provider outage.

    Retries cover only transport-shaped failures. An authentication failure or an
    out-of-coverage window is not going to change on a second attempt, and retrying it
    wastes the deadline the analyst is waiting on.
    """
    from concurrent.futures import ThreadPoolExecutor
    from concurrent.futures import TimeoutError as FutureTimeout

    last: BaseException | None = None
    for attempt in range(1, max(1, retries) + 1):
        pool = ThreadPoolExecutor(max_workers=1)
        try:
            future = pool.submit(fn)
            try:
                return future.result(timeout=timeout_s)
            except FutureTimeout as e:
                future.cancel()
                last = ForcingTimeout(f"{label} exceeded {timeout_s:.0f}s")
                log.warning("%s timed out after %.0fs (attempt %d)", label, timeout_s, attempt)
                raise last from e
        except ForcingTimeout:
            raise
        except Exception as e:  # noqa: BLE001 - classified, then re-raised or retried
            last = e
            code = _classify(e)
            if code in {"AUTH_FAILED_401", "FORBIDDEN_403", "NOT_FOUND_404", "NO_DATA"}:
                raise
            log.warning("%s failed (%s, attempt %d/%d): %s", label, code, attempt, retries, e)
        finally:
            pool.shutdown(wait=False)
    raise last if last else RuntimeError(f"{label} failed with no exception recorded")


@dataclass
class ForcingField:
    """A regularly gridded (time, lat, lon) vector field with its provenance."""

    kind: str  # 'CURRENTS' | 'WIND'
    u: np.ndarray  # (nt, nlat, nlon) eastward component, m/s
    v: np.ndarray  # northward component, m/s
    times: list[datetime]
    lats: np.ndarray
    lons: np.ndarray
    provider: str
    dataset_id: str
    resolution_deg: float
    temporal_resolution_h: float
    provenance: dict = field(default_factory=dict)

    def sample(
        self, t: datetime, lat: np.ndarray, lon: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """Trilinear sample at (t, lat, lon). Out-of-grid particles return 0 rather than
        wrapping to the far side of the domain."""
        ti = self._time_index(t)
        u = _bilinear(self.u[ti], self.lats, self.lons, lat, lon)
        v = _bilinear(self.v[ti], self.lats, self.lons, lat, lon)
        return u, v

    def _time_index(self, t: datetime) -> int:
        if len(self.times) == 1:
            return 0
        deltas = [abs((t - tt).total_seconds()) for tt in self.times]
        return int(np.argmin(deltas))

    def median_speed(self) -> float:
        finite = np.isfinite(self.u) & np.isfinite(self.v)
        if not finite.any():
            return 0.0
        return float(np.median(np.hypot(self.u[finite], self.v[finite])))


def _bilinear(
    grid: np.ndarray,
    lats: np.ndarray,
    lons: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
) -> np.ndarray:
    """Bilinear interpolation over a partially land-masked grid. Outside the grid yields 0.

    THE COASTAL-CELL TRAP, and why the weights are renormalised rather than the result being
    NaN-filled afterwards.

    Ocean models mask land as NaN. A slick released from a harbour sits, by definition, in the
    cells where some corners are land. Interpolating those corners arithmetically and cleaning
    up afterwards does not work: NaN propagates through the sum, so ONE land corner turns the
    whole cell to NaN, which then becomes 0 — a dead-calm sea, exactly where the water is
    moving and exactly where the answer matters.

    Measured on the Guam demo: three of the four corners around the slick carried real
    velocities of -0.08 to -0.15 m/s, the fourth was land, and the sampler returned 0.000.
    The back-track then produced an origin zone 40 m from the slick it started at, labelled
    LAGRANGIAN_BACKTRACK — a drift result with no drift in it.

    So the weights are renormalised over the FINITE corners only. Three wet corners give the
    honest average of three wet corners. Only when all four are land does the point get 0,
    which is the one case where "no water here" is a true statement rather than a fill value.
    """
    out = np.zeros_like(lat, dtype=float)

    li = np.searchsorted(lats, lat) - 1
    ci = np.searchsorted(lons, lon) - 1
    inside = (li >= 0) & (li < len(lats) - 1) & (ci >= 0) & (ci < len(lons) - 1)
    if not inside.any():
        return out

    li_i = np.clip(li[inside], 0, len(lats) - 2)
    ci_i = np.clip(ci[inside], 0, len(lons) - 2)
    la, lo = lat[inside], lon[inside]

    y0, y1 = lats[li_i], lats[li_i + 1]
    x0, x1 = lons[ci_i], lons[ci_i + 1]
    wy = np.where(y1 != y0, (la - y0) / np.where(y1 != y0, y1 - y0, 1), 0.0)
    wx = np.where(x1 != x0, (lo - x0) / np.where(x1 != x0, x1 - x0, 1), 0.0)

    corners = np.stack(
        [
            np.asarray(grid[li_i, ci_i], dtype=float),
            np.asarray(grid[li_i, ci_i + 1], dtype=float),
            np.asarray(grid[li_i + 1, ci_i], dtype=float),
            np.asarray(grid[li_i + 1, ci_i + 1], dtype=float),
        ]
    )
    weights = np.stack([(1 - wx) * (1 - wy), wx * (1 - wy), (1 - wx) * wy, wx * wy])

    wet = np.isfinite(corners)
    w = np.where(wet, weights, 0.0)
    denom = w.sum(axis=0)
    numer = (w * np.where(wet, corners, 0.0)).sum(axis=0)

    # denom == 0 means every corner is land (or the wet corners carry zero weight because the
    # point sits exactly on a dry node). That is the only case where 0 is a measurement.
    vals = np.divide(numer, denom, out=np.zeros_like(numer), where=denom > 0)

    out[inside] = vals
    return out


def coverage(source_url: str) -> tuple[datetime, datetime] | None:
    """Temporal extent of an OPeNDAP dataset, or None if it cannot be opened."""
    try:
        import cftime
        import netCDF4 as nc

        ds = nc.Dataset(source_url)
        t = ds.variables["time"]
        d = cftime.num2date(t[:], t.units)
        first = datetime(d[0].year, d[0].month, d[0].day, d[0].hour, tzinfo=UTC)
        last = datetime(d[-1].year, d[-1].month, d[-1].day, d[-1].hour, tzinfo=UTC)
        ds.close()
        return first, last
    except Exception as e:  # noqa: BLE001 - any transport failure is "cannot determine"
        log.warning("could not read coverage for %s: %s", source_url, e)
        return None


def fetch_hycom_currents(
    bbox: tuple[float, float, float, float],
    start: datetime,
    end: datetime,
) -> ForcingField:
    """Surface currents from HYCOM over OPeNDAP. Keyless.

    Raises ForcingUnavailable when the date falls outside both the archive and the
    operational window — the gap is real and must not be papered over.
    """
    import cftime
    import netCDF4 as nc

    attempted: list[dict] = []

    for name, url in (
        ("HYCOM_ARCHIVE", HYCOM_ARCHIVE),
        ("HYCOM_OPERATIONAL", HYCOM_OPERATIONAL),
    ):
        cov = coverage(url)
        if cov is None:
            attempted.append({"provider": name, "outcome": "UNREACHABLE"})
            continue
        if not (cov[0] <= start and end <= cov[1]):
            attempted.append(
                {
                    "provider": name,
                    "outcome": "OUT_OF_COVERAGE",
                    "covers": f"{cov[0]:%Y-%m-%d} to {cov[1]:%Y-%m-%d}",
                }
            )
            continue

        ds = nc.Dataset(url)
        try:
            lats = np.asarray(ds.variables["lat"][:])
            lons_raw = np.asarray(ds.variables["lon"][:])
            # HYCOM publishes longitude on 0..360; the rest of the system is -180..180.
            lons = np.where(lons_raw > 180, lons_raw - 360, lons_raw)
            order = np.argsort(lons)
            lons_sorted = lons[order]

            w, s, e, n = bbox
            la = np.where((lats >= s - 0.5) & (lats <= n + 0.5))[0]
            lo = np.where((lons_sorted >= w - 0.5) & (lons_sorted <= e + 0.5))[0]
            if la.size == 0 or lo.size == 0:
                attempted.append({"provider": name, "outcome": "OUT_OF_SPATIAL_COVERAGE"})
                continue

            tvar = ds.variables["time"]
            tvals = cftime.num2date(tvar[:], tvar.units)
            keep = [
                i
                for i, tt in enumerate(tvals)
                if start - timedelta(hours=3)
                <= datetime(tt.year, tt.month, tt.day, tt.hour, tzinfo=UTC)
                <= end + timedelta(hours=3)
            ]
            if not keep:
                attempted.append({"provider": name, "outcome": "NO_TIME_STEPS_IN_WINDOW"})
                continue

            # depth index 0 is the surface layer, which is what a slick drifts with.
            #
            # CRITICAL: keep the MaskedArray. `np.asarray()` on a masked array strips the
            # mask and exposes the raw _FillValue (-30000 in HYCOM), which then reads as a
            # velocity of -30000 m/s and hurls particles across the globe in one step. This
            # is the same in-band-sentinel failure as AIS SOG 102.3, and it must be handled
            # the same way: convert the fill to NaN, never to a number.
            u_ma = ds.variables["water_u"][keep, 0, la[0] : la[-1] + 1, :]
            v_ma = ds.variables["water_v"][keep, 0, la[0] : la[-1] + 1, :]
            u = np.ma.filled(np.ma.masked_invalid(u_ma.astype("float64")), np.nan)
            v = np.ma.filled(np.ma.masked_invalid(v_ma.astype("float64")), np.nan)
            u = u[:, :, order][:, :, lo[0] : lo[-1] + 1]
            v = v[:, :, order][:, :, lo[0] : lo[-1] + 1]

            # Belt and braces: any sentinel that survived masking is not a current. Ocean
            # surface currents do not exceed a few m/s, so anything larger is a fill value.
            u = np.where(np.abs(u) > 10.0, np.nan, u)
            v = np.where(np.abs(v) > 10.0, np.nan, v)

            times = [
                datetime(
                    tvals[i].year,
                    tvals[i].month,
                    tvals[i].day,
                    tvals[i].hour,
                    tzinfo=UTC,
                )
                for i in keep
            ]

            if not np.isfinite(u).any():
                attempted.append({"provider": name, "outcome": "ALL_CELLS_MASKED"})
                continue

            return ForcingField(
                kind="CURRENTS",
                u=u,
                v=v,
                times=times,
                lats=lats[la[0] : la[-1] + 1],
                lons=lons_sorted[lo[0] : lo[-1] + 1],
                provider="HYCOM",
                dataset_id=name,
                resolution_deg=0.08,
                temporal_resolution_h=3.0,
                provenance={
                    "sourceType": "OCEAN_MODEL",
                    "provider": "HYCOM / Naval Research Laboratory",
                    "datasetId": name,
                    "externalId": f"{url} [{start:%Y-%m-%dT%H}Z..{end:%Y-%m-%dT%H}Z]",
                    "retrievedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    "licence": "Public domain (US Navy / NRL)",
                    "accessUrl": url,
                    "derivedFrom": [],
                },
            )
        finally:
            ds.close()

    raise ForcingUnavailable(
        "CURRENTS",
        attempted,
        "No keyless ocean-current model covers this date. HYCOM's reanalysis archive and its "
        "operational feed leave a gap between them; CMEMS credentials are required for dates "
        "inside it. Back-tracking cannot run, so the origin estimate degrades to footprint "
        "proximity rather than using currents from a different period.",
    )


def fetch_currents(
    bbox: tuple[float, float, float, float],
    start: datetime,
    end: datetime,
    cmems_username: str | None = None,
    cmems_password: str | None = None,
    *,
    timeout_s: float = 180.0,
    retries: int = 2,
    attempted: list[dict] | None = None,
) -> ForcingField:
    """CURRENTS chain: CMEMS when credentials exist, else HYCOM.

    `attempted` is filled in place, so the caller keeps the record even when a later provider
    succeeds. Previously a CMEMS failure was logged and thrown away, so a run that fell back
    to HYCOM looked, from the outside, exactly like a run where CMEMS had never been
    configured — and the dossier could not tell an analyst which it was.
    """
    log_attempts = attempted if attempted is not None else []

    if cmems_username and cmems_password:
        try:
            field = _call_with_deadline(
                lambda: _fetch_cmems(bbox, start, end, cmems_username, cmems_password),
                timeout_s,
                retries,
                "CMEMS",
            )
            log_attempts.append(
                {
                    "provider": "CMEMS",
                    "outcome": "OK",
                    "datasetId": field.dataset_id,
                    "covers": f"{field.times[0]:%Y-%m-%dT%H}Z to {field.times[-1]:%Y-%m-%dT%H}Z",
                }
            )
            return field
        except Exception as e:  # noqa: BLE001 - classified into a reportable outcome
            log_attempts.append(
                {"provider": "CMEMS", "outcome": _classify(e), "detail": str(e)[:300]}
            )
            log.warning("CMEMS unavailable (%s); falling back to HYCOM", e)
    else:
        log_attempts.append({"provider": "CMEMS", "outcome": "NOT_CONFIGURED"})

    try:
        return fetch_hycom_currents(bbox, start, end)
    except ForcingUnavailable as e:
        raise ForcingUnavailable("CURRENTS", log_attempts + e.attempted, e.consequence) from e


def _fetch_cmems(bbox, start, end, username, password) -> ForcingField:
    """CMEMS GLOBAL_ANALYSISFORECAST_PHY_001_024 surface currents (1/12 degree, hourly).

    `uo`/`vo` at the shallowest model level (~0.49 m) is the layer a floating slick is
    advected by. The request is padded around the AOI because particles leave the slick's
    own bounding box within a few hours of back-tracking.
    """
    import copernicusmarine  # imported lazily: only needed when credentials exist

    w, s, e, n = bbox
    result = copernicusmarine.open_dataset(
        dataset_id=CMEMS_DATASET_ID,
        variables=["uo", "vo"],
        minimum_longitude=w - 0.5,
        maximum_longitude=e + 0.5,
        minimum_latitude=s - 0.5,
        maximum_latitude=n + 0.5,
        start_datetime=start,
        end_datetime=end,
        minimum_depth=0,
        maximum_depth=1,
        username=username,
        password=password,
    )
    u = np.asarray(result["uo"].squeeze(), dtype="float64")
    v = np.asarray(result["vo"].squeeze(), dtype="float64")
    if u.ndim == 2:
        u, v = u[None, ...], v[None, ...]

    # An empty or all-land subset is NOT a current field. Returning it would hand the
    # integrator a grid of zeros and produce an origin zone that is the slick itself,
    # labelled OK. Refusing here keeps the degradation visible.
    if u.size == 0 or not np.isfinite(u).any():
        raise ValueError(
            "CMEMS returned no finite velocity cells for this window - the subset is empty "
            "or entirely land"
        )

    times = [
        datetime.fromtimestamp(int(t) / 1e9, tz=UTC)
        for t in np.asarray(result["time"].values).astype("datetime64[ns]").astype("int64")
    ]

    lats = np.asarray(result["latitude"].values, dtype="float64")
    lons = np.asarray(result["longitude"].values, dtype="float64")
    # `_bilinear` locates cells with `searchsorted`, which requires ascending axes.
    if lats.size > 1 and lats[0] > lats[-1]:
        lats = lats[::-1]
        u = u[:, ::-1, :]
        v = v[:, ::-1, :]

    return ForcingField(
        kind="CURRENTS",
        u=u,
        v=v,
        times=times,
        lats=lats,
        lons=lons,
        provider="CMEMS",
        dataset_id=CMEMS_DATASET_ID,
        resolution_deg=1 / 12,
        temporal_resolution_h=1.0,
        provenance={
            "sourceType": "OCEAN_MODEL",
            "provider": "Copernicus Marine Service",
            "datasetId": "GLOBAL_ANALYSISFORECAST_PHY_001_024",
            "externalId": f"{CMEMS_DATASET_ID} [{start:%Y-%m-%dT%H}Z..{end:%Y-%m-%dT%H}Z]",
            "retrievedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "licence": "Copernicus Marine Service - free, with attribution",
            "accessUrl": (
                "https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_PHY_001_024"
            ),
            "derivedFrom": [],
            # Carried through so the API stores what was ACTUALLY used rather than a
            # hard-coded pair of numbers that happened to describe HYCOM.
            "resolutionDeg": round(1 / 12, 6),
            "temporalResolutionH": 1.0,
            "variables": ["uo", "vo"],
            "depthLayer": "surface (~0.49 m, shallowest model level)",
            "coverage": (
                f"{times[0]:%Y-%m-%dT%H:%M}Z to {times[-1]:%Y-%m-%dT%H:%M}Z, "
                f"{len(times)} hourly steps"
            ),
            "processingMethod": (
                "Bilinear in space, nearest-hour in time, at each particle position"
            ),
        },
    )


def fetch_winds(
    bbox: tuple[float, float, float, float],
    start: datetime,
    end: datetime,
    cds_key: str | None = None,
    *,
    cds_url: str | None = None,
    local_path: str | None = None,
    timeout_s: float = 180.0,
    retries: int = 2,
    attempted: list[dict] | None = None,
) -> ForcingField:
    """WIND chain: an operator-supplied ERA5 file first, then the CDS API.

    The local file comes first because it is already on disk: it costs no network round trip
    and cannot fail mid-demo. It is only accepted when it genuinely covers the requested
    region and window - see `_fetch_era5_local`, which refuses rather than returning the
    nearest available hours.

    NOAA GFS is keyless but NOMADS retains only about ten days, so it cannot serve a historic
    incident. Rather than pretend, this raises and the caller degrades the run with
    `alpha = 0` (currents only), which is a defined, weaker mode - not a guess.
    """
    log_attempts = attempted if attempted is not None else []

    if local_path:
        try:
            field = _fetch_era5_local(local_path, bbox, start, end)
            log_attempts.append(
                {
                    "provider": "ERA5_LOCAL_FILE",
                    "outcome": "OK",
                    "datasetId": field.dataset_id,
                    "covers": f"{field.times[0]:%Y-%m-%dT%H}Z to {field.times[-1]:%Y-%m-%dT%H}Z",
                }
            )
            return field
        except Exception as e:  # noqa: BLE001
            log_attempts.append(
                {
                    "provider": "ERA5_LOCAL_FILE",
                    "outcome": _classify(e),
                    "detail": str(e)[:300],
                }
            )
            log.warning("local ERA5 file unusable (%s)", e)
    else:
        log_attempts.append({"provider": "ERA5_LOCAL_FILE", "outcome": "NOT_CONFIGURED"})

    if cds_key:
        try:
            field = _call_with_deadline(
                lambda: _fetch_era5(bbox, start, end, cds_key, cds_url),
                timeout_s,
                retries,
                "ERA5_CDS",
            )
            log_attempts.append(
                {
                    "provider": "ERA5_CDS",
                    "outcome": "OK",
                    "datasetId": field.dataset_id,
                    "covers": f"{field.times[0]:%Y-%m-%dT%H}Z to {field.times[-1]:%Y-%m-%dT%H}Z",
                }
            )
            return field
        except Exception as e:  # noqa: BLE001
            log_attempts.append(
                {
                    "provider": "ERA5_CDS",
                    "outcome": _classify(e),
                    "detail": str(e)[:300],
                }
            )
            log.warning("ERA5 unavailable: %s", e)
    else:
        log_attempts.append({"provider": "ERA5_CDS", "outcome": "NOT_CONFIGURED"})

    log_attempts.append(
        {"provider": "NOAA_GFS", "outcome": "RETENTION_TOO_SHORT_FOR_HISTORIC_DATE"}
    )

    raise ForcingUnavailable(
        "WIND",
        log_attempts,
        "No wind field is available for this date. The drift run continues with currents "
        "only (wind-drift coefficient set to zero) and is labelled DEGRADED: a slick that "
        "was in fact wind-driven will have its origin under-displaced.",
    )


def _fetch_era5_local(
    path: str,
    bbox: tuple[float, float, float, float],
    start: datetime,
    end: datetime,
) -> ForcingField:
    """10 m winds from an ERA5 file already on disk (GRIB via cfgrib, or NetCDF).

    Real ERA5 data fetched by hand from the Climate Data Store is the same data the API would
    deliver, so using it is not a fallback to something weaker - it is the same
    observationally-constrained reanalysis, retrieved by a different route. What makes it
    honest is the coverage check below: the file is used ONLY where it actually spans the
    requested box and window. A file that stops short is REFUSED, because silently
    substituting the nearest available hours is how a wind field from the wrong month ends up
    inside an attribution report.
    """
    import os

    if not os.path.exists(path):
        raise FileNotFoundError(f"ERA5_LOCAL_PATH does not exist: {path}")

    import xarray as xr

    is_grib = path.lower().endswith((".grib", ".grib2", ".grb", ".grb2"))
    # ONE shortName per open for GRIB, and the two winds are read SEQUENTIALLY with a close
    # in between — see `_grib_wind_component`. Holding both open at once corrupts the read.
    ds = _open_grib(path, "10u") if is_grib else xr.open_dataset(path)
    opened: list = [ds]

    try:
        uname = _match_var(ds, ("u10", "10u", "eastward_wind", "u"))
        # For GRIB, `vname` is unused: the v component is read from its own handle below.
        vname = uname if is_grib else _match_var(ds, ("v10", "10v", "northward_wind", "v"))
        tname = "valid_time" if "valid_time" in ds.coords else "time"

        times_raw = np.atleast_1d(
            np.asarray(ds[tname].values).astype("datetime64[ns]").astype("int64")
        )
        times = [datetime.fromtimestamp(int(t) / 1e9, tz=UTC) for t in times_raw]

        lats = np.asarray(ds["latitude"].values, dtype="float64")
        lons = np.asarray(ds["longitude"].values, dtype="float64")
        if lons.max() > 180:
            lons = np.where(lons > 180, lons - 360, lons)

        w, s, e, n = bbox
        if not (lats.min() <= s and lats.max() >= n and lons.min() <= w and lons.max() >= e):
            raise ValueError(
                f"the local ERA5 file covers lat [{lats.min():.2f},{lats.max():.2f}] "
                f"lon [{lons.min():.2f},{lons.max():.2f}], which does not contain the requested "
                f"box lat [{s:.2f},{n:.2f}] lon [{w:.2f},{e:.2f}] - out of range"
            )
        if not (min(times) <= start and max(times) >= end):
            raise ValueError(
                f"the local ERA5 file covers {min(times):%Y-%m-%dT%H}Z to "
                f"{max(times):%Y-%m-%dT%H}Z, which does not contain the requested window "
                f"{start:%Y-%m-%dT%H}Z..{end:%Y-%m-%dT%H}Z - out of range"
            )

        keep = [
            i
            for i, t in enumerate(times)
            if start - timedelta(hours=1) <= t <= end + timedelta(hours=1)
        ]
        if not keep:
            raise ValueError("no data: the local ERA5 file has no time steps in the window")

        order_lon = np.argsort(lons)
        lo_sorted = lons[order_lon]
        la = np.where((lats >= s - 1.0) & (lats <= n + 1.0))[0]
        lo = np.where((lo_sorted >= w - 1.0) & (lo_sorted <= e + 1.0))[0]
        if la.size == 0 or lo.size == 0:
            raise ValueError("no data: the local ERA5 grid has no cells inside the requested box")

        # Subset LAZILY, then materialise. Reading `.values` on the whole variable first is
        # what a naive implementation does and it does not survive a real file: an ERA5
        # global hourly request is 1440x721 per field, and three weeks of it is gigabytes
        # per variable before any window is applied. eccodes raises MemoryAllocationError
        # partway through and the wind chain reports a fault that is ours, not the
        # provider's. xarray indexes without decoding, so only the requested box and hours
        # ever leave the file.
        u_da = ds[uname]
        lat_dim = "latitude" if "latitude" in u_da.dims else u_da.dims[-2]
        lon_dim = "longitude" if "longitude" in u_da.dims else u_da.dims[-1]
        time_dims = [d for d in u_da.dims if d not in (lat_dim, lon_dim)]

        # SLICES ONLY, on every dimension.
        #
        # cfgrib decodes message by message, and an integer-array indexer on more than one
        # dimension at a time drives it through a read pattern it does not survive: eccodes
        # lands mid-message, reads a length field that is not one, and raises
        # MemoryAllocationError partway through what looks like an ordinary subset. Slices
        # keep the read contiguous.
        #
        # `keep` is contiguous by construction (a window filter over sorted times), so a
        # slice is exact. Longitude is left WHOLE here and reordered in numpy afterwards:
        # a longitude axis that wraps the dateline has no contiguous slice in sorted space,
        # and the band is only a few megabytes once latitude is already cut down.
        sel: dict[str, object] = {lat_dim: slice(int(la[0]), int(la[-1]) + 1)}
        if time_dims:
            sel[time_dims[0]] = slice(int(keep[0]), int(keep[-1]) + 1)

        lon_take = order_lon[lo[0] : lo[-1] + 1]

        u = np.asarray(u_da.isel(sel).values, dtype="float64")
        if is_grib:
            # The v component comes from its own open/close cycle. Two cfgrib datasets on
            # one path share a cached file handle, and reading them interleaved moves that
            # handle under the other reader. Sequential opens keep each read pointing at its
            # own messages.
            v = _grib_wind_component(path, "10v", sel)
        else:
            v = np.asarray(ds[vname].isel(sel).values, dtype="float64")
        if u.ndim == 2:
            u, v = u[None, ...], v[None, ...]

        u = u[:, :, lon_take]
        v = v[:, :, lon_take]

        sub_lats = lats[la[0] : la[-1] + 1]
        sub_lons = lo_sorted[lo[0] : lo[-1] + 1]
        sub_times = [times[i] for i in keep]

        # ERA5 ships latitude descending; the sampler needs it ascending.
        if sub_lats.size > 1 and sub_lats[0] > sub_lats[-1]:
            sub_lats = sub_lats[::-1]
            u = u[:, ::-1, :]
            v = v[:, ::-1, :]

        if not np.isfinite(u).any():
            raise ValueError("no data: the local ERA5 subset has no finite wind values")

        # PHYSICAL PLAUSIBILITY, and it is not paranoia.
        #
        # A multi-parameter GRIB (10 m wind plus temperature, pressure, wave fields) can be
        # mis-indexed by cfgrib, and the failure is silent: `shortName=10u` starts returning
        # a DIFFERENT parameter partway through the file. Observed on a real 8.9 GB ERA5
        # download — the first ~200 steps read as wind near 9 m/s, and every step after read
        # as ~302, which is 2 m temperature in kelvin wearing a wind field's name.
        #
        # Nothing downstream would catch that. It would enter the drift model as a 302 m/s
        # wind, throw every particle out of the domain, and produce an origin zone with full
        # provenance attached. So the values are checked against physics before they are
        # trusted: ERA5 10 m wind speed does not reach 60 m/s anywhere on Earth, and a file
        # that says otherwise is not a wind file.
        speed = np.hypot(u, v)
        peak = float(np.nanmax(speed)) if np.isfinite(speed).any() else 0.0
        if peak > MAX_PLAUSIBLE_WIND_MS:
            raise ValueError(
                f"the local ERA5 file yielded a 10 m wind speed of {peak:.1f} m/s, which is "
                f"not physically possible (ceiling {MAX_PLAUSIBLE_WIND_MS:.0f} m/s). The most "
                "likely cause is a multi-parameter GRIB whose message index has mixed "
                "parameters, so these values are another variable under the wind's name. "
                "Refusing the file: split it to one parameter per file, or supply NetCDF."
            )

        res = float(abs(sub_lats[1] - sub_lats[0])) if sub_lats.size > 1 else 0.25

        return ForcingField(
            kind="WIND",
            u=u,
            v=v,
            times=sub_times,
            lats=sub_lats,
            lons=sub_lons,
            provider="ERA5",
            dataset_id="reanalysis-era5-single-levels",
            resolution_deg=res,
            temporal_resolution_h=1.0,
            provenance={
                "sourceType": "ATMOSPHERIC_MODEL",
                "provider": "ECMWF / Copernicus Climate Data Store",
                "datasetId": "reanalysis-era5-single-levels",
                "externalId": f"ERA5 10m u/v [{start:%Y-%m-%dT%H}Z..{end:%Y-%m-%dT%H}Z]",
                "retrievedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "licence": "Copernicus Climate Change Service (C3S) licence",
                "accessUrl": (
                    "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels"
                ),
                "derivedFrom": [],
                "retrievalRoute": "OPERATOR_SUPPLIED_FILE",
                "localFile": os.path.basename(path),
                "resolutionDeg": res,
                "temporalResolutionH": 1.0,
                "variables": ["10m_u_component_of_wind", "10m_v_component_of_wind"],
                "coverage": (
                    f"{sub_times[0]:%Y-%m-%dT%H:%M}Z to {sub_times[-1]:%Y-%m-%dT%H:%M}Z, "
                    f"{len(sub_times)} hourly steps"
                ),
                "processingMethod": (
                    "Bilinear in space, nearest-hour in time, at each particle position"
                ),
            },
        )
    finally:
        # Closing a reader must never mask the real error that brought us here.
        for d in opened:
            with contextlib.suppress(Exception):
                d.close()


def _open_grib(path: str, short_name: str):
    """One cfgrib dataset holding exactly one shortName.

    An ERA5 request can mix grids — wave parameters live on their own — and cfgrib refuses
    to build a single dataset across two of them. Narrowing to one shortName per open sides
    steps that, and is also what makes the sequential read in `_grib_wind_component` possible.
    """
    import xarray as xr

    return xr.open_dataset(
        path,
        engine="cfgrib",
        backend_kwargs={"filter_by_keys": {"shortName": short_name}, "indexpath": ""},
    )


def _grib_wind_component(path: str, short_name: str, sel: dict) -> np.ndarray:
    """Read one wind component's subset from its own handle, then close it."""
    ds = _open_grib(path, short_name)
    try:
        name = next(iter(ds.data_vars))
        return np.asarray(ds[name].isel(sel).values, dtype="float64")
    finally:
        with contextlib.suppress(Exception):
            ds.close()


def _first_var(ds) -> str:
    return next(iter(ds.data_vars))


def _match_var(ds, names: tuple[str, ...]) -> str:
    for n in names:
        if n in ds.data_vars:
            return n
    raise KeyError(f"none of {names} present in the file; it has {list(ds.data_vars)}")


def _fetch_era5(bbox, start, end, cds_key, cds_url: str | None = None) -> ForcingField:
    """ERA5 10 m winds via the CDS API (0.25 degree, hourly)."""
    import os
    import tempfile

    import cdsapi
    import netCDF4 as nc

    w, s, e, n = bbox
    c = cdsapi.Client(url=cds_url or CDS_DEFAULT_URL, key=cds_key)
    # A unique file per request. A fixed name in the process CWD collides between concurrent
    # drift jobs — one job reads the other's window — and leaves a stray NetCDF in whichever
    # directory the service happened to start from.
    fd, target = tempfile.mkstemp(prefix="varuna_era5_", suffix=".nc")
    os.close(fd)
    c.retrieve(
        "reanalysis-era5-single-levels",
        {
            "product_type": "reanalysis",
            "variable": ["10m_u_component_of_wind", "10m_v_component_of_wind"],
            "date": f"{start:%Y-%m-%d}/{end:%Y-%m-%d}",
            "time": [f"{h:02d}:00" for h in range(24)],
            "area": [n + 0.5, w - 0.5, s - 0.5, e + 0.5],
            "format": "netcdf",
        },
        target,
    )
    ds = nc.Dataset(target)
    try:
        import cftime

        tvar = ds.variables["time"] if "time" in ds.variables else ds.variables["valid_time"]
        tvals = cftime.num2date(tvar[:], tvar.units)
        times = [datetime(t.year, t.month, t.day, t.hour, tzinfo=UTC) for t in tvals]
        lats = np.asarray(ds.variables["latitude"][:])
        lons = np.asarray(ds.variables["longitude"][:])
        u = np.asarray(ds.variables["u10"][:])
        v = np.asarray(ds.variables["v10"][:])
        # ERA5 ships latitude descending; our sampler needs it ascending.
        if lats[0] > lats[-1]:
            lats = lats[::-1]
            u = u[:, ::-1, :]
            v = v[:, ::-1, :]
        return ForcingField(
            kind="WIND",
            u=u,
            v=v,
            times=times,
            lats=lats,
            lons=lons,
            provider="ERA5",
            dataset_id="reanalysis-era5-single-levels",
            resolution_deg=0.25,
            temporal_resolution_h=1.0,
            provenance={
                "sourceType": "ATMOSPHERIC_MODEL",
                "provider": "ECMWF / Copernicus Climate Data Store",
                "datasetId": "reanalysis-era5-single-levels",
                "externalId": f"ERA5 10m u/v [{start:%Y-%m-%dT%H}Z..{end:%Y-%m-%dT%H}Z]",
                "retrievedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "licence": "Copernicus Climate Change Service (C3S) licence",
                "accessUrl": (
                    "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels"
                ),
                "derivedFrom": [],
                "retrievalRoute": "CDS_API",
                "resolutionDeg": 0.25,
                "temporalResolutionH": 1.0,
                "variables": ["10m_u_component_of_wind", "10m_v_component_of_wind"],
                "coverage": (
                    f"{times[0]:%Y-%m-%dT%H:%M}Z to {times[-1]:%Y-%m-%dT%H:%M}Z, "
                    f"{len(times)} hourly steps"
                ),
                "processingMethod": (
                    "Bilinear in space, nearest-hour in time, at each particle position"
                ),
            },
        )
    finally:
        ds.close()
        with contextlib.suppress(OSError):
            os.remove(target)
