# VARUNA — product status

_Verified 2026-08-29, branch `ayush-integration`. All changes uncommitted._

## How to run the demo

```bash
docker compose up -d          # 9 services
# then either:
#   Browser: http://localhost:5173 → sign in → Dashboard → "Run verified Sentinel-1 demo"
#   CLI:     pnpm demo
```

`pnpm demo:reset` clears analysis state (keeps users, volumes). Demo login used in QA:
`uidemo1@varuna.local` / `demo-password-123`.

## What is complete (wired + verified in-browser)

| Area | State |
|---|---|
| Application shell | Collapsible left rail (Dashboard, Investigations, Satellite Browser, Vessels, Live Globe, System Status, Settings, Guide, Admin), context top bar, rail health indicator, collapse state persisted |
| Theme | Compact dark/system/light menu in the top bar; persisted (`localStorage varuna.theme`); pre-paint via `/theme-init.js`; full light token palette |
| Dashboard (`/dashboard`) | Real aggregates (investigations, scenes, detections, candidates, jobs), recent investigations, processing queue with live job status, recent detections, top candidate leads, pipeline strip, **"Run verified Sentinel-1 demo"** button |
| Demo launcher | `POST /api/v1/demo/run` creates the Guam investigation, imports the synthetic AIS slice, queues the real ingest; browser navigates to the workspace. Verified: 1 scene + 13 detections + 138 AIS produced |
| System Status (`/status`) | Live probes of Mongo, Redis, MinIO, ML, TiTiler with latency + detail; "what degrades what" reference |
| Settings (`/settings`) | Data-source configuration status by category (satellite / forcing / AIS), never shows secret values, links to provider pages |
| Vessel Explorer (`/vessels`) | MMSI index from `ais_positions` with fix count / span / source; synthetic vessels marked; per-vessel detail (flag, positions, last seen, source, identity note) |
| Login | Reworked panel, show/hide password, `?from=` return-path, redirects to `/dashboard` |
| Investigation workspace | Unchanged and working: map, SAR raster tiles, detections, AIS tracks, origin zone, origin panel, candidate ranking, dossier + exports |

## What is REAL / SYNTHETIC / DEGRADED

- **REAL** — Sentinel-1C RTC scene `S1C_IW_GRDH_1SDV_20250921T200737_20250921T200800_004227_008638_rtc`
  from Microsoft Planetary Computer; the VV/VH COGs in MinIO; the 13 derived detections
  (top ≈ 1.1981 km², conf 0.61, look-alike 0.24, centroid 13.44894/144.66928).
- **SYNTHETIC** — the AIS slice (`data/demo/ais/guam-2025-09-21.demo.csv`). Imported with a
  provenance label of `VARUNA synthetic demo AIS`; shown as `SYNTHETIC` in the UI.
- **DEGRADED** — the origin estimate: no keyless ocean/wind model covers 2025-09-21, so it
  runs `FOOTPRINT_PROXIMITY` and candidate tiers cap at `MODERATE`. Surfaced in the Origin
  panel, System Status, and Settings.

## What Gaurav should test

1. Sign in → land on **Dashboard**; confirm counts and the processing queue reflect reality.
2. Click **Run verified Sentinel-1 demo** → workspace opens → wait ~60–90 s → 13 detections
   appear on the map and in the table.
3. Workspace → **Origin** → Run back-tracking → confirm `DEGRADED / FOOTPRINT_PROXIMITY`.
4. **Rank candidate vessels** → 4 candidates, all `MODERATE`, MMSI 538005123 first.
5. **Dossier** → all sections render; try GeoJSON / CSV / manifest export.
6. **System Status** → all services healthy (ML may read `Down` briefly *during* an ingest —
   uvicorn is single-worker and the sync raster read blocks `/health`; it recovers).
7. **Settings** → every provider shows `OPTIONAL — NOT CONFIGURED` (nothing is required).
8. **Vessels** → 4 synthetic vessels; open one for its record.
9. Top bar theme menu → dark / light / system; reload → choice persists.
10. Collapse the left rail → state persists across navigation.

## Optional credentials (none required)

| Unlocks | Provider | Env vars |
|---|---|---|
| Real Lagrangian origin (currents) | Copernicus Marine | `CMEMS_USERNAME`, `CMEMS_PASSWORD` (+ add `copernicusmarine` to `services/ml/pyproject.toml`) |
| Non-degraded origin (winds) | Climate Data Store / ERA5 | `CDSAPI_KEY` (+ add `cdsapi`) |
| Live AIS | AISStream.io | `AISSTREAM_API_KEY` (+ adapter) |
| MPC rate limits | Microsoft Planetary Computer | `PLANETARY_COMPUTER_SUBSCRIPTION_KEY` |

Full steps: [DATA-AND-CREDENTIALS.md](DATA-AND-CREDENTIALS.md).

## Known limitations

- **ML `/health` blocks during ingest** — single uvicorn worker; a sync rasterio read holds
  the loop. System Status can flash `Down` for ~60 s per ingest. Fix: `--workers 2` or move
  the read to a thread pool.
- **Panel live-refresh** — Origin / Candidates panels need a page refresh to pick up a
  just-finished job. Socket infra is in place; the panels are not yet subscribed.
- **Not built** — investigation-creation stepper redesign, map-draw AOI, raster upload,
  full workspace visual redesign, per-scene "create investigation" from the catalogue,
  standalone Reports index.
- **Catalogue page** — live STAC search exists (pre-existing) but was not restyled this pass.
- Web bundle ships MapLibre (~1 MB) + deck.gl (~750 kB) chunks — already split, workspace-only.

## Verification snapshot

```
typecheck ........ PASS (4 workspaces)
tests ............ PASS  web 101 · api 156 · shared 24 · ml 26
lint ............. PASS (1 pre-existing warning)
tokens sync ...... PASS   real-data policy .. PASS   cold-start .. PASS (52 keys)
docker ........... 9/9 up
API endpoints .... /system/status, /system/integrations, /system/overview,
                   /demo/info, /demo/run, /vessels  — all 200
demo (browser) ... Dashboard button → investigation + 13 detections + 138 AIS
UI (fresh tab) ... dashboard / status / settings / vessels render; console clean
```
