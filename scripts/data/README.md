# Data acquisition scripts

Reference: [10_DATASETS_and_Sources.md](../../10_DATASETS_and_Sources.md) · policy: [13_REAL_DATA_POLICY.md](../../13_REAL_DATA_POLICY.md) · tracking: [CONTEXT.md](../../CONTEXT.md) §15.5

Every artefact these scripts write gets a `.provenance.json` sidecar. Real data only.

| Script | Credential | What it does | Status |
|---|---|---|---|
| `fetch-reference.mjs` | **none** | Vendored keyless reference data (ITU MID table now; GSHHG / DEM / GEBCO clipped to the AOI once the incident is locked) | ✅ MID table done |
| `search-scenes.mjs` | **none** | Anonymous Planetary Computer STAC search — verify Sentinel-1/2 coverage for a candidate incident **without downloading** (unblocks demo-incident selection, B-004) | ✅ |
| `fetch-ais-sample.mjs` | none | *(todo)* Download ONE small AIS file (DMA daily / Marine Cadastre zone slice) to lock the parser schema | ⬜ |
| CMEMS currents | CMEMS user/pass | Python `copernicusmarine subset` — added in Phase 7 | ⬜ |
| ERA5 winds | CDS UID+key **+ licence** | Python `cdsapi` — added in Phase 7 | ⬜ |
| Sentinel-1 download | MPC (anon) / CDSE OAuth / Earthdata | Handled by the ingest job (Phase 4), not a standalone script | ⬜ |
| `stage:demo` | all of the above | `../stage-demo.ts` — pre-stage the locked incident into MinIO + Mongo (Phase 13) | 🚧 stub |

## Cannot be scripted

**MKLab/CERTH Oil Spill Detection Dataset** — request form at
`mklab.iti.gr/results/oil-spill-detection-dataset/`, manual approval (days). This is the
training-data blocker (B-003). Submit it first.

## Examples

```bash
# Does Sentinel-1 cover the Ennore/Chennai incident window?
node scripts/data/search-scenes.mjs --bbox 80.0,13.0,80.6,13.4 --from 2017-01-25 --to 2017-02-05

# A Danish-waters window (free 1-min-equivalent AIS via DMA):
node scripts/data/search-scenes.mjs --bbox 10.5,54.5,13.0,56.0 --from 2023-08-10 --to 2023-08-20

# Re-fetch + re-checksum the MID table
node scripts/data/fetch-reference.mjs mid-table
```
