/**
 * Database CLI — `pnpm --filter @varuna/api db:bootstrap`.
 *
 * Connects, runs the idempotent bootstrap (creates the `ais_positions` time-series
 * collection and every model's indexes), prints what exists, then exits.
 * Safe to re-run (02_TRD §2.5.2, IMPLEMENTATION_PLAN Phase 1).
 */
import mongoose from 'mongoose';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { connectMongo, disconnectMongo } from './connection.js';
import { bootstrapDatabase, verifyAisTimeSeries } from './bootstrap.js';

async function main(): Promise<void> {
  await connectMongo();

  const admin = mongoose.connection.db!.admin();
  const build = (await admin.command({ buildInfo: 1 })) as { version: string };
  const hello = (await admin.command({ hello: 1 })) as { setName?: string };
  logger.info(
    {
      db: env.MONGODB_DB_NAME,
      serverVersion: build.version,
      topology: hello.setName ? `replicaSet:${hello.setName}` : 'standalone',
      transactions: hello.setName ? 'available' : 'UNAVAILABLE (standalone)',
    },
    'connected',
  );

  await bootstrapDatabase();

  const timeseriesOk = await verifyAisTimeSeries();
  const collections = await mongoose.connection.db!.listCollections().toArray();
  const aisIndexes = await mongoose.connection.db!.collection('ais_positions').indexes();

  logger.info(
    {
      aisPositionsIsTimeSeries: timeseriesOk,
      aisPositionsIndexes: aisIndexes.map((i) => i.name),
      collections: collections.map((c) => c.name).sort(),
    },
    'bootstrap verified',
  );

  if (!timeseriesOk) {
    logger.error('ais_positions is NOT a time-series collection — refusing to report success');
    process.exitCode = 1;
  }

  await disconnectMongo();
}

main().catch(async (err) => {
  logger.error({ err }, 'db bootstrap failed');
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
