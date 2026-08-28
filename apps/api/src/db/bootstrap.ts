import mongoose from 'mongoose';
import { logger } from '../lib/logger.js';
import * as models from './models.js';

/**
 * One-time database bootstrap: create the `ais_positions` time-series collection and ensure
 * every model's indexes exist. Idempotent — safe to run on every boot.
 *
 * `ais_positions` MUST be a time-series collection with metaField `meta` (containing `mmsi`),
 * because every query is "this vessel, this time range" or "this box, this time range"
 * (02_TRD §2.5.2, 07_AIML F-08). Mongoose cannot create timeseries collections, so we use
 * the native driver.
 */
export async function bootstrapDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('bootstrapDatabase called before a mongo connection was established');

  const existing = (await db.listCollections({ name: 'ais_positions' }).toArray()) as Array<{
    name: string;
    options?: { timeseries?: unknown };
  }>;
  if (existing.length === 0) {
    await db.createCollection('ais_positions', {
      timeseries: { timeField: 't', metaField: 'meta', granularity: 'seconds' },
    });
    logger.info('created time-series collection ais_positions');
  } else {
    if (!existing[0]?.options?.timeseries) {
      throw new Error(
        'ais_positions exists but is NOT a time-series collection — drop it and re-run bootstrap',
      );
    }
  }

  const aisPositions = db.collection('ais_positions');
  await aisPositions.createIndex({ 'meta.mmsi': 1, t: 1 });
  await aisPositions.createIndex({ position: '2dsphere' });
  await aisPositions.createIndex({ t: 1 });

  // Ensure indexes for every registered model.
  await Promise.all(
    Object.values(models).map((m) =>
      (m as unknown as { createIndexes: () => Promise<unknown> }).createIndexes(),
    ),
  );

  logger.info({ models: Object.keys(models) }, 'database bootstrap complete');
}

/** Verify `ais_positions` is a time-series collection — used by the health/deep check. */
export async function verifyAisTimeSeries(): Promise<boolean> {
  const db = mongoose.connection.db;
  if (!db) return false;
  const info = (await db.listCollections({ name: 'ais_positions' }).toArray()) as Array<{
    options?: { timeseries?: unknown };
  }>;
  return Boolean(info[0]?.options?.timeseries);
}
