# VARUNA — data sources & credentials

The local demo runs with **no credentials**. Everything below is for lifting a
`DEGRADED` feature to full capability. Never commit real secrets; `.env` is git-ignored and
only `.env.example` (placeholders) is tracked.

Validate any change with `pnpm check:cold-start` (boots the API against `.env.example`
alone) and, for a full run, `pnpm demo`.

---

## Microsoft Planetary Computer — Sentinel‑1 RTC (PRIMARY, no credential)

- **Provider:** Microsoft Planetary Computer — <https://planetarycomputer.microsoft.com/>
- **Purpose:** discover and read Sentinel‑1C RTC scenes (STAC + signed blob URLs).
- **Account required:** no. The STAC search and SAS-token endpoints are anonymous.
- **Optional key:** a subscription key raises rate limits.
  - Page: <https://planetarycomputer.microsoft.com/account/request>
  - Env var: `PLANETARY_COMPUTER_SUBSCRIPTION_KEY`
  - Used by: `services/ml/varuna_ml/ingest/preprocess.py` (`_sas`, `_stac_item`).
  - Frontend needs it: no.
  - Demo works without it: **yes** (this is the working path today).
  - Without it: occasional HTTP 429 under heavy use; the ML service reports the provider error.
- **Validate:** `curl -s -XPOST https://planetarycomputer.microsoft.com/api/stac/v1/search -H 'content-type: application/json' -d '{"collections":["sentinel-1-rtc"],"ids":["S1C_IW_GRDH_1SDV_20250921T200737_20250921T200800_004227_008638_rtc"]}' | jq '.features|length'` → `1`.

---

## Copernicus Data Space Ecosystem — Sentinel‑1 (SECONDARY, credential)

- **Provider:** ESA / Copernicus — <https://dataspace.copernicus.eu/>
- **Purpose:** alternative Sentinel‑1 discovery/access (GRD, SLC, OData/STAC, S3).
- **Account required:** yes (free).
  - Register: <https://dataspace.copernicus.eu/> → *Register*.
  - Create an OAuth client: *Dashboard → User settings → OAuth clients*.
  - Credential type: client id + client secret.
  - Env vars: `CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET` (and optionally `CDSE_S3_ACCESS_KEY`,
    `CDSE_S3_SECRET_KEY` for the S3 view).
  - Used by: not yet wired — reserved for a `services/ml` provider module and the
    `/catalogue` search fallback.
  - Frontend needs it: no.
  - Demo works without it: **yes** (MPC is primary).
  - Without it: no second satellite source; MPC outage has no fallback.

---

## Copernicus Marine (CMEMS) — ocean currents (unlocks real origin back-track)

- **Provider:** Mercator Ocean / Copernicus Marine — <https://marine.copernicus.eu/>
- **Purpose:** surface-current fields for backward Lagrangian drift; without them the origin
  estimate is `DEGRADED / FOOTPRINT_PROXIMITY`.
- **Account required:** yes (free).
  - Register: <https://data.marine.copernicus.eu/register>
  - Credential type: username + password (used by the `copernicusmarine` Python client).
  - Env vars: `CMEMS_USERNAME`, `CMEMS_PASSWORD`
  - Used by: `services/ml/varuna_ml/drift/forcing.py` → `_fetch_cmems` (already coded;
    activates automatically when both vars are set).
  - Frontend needs it: no.
  - Demo works without it: **yes, degraded** — origin returns `FOOTPRINT_PROXIMITY` and says why.
  - Without it: no true upstream/downstream discrimination; candidate tiers stay capped at
    `MODERATE`.
- **Note:** `copernicusmarine` is not yet in `services/ml/pyproject.toml` (it is imported
  lazily). Add `"copernicusmarine>=1.3"` there and rebuild the `ml` image before use.

---

## Climate Data Store (ERA5) — winds (unlocks non-degraded origin)

- **Provider:** ECMWF / Copernicus CDS — <https://cds.climate.copernicus.eu/>
- **Purpose:** 10 m wind fields for the wind-drift term. Missing winds → origin `DEGRADED`
  with `alpha = 0` (currents only).
- **Account required:** yes (free).
  - Register: <https://cds.climate.copernicus.eu/> → *Login/Register*.
  - Get the API key: profile page → *API key* section (`url` + `key`).
  - Accept the *reanalysis-era5-single-levels* licence once on the dataset page.
  - Env vars: `CDSAPI_URL` (default `https://cds.climate.copernicus.eu/api`), `CDSAPI_KEY`
  - Used by: `services/ml/varuna_ml/drift/forcing.py` → `_fetch_era5` (already coded).
  - Frontend needs it: no.
  - Demo works without it: **yes, degraded**.
- **Note:** add `"cdsapi>=0.7"` to `services/ml/pyproject.toml` and rebuild `ml` before use.

---

## AISStream.io — live AIS (unlocks real vessel data)

- **Provider:** AISStream — <https://aisstream.io/>
- **Purpose:** live vessel positions to replace the synthetic demo slice.
- **Account required:** yes (free tier).
  - Register: <https://aisstream.io/> → *Sign up* → *API keys*.
  - Credential type: API key (WebSocket).
  - Env var: `AISSTREAM_API_KEY`
  - Used by: not yet wired — needs an adapter that writes into `ais_positions` via the same
    provenance seam as `apps/api/src/modules/ais/import.ts`.
  - Frontend needs it: no.
  - Demo works without it: **yes** — the labelled synthetic slice is used and shown as
    `SYNTHETIC`.
- **Historic alternative (no key):** NOAA Marine Cadastre bulk CSV
  (<https://marinecadastre.gov/accessais/>) → import with
  `pnpm --filter @varuna/api ais:import -- --file <csv> --from <iso> --to <iso> --bbox w,s,e,n`
  (no `--demo`).

---

## Global Fishing Watch — vessel metadata (optional)

- **Provider:** Global Fishing Watch — <https://globalfishingwatch.org/our-apis/>
- **Purpose:** vessel identity / fishing-effort context.
- **Account required:** yes (free API token). Env var: `GFW_API_TOKEN`. Not on the demo path.

---

## Infrastructure (local, already set)

| Purpose | Where | Value (local dev) |
|---|---|---|
| Object storage | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `minioadmin` / `minioadmin` |
| ML service auth | `ML_SERVICE_TOKEN` | `dev-service-token` (api + ml must match) |
| JWT signing | `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | generated 48-byte random in `.env` |
| Mongo / Redis / MinIO / TiTiler / ML URLs | compose `environment:` | container DNS names |

`.env` is created from `.env.example`; for local dev set `S3_*` to `minioadmin`,
`ML_SERVICE_TOKEN=dev-service-token`, and generate the two JWT secrets
(`openssl rand -base64 48`).

---

## Quick reference

| Feature | Works now? | Needs |
|---|---|---|
| Sentinel‑1 ingest + detection | ✅ | nothing |
| Map + SAR raster tiles | ✅ | nothing |
| Origin back-track (degraded) | ✅ | nothing |
| Origin back-track (full) | ❌ | `CMEMS_*` + `CDSAPI_KEY` (+ add 2 pip deps) |
| AIS correlation (synthetic) | ✅ | nothing |
| AIS correlation (real live) | ❌ | `AISSTREAM_API_KEY` + adapter |
| Second satellite source | ❌ | `CDSE_CLIENT_ID/SECRET` + provider module |
