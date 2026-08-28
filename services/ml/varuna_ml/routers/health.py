from datetime import datetime, timezone

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    """07_AIML §7.8 — { status, gpu, modelLoaded, forcingCacheAge }."""
    return {
        "status": "ok",
        "service": "varuna-ml",
        "gpu": False,  # TODO(phase-5): torch.cuda.is_available()
        "modelLoaded": False,  # TODO(phase-5): registry.current() is not None
        "forcingCacheAge": None,  # TODO(phase-7): age of the newest cached CMEMS/ERA5 subset
        "now": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
