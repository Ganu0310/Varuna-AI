# VARUNA — datasets

What each dataset is, where it comes from, whether the demo needs it, and which pipeline
stage consumes it. The authoritative long-form source is `doc/10_DATASETS_and_Sources.md`;
this is the operational summary.

## Legend

- **REAL** — genuine third-party observation, used as evidence.
- **DEMO** — a deterministic fixture committed to the repo for a reproducible walkthrough.
- **SYNTHETIC** — generated data, clearly labelled, never presented as an observation.
- **DERIVED** — produced by VARUNA processing from a REAL input.

---

## A. Sentinel‑1 SAR  — REAL, required

| | |
|---|---|
| Provider | Microsoft Planetary Computer, collection `sentinel-1-rtc` |
| Product (demo) | `S1C_IW_GRDH_1SDV_20250921T200737_20250921T200800_004227_008638_rtc` |
| Scene | Sentinel‑1C, IW, VV+VH, descending, RTC (radiometrically terrain-corrected), EPSG:32655, 10 m |
| Acquired | 2025‑09‑21T20:07:48.725Z, Apra Harbour, Guam |
| Access | anonymous STAC search + SAS token; GDAL windowed HTTP range reads |
| Local storage | only the AOI window, written as 2 COGs to MinIO `varuna/scenes/<product>/{vv,vh}.tif` (~66 MB each) |
| Consumer | `services/ml` ingest → detection; `titiler` for map tiles |
| Acquire | automatic during ingest; or `pnpm stage:demo` |
| Credential | none (optional `PLANETARY_COMPUTER_SUBSCRIPTION_KEY` for rate limits) |

## B. AIS vessel positions — SYNTHETIC today (REAL path prepared)

| | |
|---|---|
| Demo file | `data/demo/ais/guam-2025-09-21.demo.csv` (138 rows, 4 vessels) |
| Generator | `scripts/data/make-demo-ais.mjs` (`pnpm demo:ais`) — deterministic |
| Schema | NOAA Marine Cadastre "AccessAIS" CSV-with-geometry: `mmsi, base_date_time, geometry (WKT POINT), sog, cog, heading, status, draft, vessel_name, vessel_type` |
| Import | `pnpm --filter @varuna/api ais:import -- --file … --from … --to … --bbox w,s,e,n --demo` |
| Provenance | with `--demo`: provider `VARUNA synthetic demo AIS`, licence "Synthetic demo data — not a real AIS archive" |
| Consumer | `apps/api` AIS correlation → candidate ranking |
| REAL source (historic, no key) | NOAA Marine Cadastre bulk CSV — <https://marinecadastre.gov/accessais/> — import **without** `--demo` |
| REAL source (live, key) | AISStream.io — `AISSTREAM_API_KEY` — needs an adapter (not yet built) |

## C. Ocean currents — REAL, optional (origin runs DEGRADED without it)

| | |
|---|---|
| Keyless | HYCOM GLBy over OPeNDAP — archive ends 2024‑09‑05, so it does **not** cover the 2025 demo date → origin degrades honestly |
| Credentialed | Copernicus Marine `cmems_mod_glo_phy_anfc_0.083deg_PT1H-m` (uo/vo) — `CMEMS_USERNAME/PASSWORD` |
| Consumer | `services/ml/varuna_ml/drift/forcing.py::fetch_currents` |
| Local storage | none by default; the client streams a small AOI/time subset per run |

## D. Wind forcing — REAL, optional (origin runs DEGRADED without it)

| | |
|---|---|
| Source | ERA5 single-levels 10 m u/v via CDS API — `CDSAPI_URL`, `CDSAPI_KEY` |
| Consumer | `services/ml/varuna_ml/drift/forcing.py::fetch_winds` |
| Keyless fallback | none for historic dates (NOAA GFS keeps ~10 days) → `DEGRADED, alpha=0` |

## E. Coastline / land mask — DEMO, bundled

| | |
|---|---|
| Source | Natural Earth (public domain), pre-built basemap tiles in `apps/web/public/basemap/` |
| Builder | `scripts/build-basemap.mjs` |
| Consumer | MapLibre basemap in the web workspace |

## F. ITU MID table — DEMO, bundled

| | |
|---|---|
| File | `data/reference/mid-table.json` (+ `.provenance.json`) — 292 maritime identification digits |
| Consumer | `apps/api` AIS import (MMSI country validation) and vessel flag lookup |

## G. Detector evaluation metrics — REAL, bundled

| | |
|---|---|
| Files | `data/eval/*.json` — measured IoU / false-positive rates for the classical detector on the Trujillo‑Acatitla Sentinel‑1 oil-spill test split (Zenodo, CC‑BY‑4.0) |
| Consumer | `apps/api` dossier — the detector limitation paragraph cites these when present |

## H. Demo detections snapshot — DEMO reference only

| | |
|---|---|
| File | `data/incidents/guam-2025-09-21-detections.json` |
| Use | known-answer reference for QA; **not** loaded into the app — detections are recomputed live |

---

## Storage footprint

| Item | Size |
|---|---|
| Sentinel‑1 AOI COGs (per demo run, in MinIO) | ~130 MB |
| Synthetic AIS CSV | ~15 KB |
| Basemap tiles (committed) | a few MB |
| `data/eval` + `data/reference` (committed) | < 100 KB |
| Ocean/wind subsets (if credentialed) | a few MB per run, not persisted |

Nothing large is committed; `.gitignore` excludes `data/raw`, `data/processed`,
`data/models` and all `*.tif/*.nc/*.parquet/*.zip`.

## Acquisition scripts

| Command | Does |
|---|---|
| `pnpm stage:demo` | pre-fetch the real Sentinel‑1 AOI window into MinIO (idempotent) |
| `pnpm demo:ais` | regenerate `data/demo/ais/guam-2025-09-21.demo.csv` |
| `pnpm demo` | run the whole pipeline (ingests the scene if not staged) |
| `pnpm demo:reset` | drop analysis collections + `scenes/` objects |
