# Demo AIS slice — SYNTHETIC, not real data

`guam-2025-09-21.demo.csv` is **deterministically generated synthetic AIS** produced by
[`scripts/data/make-demo-ais.mjs`](../../../scripts/data/make-demo-ais.mjs).

It exists so the `ingest → detect → back-track → AIS correlation → candidate ranking →
report` pipeline can run end-to-end on a machine that has neither a NOAA Marine Cadastre
bulk download nor a live-AIS credential.

- It is **not** a real AIS archive and must never be cited as one.
- Imported with `pnpm --filter @varuna/api ais:import -- --demo …`, which records the
  provenance provider as `VARUNA synthetic demo AIS` (licence: *"Synthetic demo data — not a
  real AIS archive"*), never as NOAA.
- The correlation and candidate ranking still run **live** against this input. No score,
  tier, or ranking in the result is pre-computed or hard-coded.

Regenerate with:

```bash
node scripts/data/make-demo-ais.mjs
```

For a real run, download the Guam 2025 slice from <https://marinecadastre.gov/accessais/>
and import it without `--demo`.
