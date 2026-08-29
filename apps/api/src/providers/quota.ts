import { logger } from '../lib/logger.js';
import { redisConnection } from '../queue/connection.js';
import { QuotaExhausted } from '../errors.js';

/**
 * Provider quota accounting — 11_API_KEYS §11.8.
 *
 * We track consumption ourselves rather than relying on provider 429s, because discovering
 * a quota ceiling mid-demonstration is a failure mode we can design out. Counters live in
 * Redis so they are shared across API replicas.
 *
 * Soft limits are deliberately below each provider's real fair-use ceiling.
 */
export interface QuotaLimit {
  limit: number;
  periodSeconds: number;
  period: 'hour' | 'day';
}

export const QUOTA_LIMITS: Record<string, QuotaLimit> = {
  'CDSE:catalogue': { limit: 500, periodSeconds: 3600, period: 'hour' },
  'CDSE:download': { limit: 40, periodSeconds: 86_400, period: 'day' },
  'PLANETARY_COMPUTER:catalogue': { limit: 1000, periodSeconds: 3600, period: 'hour' },
  'ASF:download': { limit: 30, periodSeconds: 86_400, period: 'day' },
  'CMEMS:subset': { limit: 100, periodSeconds: 86_400, period: 'day' },
  'ERA5:request': { limit: 50, periodSeconds: 86_400, period: 'day' },
  'GFW:api': { limit: 200, periodSeconds: 3600, period: 'hour' },
};

function periodKey(periodSeconds: number, now = Date.now()): string {
  return String(Math.floor(now / 1000 / periodSeconds));
}

/**
 * Redis is shared with BullMQ, which requires `maxRetriesPerRequest: null` for its blocking
 * commands. That setting makes ioredis queue a command INDEFINITELY while the server is
 * unreachable — it never rejects. Quota accounting therefore has to impose its own deadline,
 * or a Redis outage silently becomes an infinite hang on every provider call rather than an
 * error anyone can see.
 */
export const QUOTA_REDIS_DEADLINE_MS = 750;

/**
 * An explicit result rather than a sentinel value. `null` would collide with a legitimate
 * Redis GET miss, and a symbol forces narrowing gymnastics at every call site; `reachable`
 * makes "we could not ask" impossible to confuse with "the answer was zero".
 */
type RedisResult<T> = { reachable: true; value: T } | { reachable: false };

async function withDeadline<T>(op: Promise<T>, ms: number): Promise<RedisResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      op.then((value) => ({ reachable: true as const, value })),
      new Promise<{ reachable: false }>((resolve) => {
        timer = setTimeout(() => resolve({ reachable: false }), ms);
        // Do not hold the process open for a timer that only guards a failure path.
        timer.unref?.();
      }),
    ]);
  } catch {
    // A rejected command is the same situation as a hung one: no usable count.
    return { reachable: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface QuotaSnapshot {
  quotaKey: string;
  /** `null` when the counter could not be read — distinct from a genuine zero. */
  used: number | null;
  limit: number | null;
  period: string | null;
  resetAt: string | null;
}

export class QuotaTracker {
  /**
   * Consume `cost` units. Throws `QuotaExhausted` at the ceiling — which the chain treats
   * as provider-unavailable and advances past, rather than returning a wrong answer.
   */
  async consume(quotaKey: string, cost = 1): Promise<void> {
    const cfg = QUOTA_LIMITS[quotaKey];
    if (!cfg) return; // untracked provider action

    const key = `quota:${quotaKey}:${periodKey(cfg.periodSeconds)}`;
    const redis = redisConnection();

    const counted = await withDeadline(redis.incrby(key, cost), QUOTA_REDIS_DEADLINE_MS);

    // FAIL OPEN, loudly. If the counter is unreachable we allow the call rather than blocking
    // it: a Redis outage should degrade quota ACCOUNTING, not take provider search down with
    // it. The cost is real and is stated here rather than hidden — while Redis is unavailable
    // we can exceed a provider's fair-use ceiling, because we genuinely do not know the count.
    // That is the lesser harm against hanging or refusing every request, but it is a harm, so
    // it is logged at error level rather than swallowed.
    if (!counted.reachable) {
      logger.error(
        { provider: quotaKey, deadlineMs: QUOTA_REDIS_DEADLINE_MS },
        'quota counter unreachable — allowing the call WITHOUT accounting. Provider fair-use ' +
          'ceilings are not being enforced until Redis recovers.',
      );
      return;
    }

    const used = counted.value;

    // NX so the TTL is set once per window, not pushed forward on every call. Best-effort:
    // the counter already incremented, and a missing TTL self-corrects next window.
    await withDeadline(redis.expire(key, cfg.periodSeconds, 'NX'), QUOTA_REDIS_DEADLINE_MS);

    if (used > cfg.limit) {
      await withDeadline(redis.decrby(key, cost), QUOTA_REDIS_DEADLINE_MS);
      throw new QuotaExhausted(quotaKey, used, cfg.limit, this.resetAt(cfg));
    }
    if (used > cfg.limit * 0.8) {
      logger.warn(
        { provider: quotaKey, used, limit: cfg.limit, pct: Math.round((100 * used) / cfg.limit) },
        'provider quota above 80%',
      );
    }
  }

  async snapshot(quotaKey: string): Promise<QuotaSnapshot> {
    const cfg = QUOTA_LIMITS[quotaKey];
    if (!cfg) return { quotaKey, used: 0, limit: null, period: null, resetAt: null };
    const key = `quota:${quotaKey}:${periodKey(cfg.periodSeconds)}`;
    const raw = await withDeadline(redisConnection().get(key), QUOTA_REDIS_DEADLINE_MS);

    // `used: null` rather than 0 when the counter cannot be read. Reporting 0 would render on
    // the admin quota screen as "nothing consumed", which is a specific false statement about
    // provider usage rather than an admission that we do not currently know.
    if (!raw.reachable) {
      return {
        quotaKey,
        used: null,
        limit: cfg.limit,
        period: cfg.period,
        resetAt: this.resetAt(cfg),
      };
    }

    return {
      quotaKey,
      used: raw.value ? Number(raw.value) : 0,
      limit: cfg.limit,
      period: cfg.period,
      resetAt: this.resetAt(cfg),
    };
  }

  async snapshotAll(): Promise<QuotaSnapshot[]> {
    return Promise.all(Object.keys(QUOTA_LIMITS).map((k) => this.snapshot(k)));
  }

  private resetAt(cfg: QuotaLimit): string {
    const current = Math.floor(Date.now() / 1000 / cfg.periodSeconds);
    return new Date((current + 1) * cfg.periodSeconds * 1000).toISOString();
  }
}

export const quotaTracker = new QuotaTracker();
