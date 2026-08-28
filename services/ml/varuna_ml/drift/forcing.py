"""Environmental forcing for drift back-tracking — 07_AIML 7.3, 10_DATASETS 10.5.

Currents and winds come from real ocean/atmosphere models. There is no synthetic fallback:
if no provider covers the region and date, the drift run degrades and says so
(13_REAL_DATA_POLICY 13.8). Inventing a current field would produce an origin zone that
looks authoritative and means nothing.

Provider chains, keyless first where possible:

    CURRENTS   CMEMS (credentials) -> HYCOM (keyless OPeNDAP)
    WIND       ERA5  (credentials) -> NOAA GFS (keyless, ~10-day window)

A real and load-bearing gap, discovered by probing rather than assumed: HYCOM's reanalysis
archive (GLBy0.08/expt_93.0) ends 2024-09-05 while its operational feed only covers roughly
the last two weeks. Dates in between have NO keyless current coverage, so an incident in
that gap requires CMEMS credentials. `coverage()` reports this honestly instead of silently
returning the nearest available field, which would attribute a spill using currents from a
different year.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import numpy as np

log = logging.getLogger("varuna_ml.drift.forcing")

HYCOM_ARCHIVE = "https://tds.hycom.org/thredds/dodsC/GLBy0.08/expt_93.0/uv3z"
HYCOM_OPERATIONAL = (
    "https://tds.hycom.org/thredds/dodsC/FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd"
)


class ForcingUnavailable(RuntimeError):
    """No provider covers this region and time. Carries what was tried and what it means."""

    def __init__(self, kind: str, attempted: list[dict], consequence: str):
        self.kind = kind
        self.attempted = attempted
        self.consequence = consequence
        super().__init__(f"{kind} forcing unavailable: {consequence}")


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

    def sample(self, t: datetime, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
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


def _bilinear(grid: np.ndarray, lats: np.ndarray, lons: np.ndarray,
              lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Bilinear interpolation with NaN-safe fill; points outside the grid yield 0."""
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

    q00 = grid[li_i, ci_i]
    q01 = grid[li_i, ci_i + 1]
    q10 = grid[li_i + 1, ci_i]
    q11 = grid[li_i + 1, ci_i + 1]
    vals = (
        q00 * (1 - wx) * (1 - wy)
        + q01 * wx * (1 - wy)
        + q10 * (1 - wx) * wy
        + q11 * wx * wy
    )
    # A masked/NaN cell means "no water here" (land, or outside the model domain), which is
    # zero velocity, not an unknown to be guessed at.
    out[inside] = np.nan_to_num(np.asarray(vals, dtype=float), nan=0.0)
    return out


def coverage(source_url: str) -> tuple[datetime, datetime] | None:
    """Temporal extent of an OPeNDAP dataset, or None if it cannot be opened."""
    try:
        import cftime
        import netCDF4 as nc

        ds = nc.Dataset(source_url)
        t = ds.variables["time"]
        d = cftime.num2date(t[:], t.units)
        first = datetime(d[0].year, d[0].month, d[0].day, d[0].hour, tzinfo=timezone.utc)
        last = datetime(d[-1].year, d[-1].month, d[-1].day, d[-1].hour, tzinfo=timezone.utc)
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

    for name, url in (("HYCOM_ARCHIVE", HYCOM_ARCHIVE), ("HYCOM_OPERATIONAL", HYCOM_OPERATIONAL)):
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
                <= datetime(tt.year, tt.month, tt.day, tt.hour, tzinfo=timezone.utc)
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
                datetime(tvals[i].year, tvals[i].month, tvals[i].day, tvals[i].hour,
                         tzinfo=timezone.utc)
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
                    "retrievedAt": datetime.now(timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z"),
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
) -> ForcingField:
    """CURRENTS chain: CMEMS when credentials exist, else HYCOM."""
    if cmems_username and cmems_password:
        try:
            return _fetch_cmems(bbox, start, end, cmems_username, cmems_password)
        except Exception as e:  # noqa: BLE001
            log.warning("CMEMS unavailable (%s); falling back to HYCOM", e)
    return fetch_hycom_currents(bbox, start, end)


def _fetch_cmems(bbox, start, end, username, password) -> ForcingField:
    """CMEMS GLOBAL_ANALYSISFORECAST_PHY_001_024 surface currents (1/12 degree, hourly)."""
    import copernicusmarine  # imported lazily: only needed when credentials exist

    w, s, e, n = bbox
    result = copernicusmarine.open_dataset(
        dataset_id="cmems_mod_glo_phy_anfc_0.083deg_PT1H-m",
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
    u = np.asarray(result["uo"].squeeze())
    v = np.asarray(result["vo"].squeeze())
    if u.ndim == 2:
        u, v = u[None, ...], v[None, ...]
    times = [
        datetime.fromtimestamp(int(t) / 1e9, tz=timezone.utc)
        for t in np.asarray(result["time"].values).astype("datetime64[ns]").astype("int64")
    ]
    return ForcingField(
        kind="CURRENTS",
        u=u,
        v=v,
        times=times,
        lats=np.asarray(result["latitude"].values),
        lons=np.asarray(result["longitude"].values),
        provider="CMEMS",
        dataset_id="cmems_mod_glo_phy_anfc_0.083deg_PT1H-m",
        resolution_deg=1 / 12,
        temporal_resolution_h=1.0,
        provenance={
            "sourceType": "OCEAN_MODEL",
            "provider": "Copernicus Marine Service",
            "datasetId": "GLOBAL_ANALYSISFORECAST_PHY_001_024",
            "externalId": f"cmems_mod_glo_phy_anfc_0.083deg_PT1H-m [{start:%Y-%m-%dT%H}Z..{end:%Y-%m-%dT%H}Z]",
            "retrievedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "licence": "Copernicus Marine Service — free, with attribution",
            "accessUrl": "https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_PHY_001_024",
            "derivedFrom": [],
        },
    )


def fetch_winds(
    bbox: tuple[float, float, float, float],
    start: datetime,
    end: datetime,
    cds_key: str | None = None,
) -> ForcingField:
    """WIND chain: ERA5 when a CDS key exists, else nothing keyless for historic dates.

    NOAA GFS is keyless but NOMADS retains only about ten days, so it cannot serve a
    historic incident. Rather than pretend, this raises and the caller degrades the run with
    `alpha = 0` (currents only), which is a defined, weaker mode — not a guess.
    """
    if cds_key:
        try:
            return _fetch_era5(bbox, start, end, cds_key)
        except Exception as e:  # noqa: BLE001
            log.warning("ERA5 unavailable: %s", e)

    raise ForcingUnavailable(
        "WIND",
        [
            {"provider": "ERA5", "outcome": "NOT_CONFIGURED" if not cds_key else "ERROR"},
            {"provider": "NOAA_GFS", "outcome": "RETENTION_TOO_SHORT_FOR_HISTORIC_DATE"},
        ],
        "No wind field is available for this date. The drift run continues with currents "
        "only (wind-drift coefficient set to zero) and is labelled DEGRADED: a slick that "
        "was in fact wind-driven will have its origin under-displaced.",
    )


def _fetch_era5(bbox, start, end, cds_key) -> ForcingField:
    """ERA5 10 m winds via the CDS API (0.25 degree, hourly)."""
    import cdsapi
    import netCDF4 as nc

    w, s, e, n = bbox
    c = cdsapi.Client(url="https://cds.climate.copernicus.eu/api", key=cds_key)
    target = "era5_wind.nc"
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
        times = [
            datetime(t.year, t.month, t.day, t.hour, tzinfo=timezone.utc) for t in tvals
        ]
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
                "retrievedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "licence": "Copernicus Climate Change Service (C3S) licence",
                "accessUrl": "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels",
                "derivedFrom": [],
            },
        )
    finally:
        ds.close()
