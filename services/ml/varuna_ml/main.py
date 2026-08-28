import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .config import get_settings
from .routers import health

logging.basicConfig(level=get_settings().log_level.upper())
log = logging.getLogger("varuna_ml")

app = FastAPI(
    title="VARUNA ML/Geo Service",
    version="0.1.0",
    description=(
        "Internal-only compute sidecar: SAR preprocessing, oil-slick segmentation, "
        "backward Lagrangian drift, attribution scoring. Never exposed publicly."
    ),
)

app.include_router(health.router)


@app.get("/")
async def root() -> JSONResponse:
    return JSONResponse({"name": "varuna-ml", "version": app.version})


# Routers land with their phases (07_AIML §7.8):
#   from .routers import preprocess, segment, vectorise, backtrack, score
#   app.include_router(preprocess.router, dependencies=[Depends(require_service_token)])
#   ...
