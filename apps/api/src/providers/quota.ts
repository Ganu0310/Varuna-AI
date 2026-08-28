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

export interface QuotaSnapshot {
  quotaKey: string;
  used: number;
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
    const used = await redis.incrby(key, cost);
    // NX so the TTL is set once per window, not pushed forward on every call.
    await redis.expire(key, cfg.periodSeconds, 'NX');

    if (used > cfg.limit) {
      await redis.decrby(key, cost);
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
    const raw = await redisConnection().get(key);
    return {
      quotaKey,
      used: raw ? Number(raw) : 0,
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
