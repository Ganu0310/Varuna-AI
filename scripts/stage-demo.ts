/**
 * `pnpm run stage:demo` — pre-stage the demo incident's REAL inputs.
 *
 * 03_ARCHITECTURE §3.9, 13_REAL_DATA_POLICY §13.10.
 *
 * This CACHES real data; it does not fabricate or pre-compute anything. The distinction is
 * the whole point:
 *
 *   STAGED   the Sentinel-1 scene window, the AIS slice — fetched once from the real
 *            providers, with their original provenance records and checksums.
 *   NOT      detections, origin estimates, candidate rankings. Those still run live during
 *            the demo, against the staged inputs.
 *
 * So a demo cannot be derailed by a provider outage or a quota ceiling, and equally cannot
 * show a result that was prepared in advance. If the pipeline would fail on the day, it
 * fails in front of the audience — which is the honest arrangement.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const INCIDENT = {
  name: 'Guam — 2025-09-21 S1C descending',
  reference: 'VARUNA-DEMO-01',
  productId: 'S1C_IW_GRDH_1SDV_20250921T200737_20250921T200800_004227_008638_rtc',
  collection: 'sentinel-1-rtc',
  acquiredAt: '2025-09-21T20:07:48Z',
  /** [west, south, east, north] */
  aoi: [144.55, 13.3, 144.95, 13.6] as [number, number, number, number],
  aisBbox: [144.4, 13.2, 145.1, 13.8] as [number, number, number, number],
  aisFrom: '2025-09-21T08:00:00Z',
  aisTo: '2025-09-22T08:00:00Z',
  aisFile: 'DATASET DOW/AIS VESSEL DATA/guam_2025.csv',
};

function run(label: string, cmd: string, args: string[]): boolean {
  console.log(`\n▸ ${label}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`  ✗ ${label} failed (exit ${r.status})`);
    return false;
  }
  console.log(`  ✓ ${label}`);
  return true;
}

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
  VARUNA — staging the demo incident
╚══════════════════════════════════════════════════════════════════════════════╝

  Incident   ${INCIDENT.name}
  Reference  ${INCIDENT.reference}
  Scene      ${INCIDENT.productId}
  Acquired   ${INCIDENT.acquiredAt}
  AOI        [${INCIDENT.aoi.join(', ')}]

  Caching REAL inputs only. Detections, origin estimates and candidate rankings
  are NOT pre-computed — they run live during the demo against these inputs.
`);

  const failures: string[] = [];

  // ── 1 · the satellite scene window ────────────────────────────────
  // Pulls the AOI window from Planetary Computer and writes COGs to MinIO with the
  // provider's own provenance record.
  const ingestOk = run('Sentinel-1 RTC scene window → object storage', 'pnpm', [
    '--filter',
    '@varuna/api',
    'exec',
    'tsx',
    'src/modules/scenes/stage-scene.ts',
    '--product',
    INCIDENT.productId,
    '--aoi',
    INCIDENT.aoi.join(','),
    '--collection',
    INCIDENT.collection,
  ]);
  if (!ingestOk) failures.push('scene');

  // ── 2 · the AIS slice ─────────────────────────────────────────────
  const aisPath = resolve(process.cwd(), INCIDENT.aisFile);
  if (!existsSync(aisPath)) {
    console.error(`\n  ✗ AIS archive not found at ${aisPath}`);
    console.error(
      '    Download the Guam 2025 slice from https://marinecadastre.gov/accessais/ ' +
        '(no credential required).',
    );
    failures.push('ais');
  } else {
    const aisOk = run('NOAA Marine Cadastre AIS slice → ais_positions', 'pnpm', [
      '--filter',
      '@varuna/api',
      'ais:import',
      '--',
      '--file',
      `"${aisPath}"`,
      '--from',
      INCIDENT.aisFrom,
      '--to',
      INCIDENT.aisTo,
      '--bbox',
      INCIDENT.aisBbox.join(','),
    ]);
    if (!aisOk) failures.push('ais');
  }

  // ── 3 · forcing (currents/winds) ──────────────────────────────────
  // Deliberately NOT staged, and the reason is stated rather than silently skipped: HYCOM's
  // archive ends 2024-09-05 and its operational feed covers only the last fortnight, so this
  // incident falls in a gap that needs CMEMS credentials. Drift therefore runs DEGRADED, and
  // the demo shows that honestly.
  console.log(`
▸ Ocean currents / winds
  ⚠ NOT STAGED. No keyless provider covers ${INCIDENT.acquiredAt.slice(0, 10)}:
    HYCOM's reanalysis archive ends 2024-09-05 and its operational feed starts
    roughly a fortnight ago. Configure CMEMS_USERNAME / CMEMS_PASSWORD and
    CDSAPI_KEY to enable real back-tracking. Until then the origin estimate runs
    as DEGRADED / FOOTPRINT_PROXIMITY and says so in the UI and the report.`);

  console.log(`
──────────────────────────────────────────────────────────────────────────────`);
  if (failures.length === 0) {
    console.log(`  ✓ Demo inputs staged. The pipeline still runs live from here.`);
  } else {
    console.error(`  ✗ Staging incomplete: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

void main();
