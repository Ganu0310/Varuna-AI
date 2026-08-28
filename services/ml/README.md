# varuna-ml

Python 3.11 · FastAPI · (later) PyTorch, rasterio, OpenDrift.

A specialised compute sidecar behind an internal HTTP boundary — **never exposed publicly**,
authenticated with `X-Service-Token` (03_ARCHITECTURE §3.3.1, 06_BACKEND §6.1). MongoDB,
Express, React and Node own the product; this service owns raster/geodesy/ML compute only.

Every response carries a `provenance` block (07_AIML §7.8). The training pipeline refuses to
start if any dataset manifest entry lacks a citation and licence (07_AIML §7.4.5).

## Develop

```bash
# with uv (recommended)
uv sync --extra dev
uv run uvicorn varuna_ml.main:app --reload --port 8000
uv run pytest

# or with pip
python -m venv .venv && . .venv/Scripts/activate   # Windows
pip install -e ".[dev]"
uvicorn varuna_ml.main:app --reload --port 8000
pytest
```

## Endpoints (contract — 07_AIML §7.8)

| Method | Path | Phase | Status |
|---|---|---|---|
| GET | `/health` | 4 | ✅ scaffolded |
| POST | `/preprocess` | 4 | ⬜ |
| POST | `/segment` | 5 | ⬜ |
| POST | `/vectorise` | 5 | ⬜ |
| POST | `/backtrack` | 7 | ⬜ |
| POST | `/score` | 9 | ⬜ |
| GET | `/models` | 5 | ⬜ |
