/**
 * `pnpm run stage:demo` — download the demo incident's REAL scene(s), REAL AIS slice, REAL
 * CMEMS currents and REAL ERA5 winds into MinIO + MongoDB, once, so a live demo does not
 * depend on provider uptime / quota (03_ARCHITECTURE §3.9, 13_REAL_DATA_POLICY §13.10).
 *
 * This is CACHING real data, not fabricating it: provenance records are the originals and
 * checksums match. The pipeline still runs for real during the demo — only inputs are
 * pre-staged, results are NOT pre-computed.
 *
 * Implemented in Phase 13 once the demo incident is locked (CONTEXT.md §15.6) and the
 * ingest / ais-import / drift jobs exist (Phases 4, 7, 8).
 */
async function main(): Promise<void> {
  console.error(
    'stage:demo is not implemented yet.\n' +
      '  Blocked on: demo incident selection (CONTEXT.md §15.6) and Phases 4/7/8.\n' +
      '  See IMPLEMENTATION_PLAN.md §14.6 Phase 13.',
  );
  process.exit(1);
}

void main();
