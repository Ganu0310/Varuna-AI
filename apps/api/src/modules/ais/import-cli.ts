/**
 * `pnpm --filter @varuna/api ais:import -- --file <csv> --from <iso> --to <iso> --bbox w,s,e,n`
 *
 * Imports a real AIS archive slice into the `ais_positions` time-series collection with a
 * provenance record. Idempotent enough to re-run: duplicates within the run are filtered,
 * and re-importing the same window simply re-inserts the same rows under the same batch id.
 */
import { logger } from '../../lib/logger.js';
import { connectMongo, disconnectMongo } from '../../db/connection.js';
import { bootstrapDatabase } from '../../db/bootstrap.js';
import { importAisCsv } from './import.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > -1 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const filePath = arg('file');
  const from = arg('from');
  const to = arg('to');
  const bbox = arg('bbox').split(',').map(Number) as [number, number, number, number];

  await connectMongo();
  await bootstrapDatabase();

  const started = Date.now();
  const res = await importAisCsv({ filePath, from, to, bbox });
  const seconds = (Date.now() - started) / 1000;

  logger.info(
    { ...res, seconds: Math.round(seconds) },
    `AIS import complete: ${res.imported.toLocaleString()} positions, ${res.distinctMmsi} vessels`,
  );

  console.log(`
  read                ${res.read.toLocaleString()}
  imported            ${res.imported.toLocaleString()}
  distinct MMSI       ${res.distinctMmsi}
  out of window       ${res.skippedOutOfWindow.toLocaleString()}
  out of bbox         ${res.skippedOutOfBbox.toLocaleString()}
  unparseable         ${res.skippedUnparseable.toLocaleString()}
  duplicates dropped  ${res.duplicates.toLocaleString()}
  sentinel SOG->null  ${res.flagged.sentinelSog.toLocaleString()}
  sentinel COG->null  ${res.flagged.sentinelCog.toLocaleString()}
  sentinel HDG->null  ${res.flagged.sentinelHeading.toLocaleString()}
  MMSI_INVALID        ${res.flagged.mmsiInvalid.toLocaleString()}
  provenance          ${res.provenanceId}
  batch               ${res.batchId}
  elapsed             ${seconds.toFixed(1)}s
`);

  await disconnectMongo();
}

main().catch(async (err) => {
  logger.error({ err }, 'AIS import failed');
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
