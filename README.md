# VARUNA

**Vessel Attribution through Remote-sensing & Unified Navigational Analytics**
Smart India Hackathon 2026 — Problem Statement **SIH26143**
Satellite Imagery + AIS Based Oil Spill Vessel Attribution System

VARUNA ingests real satellite imagery (Sentinel-1 C-band SAR), detects and segments
oil-like slicks, back-tracks them through real wind and current fields to a probable
release zone and time window, correlates that against real AIS vessel trajectories, and
produces a ranked, fully explainable evidence dossier.

> **The non-negotiable data rule:** zero mock/fake/synthetic/placeholder data anywhere —
> product, demo, screenshots, metrics, or model training. Every data object carries a
> provenance record. See [13_REAL_DATA_POLICY.md](13_REAL_DATA_POLICY.md).

---

## Documentation

| # | Doc |
|---|---|
| 00 | [Index](00_INDEX.md) |
| 01–13 | Product, technical, architecture, UI/UX, frontend, backend, AI/ML, app flow, research, datasets, API keys, feature rationale, real-data policy |
| **14** | [**Implementation Plan**](IMPLEMENTATION_PLAN.md) — the build order |
| **15** | [**Project Context**](CONTEXT.md) — living status, updated continuously |

New here? Read `00_INDEX.md`, then `IMPLEMENTATION_PLAN.md`, then check `CONTEXT.md`.

---

## Repository layout

```
packages/shared/   Zod contracts + branded units + constants (the cross-service source of truth)
apps/api/          Express 5 API — auth, RBAC, orchestration, persistence, realtime, reports
apps/worker/       BullMQ job consumers (shares code with api)
apps/web/          React 18 + Vite + MapLibre + deck.gl + R3F workspace
services/ml/        Python 3.11 FastAPI — SAR preprocessing, segmentation, drift, scoring
scripts/           real-data policy check, demo staging, token sync
infra/             container + local-dev support files
data/              real data cached locally (git-ignored); manifests are committed
```

---

## Local development

**Prerequisites:** Node ≥ 20.11 · pnpm ≥ 9 · Python 3.11 · Docker + Docker Compose · Git

```bash
# 1. install JS deps
pnpm install

# 2. bring up datastores + support services
cp .env.example .env         # then fill in credentials — see 11_API_KEYS_and_External_Services.md
docker compose up -d mongo redis minio titiler mlflow

# 3. run the stack
pnpm --filter @varuna/api dev
pnpm --filter @varuna/worker dev
pnpm --filter @varuna/web dev
# ML service:
cd services/ml && uv sync && uv run uvicorn varuna_ml.main:app --reload --port 8000
```

A cold `docker compose up` on a clean machine must reach a working system using only the
variables in `.env.example` — this is a release criterion (01_PRD §12.7).

---

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check:real-data     # scripts/check-real-data-policy.sh — required PR status check
```

See [IMPLEMENTATION_PLAN.md §14.10](IMPLEMENTATION_PLAN.md) for the full testing strategy.
