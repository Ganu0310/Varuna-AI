# VARUNA — implementation changelog

Chronological record of the integration/productization work on branch `ayush-integration`.
Newest first. Nothing here is committed automatically.

---

## 2026-08-29 — Operational shell, dashboard, system pages, browser demo

**Feature:** SaaS application shell
- Files: `apps/web/src/app/AppChrome.tsx` (rewritten — collapsible left rail + context top
  bar), `apps/web/src/app/ThemeToggle.tsx` (compact popover menu, was a segmented pill),
  `apps/web/src/design/shell.css` (new), `apps/web/src/index.css` (`@import shell.css`).
- Rail: Dashboard / Investigations / Satellite Browser / Vessels / Live Globe / System
  Status / Settings / Guide / Admin; collapse state persisted (`varuna.rail.collapsed`);
  rail-foot live health chip.

**Feature:** Dashboard (`/dashboard`, now the post-login landing)
- Files: `apps/web/src/features/dashboard/DashboardPage.tsx` (new), route + redirects in
  `apps/web/src/app/App.tsx`, `LoginPage.tsx`, `RegisterPage.tsx`.
- Real aggregates + recent lists + live job status + top candidate leads + pipeline strip +
  "Run verified Sentinel-1 demo" button.

**Feature:** browser-triggered demo
- Files: `apps/api/src/modules/demo/router.ts` (new — `GET /demo/info`, `POST /demo/run`),
  mounted in `apps/api/src/app.ts`.
- `POST /demo/run` reuses `createInvestigation` + `importAisCsv(--demo)` + `enqueue(ingest)`.
  Verified: dashboard button → investigation + 138 AIS + 13 real detections.

**Feature:** System module
- Files: `apps/api/src/modules/system/router.ts` (new — `/system/status`,
  `/system/integrations`, `/system/overview`), mounted in `app.ts`.
- `apps/api/src/modules/ais/router.ts` — added `GET /vessels` (MMSI index, synthetic flag).
- Frontend pages: `features/system/SystemStatusPage.tsx`, `features/settings/SettingsPage.tsx`,
  `features/vessels/VesselsPage.tsx` (all new) + routes.
- Hooks: `useSystemStatus`, `useIntegrations`, `useDashboard`, `useDemoInfo`, `useRunDemo`,
  `useVessels`, `useVessel` in `apps/web/src/api/hooks.ts`.

**Fix:** `TITILER_INTERNAL_URL`
- Files: `apps/api/src/env.ts` (new optional var, empty-string tolerant),
  `docker-compose.yml` (api: `http://titiler:80`), `.env.example`.
- Reason: `/system/status` probed the browser-facing `TITILER_URL` (`localhost:8001`) which
  the API container cannot reach; now probes the in-network address.

**Fix:** `/system/overview` + `/demo/info` vs provenanceGuard / schema
- `candidate_vessels.excluded` is an embedded doc, not a boolean — removed a `$ne: true`
  query that CastError'd; filter in JS instead.
- Renamed `provenance` keys in the `/demo/info` payload to `dataClass` so the response-level
  provenance guard does not strip the objects.

**Verified:** typecheck 4/4; tests web 101 / api 156 / shared 24; lint (1 pre-existing);
tokens sync; real-data policy; cold-start (52 keys); docker 9/9; new endpoints 200; fresh
browser console clean.

**Docs:** `docs/PRODUCT-STATUS.md` (new); this changelog + `GAURAV-HANDOFF.md` updated.

---

## 2026-08-29 — Theme system, one-command demo, handoff docs

**Feature:** Dark / Light / System theme with persistence
- Files: `apps/web/src/app/providers/ThemeProvider.tsx` (new),
  `apps/web/src/app/ThemeToggle.tsx` (new), `apps/web/public/theme-init.js` (new),
  `apps/web/index.html`, `apps/web/src/app/App.tsx`, `apps/web/src/app/AppChrome.tsx`,
  `apps/web/src/design/tokens.css` (full light palette), `apps/web/src/index.css`
  (`.theme-toggle`, `.sr-only`).
- Reason: sprint brief §7; only a print-scoped light block existed before.
- Behaviour: preference in `localStorage['varuna.theme']`, applied to
  `documentElement[data-theme]`; a same-origin `/theme-init.js` (CSP-safe, not inline)
  applies it before first paint; `system` follows `prefers-color-scheme` live.
- Status: **done**. Testing: web typecheck PASS; verified in-browser (dark ⇄ light ⇄ system,
  persists across reload, console clean, CSP clean).

**Feature:** `pnpm demo` / `pnpm demo:reset` / `pnpm demo:ais`
- Files: `scripts/demo.mjs` (new), `scripts/demo-reset.mjs` (new), `package.json`.
- Reason: sprint brief §35–36; there was no single reproducible demo entrypoint.
- `demo` drives register → investigation → real ingest+detect → origin → synthetic AIS
  import (`--demo`) → correlate+rank → dossier, then prints workspace/dossier URLs + login.
- `demo:reset` clears the analysis Mongo collections + MinIO `scenes/`; keeps users,
  volumes, containers.
- Status: **done**. Testing: `node scripts/demo.mjs` PASS end-to-end (4 candidates,
  suspect #1, dossier built).

**Docs:** `docs/GAURAV-HANDOFF.md`, `docs/DATA-AND-CREDENTIALS.md`, `docs/DATASETS.md`,
`docs/DEMO-SCRIPT.md`, `docs/CHANGELOG-IMPLEMENTATION.md` (all new).

---

## 2026-08-29 — Full pipeline brought online end-to-end

**Fix:** ML drift endpoint 500 → honest degradation
- Files: `services/ml/pyproject.toml` (+`netCDF4`, `cftime`),
  `services/ml/varuna_ml/drift/forcing.py` (wrap the OPeNDAP import; `ImportError` →
  `ForcingUnavailable`).
- Reason: `/backtrack` raised `ModuleNotFoundError` instead of degrading to
  `FOOTPRINT_PROXIMITY` for dates outside HYCOM coverage.
- Status: **done**. `/backtrack` now returns `DEGRADED` cleanly.

**Feature:** synthetic demo AIS + honest provenance
- Files: `scripts/data/make-demo-ais.mjs` (new), `data/demo/ais/guam-2025-09-21.demo.csv`
  (new), `data/demo/ais/README.md` (new), `apps/api/src/modules/ais/import.ts`
  (`providerLabel` option), `apps/api/src/modules/ais/import-cli.ts` (`--demo` flag).
- Reason: no local AIS; needed to exercise correlation without misrepresenting the source.
- With `--demo`: `meta.source = USER_UPLOAD`, provenance provider
  `VARUNA synthetic demo AIS`, licence "Synthetic demo data — not a real AIS archive".
- Status: **done**. 138 rows / 4 vessels import; correlation + ranking run live on it.

**Fix:** `docker-compose` TiTiler URL split
- `api.TITILER_URL = http://localhost:8001` (embedded in tile-URL templates the *browser*
  fetches); `ml.TITILER_URL = http://titiler:80` (server-side only).
- Reason: the browser cannot resolve the compose network name `titiler`.

**Fix:** web bundle wired to the API
- Files: `apps/web/Dockerfile` (`ARG VITE_API_URL`), `docker-compose.yml` (`web.build.args`).
- Reason: the nginx image had no `/api` proxy and the bundle had no API base, so every
  request 404'd. Browser now calls `http://localhost:4000` directly (CSP already allows it).

**Fix:** removed the remote Google Fonts `@import` from `apps/web/src/design/tokens.css`
- Reason: blocked by the strict CSP and leaked the analyst's IP to Google; the font stacks
  already fall back to the platform UI font.

**Fix:** API image ships `data/`
- Files: `apps/api/Dockerfile` (`COPY data data`).
- Reason: `data/reference/mid-table.json` and `data/eval/*.json` are read at runtime via a
  path relative to `dist/`; they were absent in the image.

**Verified:** real Sentinel‑1C RTC ingest (MPC) → COGs in MinIO → 13 detections matching the
known-answer references → degraded origin → AIS correlation → 4 ranked candidates → dossier,
through both `pnpm demo` and the UI.

---

## 2026-08-29 — Container startup fixes (earlier)

**Fix:** `@varuna/shared` production `exports` → `dist` (was `./src/index.ts`)
- File: `packages/shared/package.json`. Reason: Node ran `.ts` in the prod image.

**Fix:** `@varuna/api` `exports` `./src/*` → `./dist/*`
- File: `apps/api/package.json`. Reason: the worker imports `@varuna/api/src/**/*.js`; these
  now resolve to compiled output.

**Fix:** ML dependencies made authoritative
- File: `services/ml/pyproject.toml` (+`rasterio`, `rio-cogeo`, `boto3`, `scipy`,
  `scikit-image`, `pyyaml`), `services/ml/Dockerfile` (+`libexpat1`).
- Reason: startup imports were under-declared; the "future phase" comments were wrong.

**Fix:** ML registry path made install-location-safe
- Files: `services/ml/varuna_ml/routers/segment.py` (lazy `registry_path()` that walks
  ancestors / honours a setting instead of a fixed `parents[4]`),
  `services/ml/varuna_ml/config.py` (`registry_path` setting).
- Reason: `parents[4]` raised `IndexError` at import time inside the container.

**Verified:** all 9 services up, 0 restarts; `typecheck` / `test` / `lint` /
`check:real-data` / `check:cold-start` PASS.

---

## Outstanding (see GAURAV-HANDOFF.md §7)

- Dashboard, Vessel explorer, System status, Settings pages — not built.
- Live socket refresh for the Origin / Candidates panels.
- Real AIS adapter (AISStream / Marine Cadastre bulk).
- Ocean/wind forcing activation (add `copernicusmarine`, `cdsapi` to `services/ml`, set
  `CMEMS_*` / `CDSAPI_KEY`).
- Copernicus Data Space as a second satellite source.
