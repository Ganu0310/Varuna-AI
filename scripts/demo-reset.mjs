#!/usr/bin/env node
/**
 * `pnpm demo:reset` — clear the analysis state produced by `pnpm demo` so it can be re-run
 * from a clean slate, WITHOUT touching infrastructure or user accounts.
 *
 * Removes:
 *   MongoDB (db `varuna`): satellite_scenes, spill_detections, origin_estimates,
 *     candidate_vessels, vessel_tracks, ais_positions, jobs, audit_log, provenance_records,
 *     and every `investigations` document (the demo owns this local DB).
 *   MinIO (bucket `varuna`): the `scenes/` prefix (ingested COGs).
 *
 * Keeps:
 *   users / refresh_tokens (so you stay registered), the MinIO bucket itself, all volumes,
 *   all containers, MLflow, TiTiler.
 *
 * Requires the stack to be up. Pass `--yes` to skip the confirmation prompt.
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const COLLECTIONS = [
  'satellite_scenes',
  'spill_detections',
  'origin_estimates',
  'candidate_vessels',
  'vessel_tracks',
  'ais_positions',
  'jobs',
  'audit_log',
  'provenance_records',
  'investigations',
];

function dc(args, opts = {}) {
  return execFileSync('docker', ['compose', ...args], { encoding: 'utf8', ...opts });
}

async function confirm() {
  if (process.argv.includes('--yes')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) =>
    rl.question(
      'This clears all demo investigations, scenes, detections and AIS. Continue? [y/N] ',
      r,
    ),
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  if (!(await confirm())) {
    console.log('Aborted.');
    return;
  }

  console.log('\n▸ Clearing MongoDB analysis collections');
  const js = COLLECTIONS.map(
    (c) =>
      `try{db.getSiblingDB('varuna').${c}.deleteMany({});print('  ${c}: cleared')}catch(e){print('  ${c}: '+e)}`,
  ).join('');
  process.stdout.write(dc(['exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', js]));

  console.log('▸ Clearing MinIO scenes/ prefix');
  try {
    dc(
      [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        '-T',
        'createbuckets',
        '-c',
        'mc alias set l http://minio:9000 minioadmin minioadmin >/dev/null && mc rm --recursive --force l/varuna/scenes/ || true',
      ],
      { stdio: 'inherit' },
    );
  } catch {
    console.log('  (no scenes/ objects to remove)');
  }

  console.log('\n✓ Demo state reset. Run `pnpm demo` to rebuild it.\n');
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
