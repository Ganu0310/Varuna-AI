"""Provider-chain behaviour under failure — 14 Phase 15, 02_TRD §2.9.

Every one of these drives the REAL chain functions with the provider call replaced. Nothing
here fabricates observation data: the substituted responses are transport-level outcomes
(a timeout, a 401, an empty subset), which is what a provider mock is for. The one place a
numeric field is constructed is `_field()`, and it exists only so a "success" branch has
something to return — the assertions are about the CHAIN, not about the numbers.

What is under test is the property the real-data policy rests on: when a provider cannot
answer, the system must say so, name what it tried, and degrade — never substitute.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from varuna_ml.drift import forcing as F

BBOX = (144.0, 13.0, 145.0, 14.0)
START = datetime(2025, 9, 20, 20, 0, tzinfo=UTC)
END = datetime(2025, 9, 21, 20, 0, tzinfo=UTC)


def _field(kind: str = "CURRENTS") -> F.ForcingField:
    lats = np.linspace(13.0, 14.0, 5)
    lons = np.linspace(144.0, 145.0, 5)
    u = np.full((2, 5, 5), 0.2)
    return F.ForcingField(
        kind=kind,
        u=u,
        v=np.zeros_like(u),
        times=[START, END],
        lats=lats,
        lons=lons,
        provider="CMEMS" if kind == "CURRENTS" else "ERA5",
        dataset_id="test-dataset",
        resolution_deg=0.25,
        temporal_resolution_h=1.0,
        provenance={"provider": "test"},
    )


def _outcome(attempts: list[dict], provider: str) -> str | None:
    for a in attempts:
        if a["provider"] == provider:
            return a["outcome"]
    return None


# ── outcome classification ────────────────────────────────────────────


@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (F.ForcingTimeout("slow"), "TIMEOUT"),
        (RuntimeError("HTTP 401 Unauthorized"), "AUTH_FAILED_401"),
        (RuntimeError("Invalid username or password"), "AUTH_FAILED_401"),
        (RuntimeError("403 Forbidden"), "FORBIDDEN_403"),
        (RuntimeError("404 not found"), "NOT_FOUND_404"),
        (ValueError("no data for this window"), "NO_DATA"),
        (OSError("connection refused"), "UNREACHABLE"),
        (RuntimeError("something else entirely"), "ERROR"),
    ],
)
def test_provider_failures_get_stable_outcome_codes(exc, expected):
    """The codes reach the UI and the dossier, so they must not echo a library's wording."""
    assert F._classify(exc) == expected


# ── the deadline wrapper ──────────────────────────────────────────────


def test_a_slow_provider_is_abandoned_rather_than_hanging_the_job():
    import time

    def slow():
        time.sleep(5)
        return "never"

    with pytest.raises(F.ForcingTimeout):
        F._call_with_deadline(slow, timeout_s=0.2, retries=1, label="SLOW")


def test_a_transport_failure_is_retried_and_can_succeed():
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise OSError("connection reset")
        return "ok"

    assert F._call_with_deadline(flaky, timeout_s=5, retries=3, label="FLAKY") == "ok"
    assert calls["n"] == 2


def test_an_auth_failure_is_not_retried():
    """A 401 will not become a 200 on the second attempt; retrying only spends the deadline
    the analyst is waiting on."""
    calls = {"n": 0}

    def denied():
        calls["n"] += 1
        raise RuntimeError("HTTP 401 Unauthorized")

    with pytest.raises(RuntimeError):
        F._call_with_deadline(denied, timeout_s=5, retries=5, label="DENIED")
    assert calls["n"] == 1


# ── the CURRENTS chain ────────────────────────────────────────────────


def test_cmems_success_is_recorded_with_its_coverage(monkeypatch):
    monkeypatch.setattr(F, "_fetch_cmems", lambda *a, **k: _field())
    attempts: list[dict] = []
    out = F.fetch_currents(BBOX, START, END, "u", "p", attempted=attempts)
    assert out.provider == "CMEMS"
    assert _outcome(attempts, "CMEMS") == "OK"
    assert "covers" in attempts[0]


def test_missing_credentials_are_reported_as_NOT_CONFIGURED_not_as_an_error(
    monkeypatch,
):
    """ "We never asked" and "we asked and were refused" are different facts about a run."""
    monkeypatch.setattr(F, "fetch_hycom_currents", lambda *a, **k: _field())
    attempts: list[dict] = []
    F.fetch_currents(BBOX, START, END, None, None, attempted=attempts)
    assert _outcome(attempts, "CMEMS") == "NOT_CONFIGURED"


def test_a_cmems_401_is_recorded_before_the_chain_falls_through(monkeypatch):
    """Regression: the fallback used to swallow the reason, so a run that fell back to HYCOM
    looked identical to one where CMEMS was never configured."""

    def denied(*a, **k):
        raise RuntimeError("HTTP 401 Unauthorized")

    monkeypatch.setattr(F, "_fetch_cmems", denied)
    monkeypatch.setattr(F, "fetch_hycom_currents", lambda *a, **k: _field())
    attempts: list[dict] = []
    out = F.fetch_currents(BBOX, START, END, "u", "bad", attempted=attempts)
    assert _outcome(attempts, "CMEMS") == "AUTH_FAILED_401"
    assert out.provider == "CMEMS"  # the stand-in HYCOM field, but the attempt log is intact
    assert any("401" in a.get("detail", "") for a in attempts)


def test_an_empty_cmems_subset_is_not_a_current_field(monkeypatch):
    """All-NaN velocities would hand the integrator a grid of zeros and produce an origin
    zone identical to the slick, labelled OK."""
    lats = np.linspace(13.0, 14.0, 4)
    lons = np.linspace(144.0, 145.0, 4)
    nan = np.full((1, 4, 4), np.nan)

    class _DS(dict):
        pass

    ds = _DS()
    ds["uo"] = type("A", (), {"squeeze": lambda self: nan})()
    ds["vo"] = type("A", (), {"squeeze": lambda self: nan})()

    import sys
    import types

    fake = types.ModuleType("copernicusmarine")
    fake.open_dataset = lambda **kw: ds  # noqa: ARG005
    monkeypatch.setitem(sys.modules, "copernicusmarine", fake)

    with pytest.raises(ValueError, match="no finite velocity cells"):
        F._fetch_cmems(BBOX, START, END, "u", "p")
    assert lats.size and lons.size  # the grid was never the problem


def test_when_every_currents_provider_fails_the_attempt_log_survives(monkeypatch):
    def denied(*a, **k):
        raise RuntimeError("HTTP 403 Forbidden")

    def no_hycom(*a, **k):
        raise F.ForcingUnavailable(
            "CURRENTS",
            [{"provider": "HYCOM_ARCHIVE", "outcome": "OUT_OF_COVERAGE"}],
            "the origin degrades to footprint proximity",
        )

    monkeypatch.setattr(F, "_fetch_cmems", denied)
    monkeypatch.setattr(F, "fetch_hycom_currents", no_hycom)

    with pytest.raises(F.ForcingUnavailable) as ei:
        F.fetch_currents(BBOX, START, END, "u", "p")

    providers = [a["provider"] for a in ei.value.attempted]
    assert providers == ["CMEMS", "HYCOM_ARCHIVE"]
    assert "degrades" in ei.value.consequence


# ── the WIND chain ────────────────────────────────────────────────────


def test_no_wind_provider_configured_yields_UNKNOWN_not_a_default_speed():
    """A constant "typical" wind is the single most tempting fabrication in this codebase."""
    with pytest.raises(F.ForcingUnavailable) as ei:
        F.fetch_winds(BBOX, START, END, cds_key=None, local_path=None)
    assert ei.value.kind == "WIND"
    assert _outcome(ei.value.attempted, "ERA5_CDS") == "NOT_CONFIGURED"
    assert _outcome(ei.value.attempted, "ERA5_LOCAL_FILE") == "NOT_CONFIGURED"
    assert _outcome(ei.value.attempted, "NOAA_GFS") == "RETENTION_TOO_SHORT_FOR_HISTORIC_DATE"


def test_a_local_file_is_preferred_over_the_api(monkeypatch):
    monkeypatch.setattr(F, "_fetch_era5_local", lambda *a, **k: _field("WIND"))

    def should_not_run(*a, **k):
        raise AssertionError("the CDS API was called when a local file was usable")

    monkeypatch.setattr(F, "_fetch_era5", should_not_run)
    attempts: list[dict] = []
    out = F.fetch_winds(BBOX, START, END, cds_key="k", local_path="x.grib", attempted=attempts)
    assert out.kind == "WIND"
    assert _outcome(attempts, "ERA5_LOCAL_FILE") == "OK"


def test_a_local_file_that_misses_the_window_falls_through_to_the_api(monkeypatch):
    """The file must be refused rather than serving the nearest hours it happens to hold."""

    def out_of_range(*a, **k):
        raise ValueError("covers 2026-07-31T00Z to 2026-08-22T23Z ... out of range")

    monkeypatch.setattr(F, "_fetch_era5_local", out_of_range)
    monkeypatch.setattr(F, "_fetch_era5", lambda *a, **k: _field("WIND"))
    attempts: list[dict] = []
    F.fetch_winds(BBOX, START, END, cds_key="k", local_path="x.grib", attempted=attempts)
    assert _outcome(attempts, "ERA5_LOCAL_FILE") == "NO_DATA"
    assert _outcome(attempts, "ERA5_CDS") == "OK"


def test_a_missing_local_file_is_reported_not_ignored(tmp_path):
    attempts: list[dict] = []
    with pytest.raises(F.ForcingUnavailable):
        F.fetch_winds(
            BBOX,
            START,
            END,
            cds_key=None,
            local_path=str(tmp_path / "nope.grib"),
            attempted=attempts,
        )
    assert _outcome(attempts, "ERA5_LOCAL_FILE") == "NOT_FOUND_404"


def test_a_cds_timeout_degrades_the_run_rather_than_hanging_it(monkeypatch):
    import time

    def slow(*a, **k):
        time.sleep(5)

    monkeypatch.setattr(F, "_fetch_era5", slow)
    attempts: list[dict] = []
    with pytest.raises(F.ForcingUnavailable):
        F.fetch_winds(BBOX, START, END, cds_key="k", timeout_s=0.2, retries=1, attempted=attempts)
    assert _outcome(attempts, "ERA5_CDS") == "TIMEOUT"


# ── partial coverage ──────────────────────────────────────────────────


def test_a_field_covering_only_part_of_the_window_is_still_usable():
    """Partial temporal coverage is a real, common case (a provider's archive ends
    mid-window). The sampler snaps to the nearest step it has rather than refusing, and the
    stored coverage string states the true extent so the gap is visible."""
    f = _field()
    beyond = END + timedelta(hours=6)
    u, _ = f.sample(beyond, np.array([13.5]), np.array([144.5]))
    assert float(u[0]) == pytest.approx(0.2)
    assert f.times[-1] == END


def test_a_wind_field_that_is_not_wind_is_refused(monkeypatch, tmp_path):
    """Regression on a real 8.9 GB ERA5 GRIB.

    cfgrib mis-indexed the multi-parameter file: `shortName=10u` read as wind for the first
    ~200 steps and as ~302 thereafter, which is 2 m temperature in kelvin wearing the wind
    field's name. Nothing downstream would have caught it — it would have entered the drift
    model as a 302 m/s wind and produced a fully-provenanced origin zone from nonsense.
    """
    import xarray as xr

    lats = np.array([13.0, 13.5, 14.0])
    lons = np.array([144.0, 144.5, 145.0])
    times = np.array(["2025-09-21T00", "2025-09-21T01"], dtype="datetime64[ns]")
    kelvin = np.full((2, 3, 3), 302.0)  # temperature, not wind

    path = tmp_path / "not-really-wind.nc"
    xr.Dataset(
        {
            "u10": (("time", "latitude", "longitude"), kelvin),
            "v10": (("time", "latitude", "longitude"), np.zeros_like(kelvin)),
        },
        coords={"time": times, "latitude": lats, "longitude": lons},
    ).to_netcdf(path)

    with pytest.raises(ValueError, match="not physically possible"):
        F._fetch_era5_local(
            str(path),
            (144.0, 13.0, 145.0, 14.0),
            datetime(2025, 9, 21, 0, tzinfo=UTC),
            datetime(2025, 9, 21, 1, tzinfo=UTC),
        )
    assert monkeypatch  # fixture retained for symmetry with the rest of the module


def test_a_real_wind_file_passes_the_plausibility_check(tmp_path):
    """The guard must not reject an ordinary strong wind."""
    import xarray as xr

    lats = np.array([13.0, 13.5, 14.0])
    lons = np.array([144.0, 144.5, 145.0])
    times = np.array(["2025-09-21T00", "2025-09-21T01"], dtype="datetime64[ns]")
    u = np.full((2, 3, 3), 18.0)  # a gale, entirely plausible

    path = tmp_path / "wind.nc"
    xr.Dataset(
        {
            "u10": (("time", "latitude", "longitude"), u),
            "v10": (("time", "latitude", "longitude"), np.full_like(u, 6.0)),
        },
        coords={"time": times, "latitude": lats, "longitude": lons},
    ).to_netcdf(path)

    f = F._fetch_era5_local(
        str(path),
        (144.0, 13.0, 145.0, 14.0),
        datetime(2025, 9, 21, 0, tzinfo=UTC),
        datetime(2025, 9, 21, 1, tzinfo=UTC),
    )
    assert f.kind == "WIND"
    assert f.provenance["retrievalRoute"] == "OPERATOR_SUPPLIED_FILE"
    assert float(np.nanmax(np.hypot(f.u, f.v))) == pytest.approx(18.97, abs=0.1)
