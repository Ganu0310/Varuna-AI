from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Service configuration. `ML_SERVICE_TOKEN` is required — the API and worker present it
    as `X-Service-Token` on every call (06_BACKEND §6.1, 02_TRD SEC-10)."""

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    ml_service_token: str = "dev-service-token"
    log_level: str = "info"

    # Object storage (shared with the Node side)
    s3_endpoint: str = "http://localhost:9000"
    s3_region: str = "auto"
    s3_bucket: str = "varuna"
    s3_access_key_id: str = "minioadmin"
    s3_secret_access_key: str = "minioadmin"

    titiler_url: str = "http://localhost:8001"

    # Provider credentials (optional at boot; a missing key degrades capability, not integrity)
    cmems_username: str | None = None
    cmems_password: str | None = None
    cdsapi_url: str | None = None
    cdsapi_key: str | None = None
    earthdata_username: str | None = None
    earthdata_password: str | None = None
    planetary_computer_subscription_key: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
