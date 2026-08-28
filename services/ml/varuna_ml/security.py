from fastapi import Header, HTTPException, status

from .config import get_settings


async def require_service_token(x_service_token: str | None = Header(default=None)) -> None:
    """Guard for every non-health route. The ML service is bound to the internal network and
    is never routable from the internet (02_TRD SEC-10)."""
    settings = get_settings()
    if not x_service_token or x_service_token != settings.ml_service_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid X-Service-Token",
        )
