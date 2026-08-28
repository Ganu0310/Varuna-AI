import { Redis } from 'ioredis';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

/**
 * Shared Redis connection for BullMQ (03_ARCHITECTURE §3.6).
 *
 * `maxRetriesPerRequest: null` is required by BullMQ's blocking commands.
 * The server must run with `maxmemory-policy noeviction` — an eviction policy silently
 * drops jobs (11_API_KEYS A10). `assertNoEviction()` checks this at boot rather than
 * letting it surface as mysteriously vanishing work.
 */
let connection: Redis | null = null;

export function redisConnection(): Redis {
  connection ??= new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  return connection;
}

export async function assertNoEviction(): Promise<void> {
  try {
    const res = await redisConnection().config('GET', 'maxmemory-policy');
    const policy = Array.isArray(res) ? res[1] : undefined;
    if (policy && policy !== 'noeviction') {
      logger.error(
        { policy },
        'Redis maxmemory-policy is not "noeviction" — BullMQ jobs can be silently evicted. ' +
          'Fix the server config before relying on the queue.',
      );
    } else {
      logger.info({ policy: policy ?? 'unknown' }, 'redis eviction policy verified');
    }
  } catch (err) {
    logger.warn(
      { err },
      'could not read redis maxmemory-policy (managed hosts often block CONFIG)',
    );
  }
}

export async function closeRedis(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
