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
  mongoose.set('sanitizeFilter', true); // defence-in-depth against operator injection
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
