FROM python:3.11-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

# System libs for the geospatial/ML stack land here as those deps are added
# (Phase 4/5): gdal-bin libgdal-dev libgl1 libglib2.0-0 etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY varuna_ml ./varuna_ml
RUN pip install --upgrade pip && pip install -e .

EXPOSE 8000
CMD ["uvicorn", "varuna_ml.main:app", "--host", "0.0.0.0", "--port", "8000"]
