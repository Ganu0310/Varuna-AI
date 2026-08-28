# 11 — API Keys & External Services Register

**Product:** VARUNA
**Problem Statement:** SIH26143
**Document version:** 1.0

> Companion to [02_TRD §2.14](02_TRD_Technical_Requirements.md), which carries the
> at-a-glance table. This document is the operational register: exact signup route, what
> the credential looks like, quota, cost, env-var name, failure behaviour, and rotation.
>
> **Every service required for the MVP is free.** Nothing on the critical path costs money.

---

## 11.1 Register at a glance

| Tier | Count | Purpose |
|---|---|---|
| **A — Required for MVP** | 11 | The system cannot run without these |
| **B — No credential needed** | 8 | Open bulk endpoints; still documented because they are dependencies |
| **C — Optional / Phase 2** | 8 | Enhancements, alerting, better coverage |
| **D — Paid, not required** | 5 | Documented for completeness and for a production deployment |

---

## 11.2 Tier A — Required for MVP (all free)

### A1 · Copernicus Data Space Ecosystem (CDSE)

| Field | Value |
|---|---|
| **Purpose** | Sentinel-1 SAR and Sentinel-2 optical scene catalogue and download — the authoritative ESA source |
| **Signup** | `dataspace.copernicus.eu` → Register → confirm email → **Dashboard → User Settings → OAuth clients → Create** |
| **Credential type** | OAuth2 client credentials (client ID + client secret) → exchanged for a bearer token |
| **Token endpoint** | `https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token` |
| **Token TTL** | ~10 minutes; refresh before expiry (we cache in Redis with a 60 s safety margin) |
| **Env vars** | `CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET` |
| **Optional** | `CDSE_S3_ACCESS_KEY`, `CDSE_S3_SECRET_KEY` for direct S3 object access to the archive |
| **Cost** | Free |
| **Quota** | Fair-use download limits per account; catalogue queries are effectively unlimited |
| **APIs used** | OData catalogue, STAC, S3 |
| **On failure** | Fall through to Planetary Computer, then ASF. Chain exhaustion → `UNAVAILABLE`. |
| **Signup effort** | ~10 minutes |

### A2 · Microsoft Planetary Computer

| Field | Value |
|---|---|
| **Purpose** | **Sentinel-1 RTC** — radiometrically terrain-corrected, i.e. already preprocessed. Cuts ingest from ~12 min to ~2 min per scene. |
| **Signup** | `planetarycomputer.microsoft.com` → the STAC API is usable **anonymously**; request a subscription key for higher rate limits and SAS token signing |
| **Credential type** | Subscription key (header `Ocp-Apim-Subscription-Key`) — optional |
| **Env var** | `PLANETARY_COMPUTER_SUBSCRIPTION_KEY` |
| **Cost** | Free |
| **Quota** | Generous; SAS tokens for asset access are short-lived and auto-refreshed by the `planetary-computer` Python package |
| **On failure** | Fall through to CDSE |
| **Signup effort** | ~5 minutes (or skip entirely for anonymous access) |
| **Note** | ⭐ **Recommended as the primary download route** precisely because RTC removes the SNAP dependency from the critical path |

### A3 · NASA Earthdata Login

| Field | Value |
|---|---|
| **Purpose** | Sentinel-1 access via ASF DAAC (`asf_search`); also SRTM DEM and OSCAR currents |
| **Signup** | `urs.earthdata.nasa.gov` → Register |
| **Credential type** | Username + password (used to mint a bearer token); a long-lived user token can also be generated in the profile |
| **Env vars** | `EARTHDATA_USERNAME`, `EARTHDATA_PASSWORD` |
| **Cost** | Free |
| **Important** | Some datasets require you to **explicitly accept the EULA** in your Earthdata profile before download works. A 401 on download with valid credentials almost always means an unaccepted EULA — check this before debugging the code. |
| **On failure** | Third in the satellite chain; failure means chain exhaustion |
| **Signup effort** | ~5 minutes |

### A4 · Copernicus Marine Service (CMEMS)

| Field | Value |
|---|---|
| **Purpose** | **Ocean surface currents** for backward drift — the core of our differentiation |
| **Signup** | `marine.copernicus.eu` → Register → confirm email |
| **Credential type** | Username + password (used by the `copernicusmarine` Python toolbox) |
| **Env vars** | `CMEMS_USERNAME`, `CMEMS_PASSWORD` |
| **Login command** | `copernicusmarine login` writes credentials to `~/.copernicusmarine/`; in containers we pass env vars instead |
| **Primary dataset** | `GLOBAL_ANALYSISFORECAST_PHY_001_024` (1/12°, hourly, `uo`/`vo`) |
| **Cost** | Free |
| **Quota** | Fair use; subset requests are throttled if abused |
| **On failure** | Fall through to HYCOM (no key). Both failing → origin estimate `DEGRADED`, footprint-proximity mode, banner shown. |
| **Signup effort** | ~10 minutes |

### A5 · Copernicus Climate Data Store (ERA5)

| Field | Value |
|---|---|
| **Purpose** | 10 m wind fields — used **both** for the drift wind term **and** the SAR detectability gate |
| **Signup** | `cds.climate.copernicus.eu` → Register → **accept the ERA5 dataset licence on the dataset page** (required, easily missed) |
| **Credential type** | UID + API key, normally written to `~/.cdsapirc` |
| **Env vars** | `CDSAPI_URL`, `CDSAPI_KEY` (format: `UID:api-key`) |
| **Cost** | Free |
| **Quota** | Request queue; large requests can wait minutes to hours. **Pre-fetch demo data — do not request ERA5 live during a presentation.** |
| **Latency** | ERA5 is a reanalysis, ~5 days behind real time |
| **On failure** | Fall through to NOAA GFS (no key) |
| **Signup effort** | ~10 minutes plus licence acceptance |

### A6 · Global Fishing Watch API

| Field | Value |
|---|---|
| **Purpose** | AIS vessel identity, AIS-derived events (including **gap events**), gridded activity |
| **Signup** | `globalfishingwatch.org/our-apis/` → request API access, stating purpose (hackathon/research is an accepted use) |
| **Credential type** | Bearer token |
| **Env var** | `GFW_API_TOKEN` |
| **Base URL** | `https://gateway.api.globalfishingwatch.org` |
| **Cost** | Free for non-commercial use with attribution |
| **Quota** | Rate-limited per token |
| **Approval time** | ⚠️ Can take **several days** — request in week 1 |
| **On failure** | Fall through to bulk archives (Marine Cadastre / DMA) |

### A7 · AISStream.io

| Field | Value |
|---|---|
| **Purpose** | Live AIS WebSocket stream (Phase-2 monitoring; not used for historical reconstruction) |
| **Signup** | `aisstream.io` → sign up → key issued immediately |
| **Credential type** | API key sent in the WebSocket subscription message |
| **Env var** | `AISSTREAM_API_KEY` |
| **Endpoint** | `wss://stream.aisstream.io/v0/stream` |
| **Cost** | Free |
| **Coverage** | Terrestrial AIS — good coastal, limited open-ocean |
| **Security note** | The key is used **only** by the server-side AIS bridge worker. The browser never connects to this endpoint directly — doing so would expose the key. |
| **Signup effort** | ~2 minutes |

### A8 · MongoDB Atlas

| Field | Value |
|---|---|
| **Purpose** | Primary database (MERN "M") |
| **Signup** | `mongodb.com/cloud/atlas` → free **M0** cluster |
| **Credential type** | SRV connection string with embedded user/password |
| **Env vars** | `MONGODB_URI`, `MONGODB_DB_NAME` |
| **Cost** | Free (M0: 512 MB) |
| **⚠️ Constraint** | **M0 does not support time-series collection sharding and has a 512 MB cap.** Our AIS volume will exceed this quickly. **Plan: run MongoDB 7 locally/in Docker for development and the demo**, and use Atlas M0 only for a hosted showcase with a reduced AIS slice. This is a real constraint and it is better to plan for it than discover it at 2 a.m. |
| **Network** | Atlas requires IP allowlisting — add `0.0.0.0/0` only for a temporary demo, never for anything persistent |
| **Signup effort** | ~10 minutes |

### A9 · Object storage — Cloudflare R2 (or MinIO locally)

| Field | Value |
|---|---|
| **Purpose** | Scenes, COGs, masks, probability rasters, origin grids, report PDFs |
| **Signup** | `dash.cloudflare.com` → R2 → Create bucket → **Manage R2 API Tokens** |
| **Credential type** | S3-compatible access key ID + secret access key |
| **Env vars** | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` |
| **Endpoint format** | `https://<account-id>.r2.cloudflarestorage.com` |
| **Cost** | Free tier ~10 GB storage; **zero egress fees** — the reason R2 is chosen over S3 for serving 1 GB scenes and map tiles |
| **Local equivalent** | MinIO in docker-compose: `S3_ENDPOINT=http://minio:9000`, `S3_FORCE_PATH_STYLE=true`, default creds `minioadmin/minioadmin` |
| **Signup effort** | ~10 minutes |

### A10 · Redis — Upstash (or local Redis)

| Field | Value |
|---|---|
| **Purpose** | BullMQ job broker, provider token cache, quota counters, rate limiting |
| **Signup** | `upstash.com` → create Redis database |
| **Credential type** | Connection URL with embedded token |
| **Env var** | `REDIS_URL` |
| **Cost** | Free tier (command-count limited) |
| **⚠️ Constraint** | BullMQ requires `maxmemory-policy: noeviction`. Some managed free tiers default to an eviction policy, which will **silently lose jobs**. Verify this setting, or use local Redis in docker-compose. |
| **Local equivalent** | `redis:7-alpine` in docker-compose |

### A11 · Sentry

| Field | Value |
|---|---|
| **Purpose** | Error monitoring on client and server |
| **Signup** | `sentry.io` → create project (one for React, one for Node) |
| **Credential type** | DSN (public, safe in the client bundle) + auth token for source-map upload (secret) |
| **Env vars** | `SENTRY_DSN`, `VITE_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` |
| **Cost** | Free developer tier |
| **PII** | Scrubbing enabled; request bodies not captured |

---

## 11.3 Tier B — No credential required

These have no key but are hard dependencies and must be documented as such.

| # | Service | URL | Used for | Failure behaviour |
|---|---|---|---|---|
| B1 | **NOAA Marine Cadastre AIS** | `marinecadastre.gov/ais/` | ⭐ Free bulk historical AIS, US waters, 1-minute resolution, 2009→present | Chain falls to DMA / GFW |
| B2 | **Danish Maritime Authority AIS** | `web.ais.dk/aisdata/` | ⭐ Free daily AIS CSVs, Danish waters, 2006→present | Chain falls through |
| B3 | **NOAA NOMADS (GFS)** | `nomads.ncep.noaa.gov` | Wind fallback when ERA5 is unavailable or too slow | Drift runs `DEGRADED` |
| B4 | **HYCOM** | `hycom.org` | Ocean-current fallback | Drift runs `DEGRADED` |
| B5 | **Element 84 Earth Search** | `earth-search.aws.element84.com/v1` | Sentinel-2 COGs on AWS, no key | Optical unavailable (non-blocking) |
| B6 | **GSHHG / OSM coastlines** | `soest.hawaii.edu/pwessel/gshhg/` | Land masking | Downloaded once and vendored |
| B7 | **GEBCO bathymetry** | `gebco.net` | Map context | Cosmetic only |
| B8 | **ITU MID table** | ITU | MMSI country-prefix validation | Vendored as a static table |

> **Note on B6–B8:** these are downloaded once and committed to object storage with
> provenance records. They are not fetched at runtime, so a provider outage cannot affect a
> live demo.

---

## 11.4 Tier C — Optional / Phase 2 (free tiers)

| # | Service | Purpose | Env var | Note |
|---|---|---|---|---|
| C1 | **Sentinel Hub** | On-the-fly SAR/optical processing API | `SENTINELHUB_CLIENT_ID`, `SENTINELHUB_CLIENT_SECRET` | Free tier via CDSE with a monthly processing-unit allowance. Useful for fast quicklooks. |
| C2 | **MapTiler** | Hosted basemap styles | `MAPTILER_KEY` | Free tier ~100k tile requests/month. **Optional** — MapLibre works with free demo styles or self-hosted Protomaps. |
| C3 | **Mapbox** | Alternative basemap | `MAPBOX_TOKEN` | Free tier 50k map loads/month. We use MapLibre specifically to avoid a mandatory token. |
| C4 | **Resend** | Alert email | `RESEND_API_KEY` | Free tier 100 emails/day. Only needed for Phase-2 alerting. |
| C5 | **Twilio** | SMS alerts | `TWILIO_*` | Trial credit. Genuinely optional. |
| C6 | **Weights & Biases** | ML experiment tracking | `WANDB_API_KEY` | Free for personal/academic. **MLflow self-hosted is the zero-key alternative** and is what the docker-compose ships. |
| C7 | **Hugging Face** | Model hosting / SegFormer weights | `HF_TOKEN` | Only needed for gated models; `nvidia/mit-b2` is public |
| C8 | **USGS M2M (Landsat)** | Landsat 8/9 scenes | `USGS_M2M_USERNAME`, `USGS_M2M_TOKEN` | Only for pre-Sentinel historical incidents |

---

## 11.5 Tier D — Paid (documented, not required)

| # | Service | Purpose | Rough cost model | Why we do not need it for MVP |
|---|---|---|---|---|
| D1 | **MarineTraffic API** | Global commercial AIS | Credit packs, per-call | Free archives cover our demo regions |
| D2 | **Spire Maritime** | Satellite AIS with true open-ocean coverage | Enterprise subscription | ⭐ Worth applying to their **academic/research programme** — genuinely the best answer for open-ocean incidents like Sanchi or Wakashio |
| D3 | **VesselFinder / Datalastic** | Commercial AIS | Subscription | Redundant with D1 |
| D4 | **AISHub** | Community AIS | "Free" but **requires contributing your own AIS receiver feed** | We have no receiver hardware |
| D5 | **KSAT / Orbital EOS** | Commercial detection services | Enterprise | These are competitors, not suppliers |

---

## 11.6 Complete `.env.example`

```bash
# ══════════════════════════════════════════════════════════════════════
#  VARUNA — environment configuration
#  Copy to .env and fill in. NEVER commit .env.
#  Every value below is a non-functional placeholder.
# ══════════════════════════════════════════════════════════════════════

# ── core ──────────────────────────────────────────────────────────────
NODE_ENV=development
PORT=4000
PUBLIC_APP_URL=http://localhost:5173
LOG_LEVEL=info

# ── datastores ────────────────────────────────────────────────────────
MONGODB_URI=mongodb://localhost:27017/?replicaSet=rs0
MONGODB_DB_NAME=varuna
REDIS_URL=redis://localhost:6379

# ── object storage (S3-compatible; MinIO locally) ─────────────────────
S3_ENDPOINT=http://localhost:9000
S3_REGION=auto
S3_BUCKET=varuna
S3_ACCESS_KEY_ID=REPLACE_ME
S3_SECRET_ACCESS_KEY=REPLACE_ME
S3_FORCE_PATH_STYLE=true

# ── auth (generate with: openssl rand -base64 48) ─────────────────────
JWT_ACCESS_SECRET=REPLACE_ME_WITH_A_48_BYTE_RANDOM_STRING
JWT_REFRESH_SECRET=REPLACE_ME_WITH_A_DIFFERENT_48_BYTE_RANDOM_STRING
COOKIE_DOMAIN=localhost

# ── internal services ─────────────────────────────────────────────────
ML_SERVICE_URL=http://localhost:8000
ML_SERVICE_TOKEN=REPLACE_ME
TITILER_URL=http://localhost:8001

# ── A1  Copernicus Data Space Ecosystem ───────────────────────────────
CDSE_CLIENT_ID=REPLACE_ME
CDSE_CLIENT_SECRET=REPLACE_ME
CDSE_S3_ACCESS_KEY=
CDSE_S3_SECRET_KEY=

# ── A2  Microsoft Planetary Computer (optional key) ───────────────────
PLANETARY_COMPUTER_SUBSCRIPTION_KEY=

# ── A3  NASA Earthdata Login (for ASF DAAC) ───────────────────────────
EARTHDATA_USERNAME=REPLACE_ME
EARTHDATA_PASSWORD=REPLACE_ME

# ── A4  Copernicus Marine Service (ocean currents) ────────────────────
CMEMS_USERNAME=REPLACE_ME
CMEMS_PASSWORD=REPLACE_ME

# ── A5  Climate Data Store (ERA5 winds) ───────────────────────────────
CDSAPI_URL=https://cds.climate.copernicus.eu/api
CDSAPI_KEY=REPLACE_ME

# ── A6  Global Fishing Watch ──────────────────────────────────────────
GFW_API_TOKEN=REPLACE_ME

# ── A7  AISStream.io (live AIS) ───────────────────────────────────────
AISSTREAM_API_KEY=REPLACE_ME

# ── A11 Sentry ────────────────────────────────────────────────────────
SENTRY_DSN=
VITE_SENTRY_DSN=
SENTRY_AUTH_TOKEN=

# ── B  no credential required (documented for clarity) ────────────────
NOAA_GFS_BASE_URL=https://nomads.ncep.noaa.gov
MARINE_CADASTRE_BASE_URL=https://coast.noaa.gov/htdata/CMSP/AISDataHandler
DMA_AIS_BASE_URL=https://web.ais.dk/aisdata

# ── C  optional ───────────────────────────────────────────────────────
SENTINELHUB_CLIENT_ID=
SENTINELHUB_CLIENT_SECRET=
MAPTILER_KEY=
MAPBOX_TOKEN=
RESEND_API_KEY=
WANDB_API_KEY=
HF_TOKEN=
USGS_M2M_USERNAME=
USGS_M2M_TOKEN=

# ── D  paid (leave blank) ─────────────────────────────────────────────
MARINETRAFFIC_API_KEY=
SPIRE_MARITIME_TOKEN=
AISHUB_USERNAME=
```

---

## 11.7 Boot-time validation

```ts
// apps/api/src/env.ts
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().default(4000),
  PUBLIC_APP_URL: z.string().url(),

  MONGODB_URI: z.string().min(1),
  MONGODB_DB_NAME: z.string().min(1),
  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),

  JWT_ACCESS_SECRET:  z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),

  ML_SERVICE_URL: z.string().url(),
  ML_SERVICE_TOKEN: z.string().min(1),

  // Providers — optional at the type level, but see the runtime check below
  CDSE_CLIENT_ID: z.string().optional(),
  CDSE_CLIENT_SECRET: z.string().optional(),
  PLANETARY_COMPUTER_SUBSCRIPTION_KEY: z.string().optional(),
  EARTHDATA_USERNAME: z.string().optional(),
  EARTHDATA_PASSWORD: z.string().optional(),
  CMEMS_USERNAME: z.string().optional(),
  CMEMS_PASSWORD: z.string().optional(),
  CDSAPI_KEY: z.string().optional(),
  GFW_API_TOKEN: z.string().optional(),
  AISSTREAM_API_KEY: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment configuration:\n',
    parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
export const env = parsed.data;

/**
 * A provider chain with no configured credentials is a configuration error we want to
 * discover at boot, not when an analyst clicks "search". We warn loudly rather than
 * exiting, because a partially-configured system is still useful for development.
 */
export function assertProviderChains() {
  const checks = [
    { chain: 'SATELLITE',      ok: !!(env.CDSE_CLIENT_ID || env.EARTHDATA_USERNAME
                                      || env.PLANETARY_COMPUTER_SUBSCRIPTION_KEY !== undefined) },
    { chain: 'OCEAN_CURRENTS', ok: !!env.CMEMS_USERNAME },   // HYCOM needs no key
    { chain: 'WIND',           ok: !!env.CDSAPI_KEY },       // GFS needs no key
    { chain: 'AIS',            ok: true },                   // bulk archives need no key
  ];
  for (const c of checks) {
    if (!c.ok) {
      logger.warn(
        { chain: c.chain },
        `No credential configured for the ${c.chain} provider chain. ` +
        `Requests will fall back to keyless providers, and will return UNAVAILABLE ` +
        `if those also fail. This will NOT produce placeholder data.`
      );
    }
  }
}
```

The final sentence of that warning is deliberate: an operator reading the log must know
that a missing key degrades capability, never data integrity.

---

## 11.8 Quota accounting

Every provider call consumes a Redis counter, exposed in the admin UI.

```ts
// providers/quota.ts
export class QuotaTracker {
  /**
   * Windowed quota counters, keyed by provider and period. We track consumption
   * ourselves rather than relying on provider 429s, because discovering a quota
   * ceiling mid-demonstration is a failure mode we can simply design out.
   */
  async consume(provider: string, cost = 1): Promise<void> {
    const key = `quota:${provider}:${currentPeriod(provider)}`;
    const used = await redis.incrby(key, cost);
    await redis.expire(key, periodSeconds(provider), 'NX');

    const limit = QUOTA_LIMITS[provider];
    if (limit && used > limit) {
      await redis.decrby(key, cost);
      throw new QuotaExhausted(provider, used, limit, resetAt(provider));
    }
    if (limit && used > limit * 0.8) {
      logger.warn({ provider, used, limit }, 'Provider quota above 80%');
      await notifyAdmins(`${provider} quota at ${Math.round(100 * used / limit)}%`);
    }
  }
}
```

| Provider | Tracked period | Soft limit we set | Reason |
|---|---|---|---|
| CDSE catalogue | hour | 500 | Well under fair use |
| CDSE download | day | 40 scenes | ~40 GB/day |
| Planetary Computer | hour | 1,000 | — |
| ASF | day | 30 scenes | — |
| CMEMS subset | day | 100 | Each request is a real subset job |
| CDS (ERA5) | day | 50 | ⚠️ CDS queues; large requests can take hours |
| GFW | hour | 200 | Conservative |
| AISStream | — | 1 connection | Single shared bridge worker |

---

## 11.9 Security requirements for credentials

| ID | Requirement | Enforcement |
|---|---|---|
| KEY-1 | No key in client code, the built bundle, or the repository | `gitleaks` in CI **and** a pre-commit hook; a Vite build check asserts no `VITE_`-prefixed variable matches a secret pattern |
| KEY-2 | All provider calls are server-side | Architectural: the browser has no provider client. The AIS live bridge is a server worker. |
| KEY-3 | Keys injected as environment variables only | No config files with secrets; `.env` is in `.gitignore` |
| KEY-4 | Boot-time validation, fail-fast on missing required keys | `env.ts` (§11.7) |
| KEY-5 | Tokens cached in Redis, never logged | pino redaction list includes `authorization`, `client_secret`, `password`, `token`, `api_key` |
| KEY-6 | Rotation quarterly, and immediately on any suspected exposure | Documented runbook (§11.10) |
| KEY-7 | Least privilege | R2 tokens scoped to the single bucket; MongoDB user has no admin rights; the audit-log collection is write-only for the app user |
| KEY-8 | `.env.example` complete, with obviously non-functional placeholders | CI check: every `env.ts` key must appear in `.env.example` |
| KEY-9 | Different credentials per environment | Separate CDSE clients, R2 buckets and Mongo databases for dev / staging / demo |

### 11.9.1 The specific mistake to avoid

The most common way a project like this leaks a key is putting a data-provider token in a
`VITE_`-prefixed variable so the frontend can call the provider directly. **Anything
prefixed `VITE_` is compiled into the JavaScript bundle and is public.** The only `VITE_`
variables in VARUNA are `VITE_API_URL` and `VITE_SENTRY_DSN` (a Sentry DSN is designed to
be public). Every other credential is server-side, and the map tile proxy exists precisely
so that even the tile requests do not carry a provider key to the browser.

---

## 11.10 Rotation runbook

1. Generate the new credential in the provider console **without revoking the old one**.
2. Add the new value to the deployment secret store under a temporary name.
3. Deploy with dual-read support (the `ProviderClient` accepts `KEY` and `KEY_NEXT`).
4. Confirm the new credential is serving traffic — check the admin provider-health panel
   for a successful call attributed to the new key.
5. Promote `KEY_NEXT` to `KEY`; remove the temporary variable.
6. **Revoke the old credential in the provider console.**
7. Record the rotation in the audit log with the operator, date and reason.

**Never** rotate by revoking first. A revoke-then-replace sequence guarantees an outage,
and on this system an outage during a job means partially-ingested scenes to clean up.

---

## 11.11 Setup checklist

Print this. Tick it off in week 1.

```
TIER A — REQUIRED (all free)
[ ] A1  CDSE ................ registered · OAuth client created · token exchange tested
[ ] A2  Planetary Computer .. STAC query tested (anonymous is fine)
[ ] A3  NASA Earthdata ...... registered · EULA accepted · asf_search download tested
[ ] A4  CMEMS ............... registered · copernicusmarine subset tested
[ ] A5  CDS / ERA5 .......... registered · dataset licence ACCEPTED · cdsapi retrieve tested
[ ] A6  Global Fishing Watch  requested (⚠ may take days) · token received · call tested
[ ] A7  AISStream ........... key issued · websocket subscription tested
[ ] A8  MongoDB ............. local replica set running  (Atlas M0 optional, 512 MB cap)
[ ] A9  Object storage ...... MinIO running locally · bucket created  (R2 for hosted demo)
[ ] A10 Redis ............... running · maxmemory-policy verified as noeviction
[ ] A11 Sentry .............. projects created · DSNs configured

DATA (see 10_DATASETS)
[ ] MKLab/CERTH dataset request submitted (⚠ WEEK 1 — blocks the ML workstream)
[ ] Demo incident shortlist verified for BOTH Sentinel-1 and free AIS coverage
[ ] Demo scenes + AIS + currents + winds pre-staged via `pnpm run stage:demo`

HYGIENE
[ ] .env created from .env.example, .env confirmed in .gitignore
[ ] gitleaks pre-commit hook installed
[ ] JWT secrets generated with openssl rand -base64 48 (not typed by hand)
[ ] Every teammate has their own dev credentials — no shared personal accounts
```

---

## 11.12 Cost summary

| Scenario | Monthly cost |
|---|---|
| **MVP / hackathon** — all Tier A + B, local Mongo/Redis/MinIO | **₹0 / $0** |
| **Hosted demo** — Atlas M0, R2 free tier, Upstash free tier, Fly.io hobby | ~$0–5 |
| **Small production** — Atlas M10, R2 100 GB, Redis 1 GB, one GPU node (spot), CDN | ~$150–350 |
| **With commercial AIS** — add Spire or MarineTraffic | +$500–5,000 |

The important line is the first one. **The entire MVP, including model training on real
labelled SAR data, real AIS, real currents and real winds, costs nothing.** That is a
direct consequence of building on open government and ESA data, and it is worth stating in
the presentation.
