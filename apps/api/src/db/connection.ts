import mongoose from 'mongoose';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

/**
 * Lazy MongoDB connection. Importing this module does NOT connect — call `connectMongo()`
 * from the bootstrap so unit tests that only exercise schema validation never need a live
 * database (Mongoose runs validators and `pre('validate')` middleware without a connection).
 */
let conn: Promise<typeof mongoose> | null = null;

export function connectMongo(): Promise<typeof mongoose> {
  if (conn) return conn;
  mongoose.set('strictQuery', true);
  // NOTE: `sanitizeFilter` is deliberately NOT enabled. It rewrites any `$`-prefixed value
  // as `$eq`, which breaks the server's own legitimate operators ($in, $gte, $geoWithin…).
  // Injection is prevented where the spec puts it (02_TRD SEC-8, 06_BACKEND §6.9): the
  // `sanitizeMongo` middleware strips `$`/dotted keys from user INPUT, Zod validates every
  // boundary, and no user string is ever spread into a query object.
  conn = mongoose
    .connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME })
    .then((m) => {
      logger.info({ db: env.MONGODB_DB_NAME }, 'mongo connected');
      return m;
    })
    .catch((err) => {
      conn = null;
      logger.error({ err }, 'mongo connection failed');
      throw err;
    });
  return conn;
}

export async function disconnectMongo(): Promise<void> {
  if (conn) {
    await mongoose.disconnect();
    conn = null;
  }
}

export { mongoose };
