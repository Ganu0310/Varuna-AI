from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# The repository root, four levels up from this file
# (varuna_ml/config.py -> varuna_ml -> services/ml -> services -> repo root).
#
# Resolved from `__file__` rather than the process CWD on purpose. `env_file=".env"` is
# relative to wherever uvicorn happened to be started, and the documented way to start this
# service is `cd services/ml && uvicorn ...` — which looks for `services/ml/.env`, a file
# that does not exist. The credentials live in the repo-root `.env` that the Node side
# already reads. The consequence was not a crash but something worse: `cmems_username` came
# back None, the currents chain silently fell through to HYCOM, HYCOM has no coverage for
# the demo date, and every origin estimate degraded to FOOTPRINT_PROXIMITY while a working
# CMEMS credential sat in the file three directories up.
#
# `parents` is indexed defensively because that four-deep layout is the SOURCE tree, and the
# container has a different one: the Dockerfile copies the package to `/app/varuna_ml`, where
# there is no fourth parent at all. `parents[3]` raised IndexError at import time, so the
# image built fine and then died on every boot before uvicorn could load the app. Falling back
# to the service root is correct there — a container gets its credentials from the environment
# and `env_file` is a developer convenience.
_HERE = Path(__file__).resolve()
_SERVICE_ROOT = _HERE.parents[1]
_REPO_ROOT = _HERE.parents[3] if len(_HERE.parents) > 3 else _SERVICE_ROOT


class Settings(BaseSettings):
    """Service configuration. `ML_SERVICE_TOKEN` is required — the API and worker present it
    as `X-Service-Token` on every call (06_BACKEND §6.1, 02_TRD SEC-10).

    Both env files are read, service-local last so it wins: the repo root holds the shared
    credentials, and `services/ml/.env` exists for the case where the ML service runs
    somewhere the rest of the stack does not. A real environment variable beats both, so
    containers and CI are unaffected.
    """

    model_config = SettingsConfigDict(
        env_file=(_REPO_ROOT / ".env", _SERVICE_ROOT / ".env"),
        env_file_encoding="utf-8",
        env_prefix="",
        extra="ignore",
    )

    ml_service_token: str = "dev-service-token"
    log_level: str = "info"

    # Object storage (shared with the Node side)
    s3_endpoint: str = "http://localhost:9000"
    s3_region: str = "auto"
    s3_bucket: str = "varuna"
    s3_access_key_id: str = "minioadmin"
    s3_secret_access_key: str = "minioadmin"

    titiler_url: str = "http://localhost:8001"

    # Optional absolute path to the content-addressed model registry JSON (07_AIML 7.7).
    # Unset is valid: the classical detector has no weights file and is unregistered.
    registry_path: str | None = None

    # Provider credentials (optional at boot; a missing key degrades capability, not integrity)
    cmems_username: str | None = None
    cmems_password: str | None = None
    cdsapi_url: str | None = None
    cdsapi_key: str | None = None
    earthdata_username: str | None = None
    earthdata_password: str | None = None
    planetary_computer_subscription_key: str | None = None

    # An operator-supplied ERA5 file (GRIB or NetCDF) already on disk, holding 10 m u/v wind.
    # Real ERA5 data downloaded by hand from the Climate Data Store is the same data the API
    # would return; this lets a deployment without a CDS key still run on OBSERVED wind
    # instead of none. It is used ONLY if it actually covers the requested region and time —
    # see `drift.forcing._fetch_era5_local`.
    era5_local_path: str | None = None

    # How long any single environmental-forcing provider call may take before it is treated
    # as unavailable. A drift job that hangs on a provider is worse than one that degrades:
    # the analyst gets neither a result nor a reason.
    #
    # 180s was measured against CMEMS, which answers or fails fast. The keyless HYCOM
    # OPeNDAP fallback does neither reliably: probed against the real public server, a
    # single request can sit well past 300s with no response and no error — not a timeout
    # firing late, a connection that never resolves either way. At 180s x 2 retries x 2
    # forcing terms (currents, then wind), that is up to twelve minutes before a caller
    # sees FOOTPRINT_PROXIMITY, which is indistinguishable from hung from where the worker
    # sits. 20s keeps a fair window for a slow-but-live answer while keeping the worst case
    # for one forcing term at 20s x forcing_retries — a bound the caller can actually wait
    # out (apps/api/src/modules/origin/service.ts sets its own fetch deadline against this).
    forcing_timeout_seconds: float = 20.0
    forcing_retries: int = 2


@lru_cache
def get_settings() -> Settings:
    return Settings()
