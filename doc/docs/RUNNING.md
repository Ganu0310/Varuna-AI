# Running VARUNA

Everything needed to take this repository from a fresh clone to a working system, and then to
run a real attribution end to end.

VARUNA processes **real data only** — real Sentinel-1 scenes, real AIS archives, real ocean and
atmosphere models. There is no fixture mode and no seed script, by design
(`13_REAL_DATA_POLICY.md`). That shapes this guide: some steps download real files and take
real time, and a few capabilities are simply unavailable without credentials. Where that is the
case it is said plainly rather than worked around.

---

## 1. Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node | ≥ 20.11 | `engines` in `package.json` |
| pnpm | 9.x | `packageManager` pins `pnpm@9.15.9`; `corepack enable` is the easiest route |
| Python | 3.11+ | for the ML service |
| Docker + Compose | current | datastores and support services |
| Git | any | |

**Windows note.** The repo is developed on Windows. If `git` is not on `PATH` in a fresh
terminal:

```powershell
$env:Path = "C:\Program Files\Git\cmd;$env:Path"
```

---

## 2. First-time setup

```bash
pnpm install

cp .env.example .env
```

`.env.example` is complete for local development — every required variable already has a
working value pointing at the compose services. **You can start the system without editing
it.** Provider credentials are optional and only unlock additional capability (§8).

Verify the contract before going further:

```bash
pnpm check:cold-start
```

This boots the API in a clean child environment containing *only* the documented variables and
cross-checks `.env.example` against the Zod schema, `docker-compose.yml`, the ML service's
Pydantic settings, and every `VITE_*` variable the front-end reads. If it passes, a fresh clone
really can reach a working system from documented values alone.

---

## 3. Start the services

```bash
docker compose up -d mongo redis minio titiler mlflow
```

| Service | Port | Purpose |
| --- | --- | --- |
| mongo | 27017 | primary datastore, incl. the `ais_positions` time-series collection |
| redis | 6379 | BullMQ queues (`--maxmemory-policy noeviction`, deliberately) |
| minio | 9000 / 9001 | S3-compatible object storage for scene rasters; console on 9001 |
| titiler | 8001 | serves map tiles from MinIO (the container listens on **80**, mapped to 8001) |
| mlflow | 5000 | experiment tracking |

MongoDB runs as a single-node replica set (`--replSet rs0`), and the **`mongo-init` container
performs `rs.initiate()`** — bring it up too, or start the whole file. Starting `mongo` on its
own leaves the node in `RSGhost` state: it accepts connections and reports healthy, but every
query fails with *"node is not in primary or recovering state"*.

**If MongoDB is already installed locally**, do not start the `mongo` container. Both bind
27017, and whichever claims the port first wins — so the container can silently shadow a local
server that holds all your data. The data is not lost, but nothing can reach it until you
`docker compose stop mongo`. A standalone local `mongod` works fine for everything except the
few operations needing transactions.

---

## 4. Run the stack

Four processes. Use four terminals, or `pnpm dev` at the root to run the Node ones together.

```bash
# API            → http://localhost:4000
pnpm --filter @varuna/api dev

# Worker         (no port; consumes BullMQ queues)
pnpm --filter @varuna/worker dev

# Web            → http://localhost:5173
pnpm --filter @varuna/web dev

# ML service     → http://localhost:8000
cd services/ml
uv sync --extra dev && uv run uvicorn varuna_ml.main:app --reload --port 8000
# …or without uv:
#   python -m venv .venv && . .venv/Scripts/activate   # Windows
#   pip install -e ".[dev]"
#   uvicorn varuna_ml.main:app --reload --port 8000
```

Check both services are up:

```bash
curl http://localhost:4000/health
curl http://localhost:8000/health
```

The worker registers `ingest`, `drift`, `scoring`, `ais-import` and `report`. **`inference` is
deliberately not registered** — detection currently runs inside the ingest job, and a stub
processor would mark work complete without doing it.

### Everything in containers instead

```bash
docker compose up -d          # web on :5173, api on :4000, ml on :8000
```

---

## 5. Load real AIS data

Nothing is seeded. AIS comes from a real archive you download yourself — for the Guam demo
incident, a yearly CSV from [NOAA Marine Cadastre](https://marinecadastre.gov/accessais/).

```bash
pnpm --filter @varuna/api ais:import -- \
  --file "/path/to/guam_2025.csv" \
  --from 2025-01-01T00:00:00Z \
  --to   2025-12-31T23:59:59Z \
  --bbox 140.5,10.0,150.5,24.5
```

`--bbox` is `west,south,east,north`. A full year over that box is ~3.2 M rows and takes about
two minutes.

The import is **idempotent**: it clears the exact window and box before inserting, so re-running
replaces a slice rather than doubling it. This matters more than it sounds — a time-series
collection cannot carry a unique index, so without the clear step a second import silently
doubles the data and drives the median reporting interval to 0 s, which then feeds a false
"dense enough to reconstruct detailed tracks" line into the report.

---

## 6. Run an attribution end to end

All requests are cookie-authenticated. Register once, then keep the cookie jar.

```bash
BASE=http://localhost:4000/api/v1
JAR=/tmp/varuna.cookies

curl -sc $JAR -X POST $BASE/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"analyst@example.org","password":"CorrectHorseBattery9!","name":"Analyst"}'
# password minimum is 12 characters
```

**1 — Create an investigation** (AOI polygon + UTC window):

```bash
curl -sb $JAR -X POST $BASE/investigations \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Guam 2025-09-21",
    "aoi": {"type":"Polygon","coordinates":[[[144.4,13.2],[145.1,13.2],[145.1,13.8],[144.4,13.8],[144.4,13.2]]]},
    "windowStart": "2025-09-21T00:00:00Z",
    "windowEnd":   "2025-09-22T00:00:00Z"
  }'
```

The AOI ring must be wound **counter-clockwise**. MongoDB reads a clockwise ring as the
polygon's *complement* — i.e. the rest of the planet — which does not error, it just silently
selects everything.

The window may not exceed **30 days** (`MAX_WINDOW_DAYS`), and `windowEnd` must be after
`windowStart`. Optional fields: `description`, `incidentReference`, and `reportedIncidentAt`
(a known incident time, which seeds the release-window prior).

**2 — Find a scene** (live catalogue search against real providers). Note this takes `aoi`, a
**URL-encoded GeoJSON Polygon** — not a bbox:

```bash
AOI=$(python -c "import urllib.parse,json;print(urllib.parse.quote(json.dumps({'type':'Polygon','coordinates':[[[144.4,13.2],[145.1,13.2],[145.1,13.8],[144.4,13.8],[144.4,13.2]]]})))")

curl -sb $JAR "$BASE/catalogue/search?aoi=$AOI&from=2025-09-21T00:00:00Z&to=2025-09-22T00:00:00Z"
```

Nothing is persisted by this call — it reports what the providers say right now, and a
`providerStatus` block makes a partial provider failure visible rather than quietly returning a
shorter list.

**3 — Ingest and detect** (async → returns `202` with a `jobId`):

```bash
curl -sb $JAR -X POST $BASE/investigations/$INV/scenes/ingest \
  -H 'Content-Type: application/json' \
  -d '{"productId":"S1C_IW_GRDH_1SDV_20250921T200737_20250921T200800_004227_008638_rtc"}'
```

Use **RTC** (Radiometrically Terrain Corrected) products. A plain GRD product carries no CRS —
it is still in radar geometry — and ingest will refuse it rather than guess.

**4 — Back-track to an origin:**

```bash
curl -sb $JAR -X POST $BASE/investigations/$INV/origin/run \
  -H 'Content-Type: application/json' \
  -d '{"detectionId":"'$DETECTION'","horizonHours":24,"particleCount":5000}'
```

**5 — Correlate AIS against the origin.** `detectionId` is required; `originEstimateId` is
optional and defaults to the investigation's most recent estimate:

```bash
curl -sb $JAR -X POST $BASE/investigations/$INV/candidates/correlate \
  -H 'Content-Type: application/json' \
  -d '{"detectionId":"'$DETECTION'"}'
```

If a detection is named but no origin estimate exists, this returns **409** and refuses. That
is intentional: correlating against a bare detection footprint produces the weakest possible
attribution while looking exactly like a real result. (An empty or malformed body is rejected
earlier still, as a 400 validation error.)

**6 — Read the dossier:**

```bash
curl -sb $JAR "$BASE/investigations/$INV/report/data?sections=SUMMARY,CANDIDATES,UNCERTAINTY,PROVENANCE"
curl -sb $JAR "$BASE/investigations/$INV/exports/geojson"
curl -sb $JAR "$BASE/investigations/$INV/exports/csv"
curl -sb $JAR "$BASE/investigations/$INV/exports/manifest"
```

`UNCERTAINTY` and `PROVENANCE` cannot be omitted. Requesting a report without them is rejected
(400 at the route schema), and the check is repeated in the service and again in the report job.

Or just use the UI at `http://localhost:5173` — the workspace drives all of the above.

---

## 7. Quality gates

```bash
pnpm typecheck            # 4 workspaces
pnpm lint
pnpm exec prettier --check .
pnpm test                 # API 148 · shared 24 · web 51

pnpm --filter @varuna/api test:integration   # 53 — needs MongoDB running
cd services/ml && pytest                     # 55
```

Project-specific gates:

| Command | Checks |
| --- | --- |
| `pnpm check:real-data` | 6 checks incl. fixture SHA-256 verification; **no mock data can enter any code path** |
| `pnpm check:cold-start` | a fresh clone boots from `.env.example` alone |
| `pnpm check:audit` | `pnpm audit` + `pip-audit`, blocking on high/critical |
| `pnpm check:lineage` | 16 checks walking the provenance DAG on the **operational** DB; fails if a chain from a named vessel back to a provider product is broken |
| `pnpm check:tokens` | design tokens in CSS and TS stay in sync |
| `pnpm bench:envelope` | NFR-6: AIS envelope query p95 (last measured **84 ms at 9,408,344 real positions**, target < 400 ms) |

`check:lineage` and `bench:envelope` read the live database and need data loaded first.

---

## 8. What needs credentials

Nothing here blocks a local run. A missing key removes *capability*; it never degrades data
integrity or substitutes invented values.

| Credential | Without it |
| --- | --- |
| Copernicus / Planetary Computer | catalogue search falls back to remaining keyless providers |
| `CMEMS_USERNAME` / `PASSWORD` | no ocean-current forcing |
| `CDSAPI_KEY` | no ERA5 wind; the detector's wind-suitability term stays unknown (0.5) |
| `MAPTILER_KEY` / `MAPBOX_TOKEN` | none — the basemap is generated locally and needs no token |

**Known gap in the demo data.** HYCOM's archive ends 2024-09-05 and its operational feed only
covers roughly the last two weeks, so the 2025-09-21 demo incident falls in between. Drift
therefore runs `DEGRADED` and falls back to `FOOTPRINT_PROXIMITY`, which **caps every candidate
at MODERATE**. This is correct behaviour, not a failure — a proximity zone cannot tell an
upstream discharging vessel from ordinary passing traffic — and the reason is stored on the
origin estimate and printed in the report's uncertainty section. Supplying CMEMS credentials
lifts it.

---

## 9. Troubleshooting

**`EADDRINUSE` on 4000** — a previous `tsx watch` is still alive and will serve stale code.
`npx kill-port 4000`, or find it with `netstat -ano | findstr :4000` and `taskkill /PID <pid> /F`.

**The map is blank** — should not happen since the canvas-height and style fixes, but if it
recurs, open the console: a MapLibre style error aborts the entire style and leaves a black
rectangle with no other symptom.

**Workspace stuck on "Loading…"** — it now renders a real error instead. The usual cause is a
403: your account is not a member of that investigation.

**Empty API responses, or objects reduced to `{_id, __provenanceMissing: true}`** — the
provenance guard stripped them. The object failed validation against the shared provenance
schema. Note that `provenance` is a **reserved key**: any object carrying it is validated as a
provenance *record*, so do not use that name for anything else.

**`pnpm check:lineage` fails with "no candidate vessels"** — nothing has been run yet. Complete
§6 first. The gate fails rather than skipping on purpose: a lineage check that reports green on
an empty database is worse than none.

**Integration tests all report "skipped"** — they skip rather than fail when MongoDB is
unreachable, so a wall of `↓` means no database, not passing tests. Check the port conflict in
§3. They use a separate `varuna_test` database and never touch your working data.

**Unit tests hang or time out** — they should not: the unit suite is required to run with no
services at all (`pnpm --filter @varuna/api test` passes with Docker stopped). If it hangs
again, suspect a new module-scope client that blocks on a connection. Quota accounting hit
exactly this: it shares BullMQ's Redis connection, which sets `maxRetriesPerRequest: null`, and
ioredis then queues commands forever instead of rejecting.

---

## 10. Not yet runnable here

Stated so nobody loses time looking for a way to run them:

- **Playwright E2E** (`apps/web/e2e/`) — both journeys are written and Chromium is installed,
  but they have never been executed. They need the API, ML service, web server and a seeded
  account up together, plus `E2E_EMAIL`, `E2E_PASSWORD`, `E2E_INVESTIGATION_ID`. They are built
  with **no fixture fallback**, so they fail rather than skip when the stack is absent.
- **k6 load profile** (`tests/load/envelope.js`) — written; k6 is not installed on the
  development machine. NFR-6 was measured directly at the datastore instead
  (`pnpm bench:envelope`); **NFR-7 (50 concurrent investigations) remains unmeasured**.
- **Manual keyboard / screen-reader passes** — not done. axe-core covers every route that
  renders in jsdom, but the workspace needs a WebGL context and is therefore **not covered**, so
  the screen an analyst actually works in has no accessibility sign-off.
