import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Quota accounting when Redis is unreachable.
 *
 * This was found by running the unit suite with Docker stopped: six provider tests hung and
 * timed out. `vitest.config.ts` states that the unit suite must stay runnable with no services
 * up, and it was not.
 *
 * The cause was worse than a test-only annoyance. The quota tracker shares BullMQ's Redis
 * connection, which sets `maxRetriesPerRequest: null` because BullMQ's blocking commands
 * require it. With that setting ioredis queues a command FOREVER while the server is down — it
 * never rejects — so in production a Redis outage would have hung every provider call
 * indefinitely instead of surfacing an error.
 */

const incrby = vi.fn();
const expire = vi.fn();
const decrby = vi.fn();
const get = vi.fn();

vi.mock('../queue/connection.js', () => ({
  redisConnection: () => ({ incrby, expire, decrby, get }),
}));

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
vi.mock('../lib/logger.js', () => ({ logger }));

/** A promise that never settles — exactly what ioredis gives us with retries disabled. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  expire.mockResolvedValue(1);
  decrby.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('quota accounting with Redis unreachable', () => {
  it('does not hang when the counter command never settles', async () => {
    const { quotaTracker, QUOTA_REDIS_DEADLINE_MS } = await import('./quota.js');
    incrby.mockReturnValue(neverSettles<number>());

    const started = Date.now();
    await quotaTracker.consume('PLANETARY_COMPUTER:catalogue');
    const elapsed = Date.now() - started;

    // The whole point: it returns. Generous upper bound so the assertion is about not
    // hanging, not about scheduler precision.
    expect(elapsed).toBeLessThan(QUOTA_REDIS_DEADLINE_MS + 2000);
  });

  it('fails OPEN — the provider call proceeds rather than being blocked', async () => {
    const { quotaTracker } = await import('./quota.js');
    incrby.mockReturnValue(neverSettles<number>());

    // Resolving rather than throwing is the contract: a Redis outage degrades accounting,
    // it does not take provider search down with it.
    await expect(quotaTracker.consume('CDSE:catalogue')).resolves.toBeUndefined();
  });

  it('logs at ERROR that ceilings are unenforced, rather than failing silently', async () => {
    const { quotaTracker } = await import('./quota.js');
    incrby.mockReturnValue(neverSettles<number>());

    await quotaTracker.consume('CDSE:catalogue');

    // Failing open is only acceptable if it is visible. Silently allowing unlimited provider
    // calls is how a fair-use ban happens with nothing in the logs to explain it.
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [, message] = logger.error.mock.calls[0]!;
    expect(String(message)).toMatch(/not being enforced|without accounting/i);
  });

  it('treats a rejected command the same as a hung one', async () => {
    const { quotaTracker } = await import('./quota.js');
    incrby.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(quotaTracker.consume('CDSE:catalogue')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('reports used as null, not 0, when the counter cannot be read', async () => {
    const { quotaTracker } = await import('./quota.js');
    get.mockReturnValue(neverSettles<string>());

    const snap = await quotaTracker.snapshot('CDSE:catalogue');

    // 0 would render on the admin screen as "nothing consumed" — a specific false claim about
    // provider usage. `null` says we do not currently know, which is the true statement.
    expect(snap.used).toBeNull();
    expect(snap.limit).toBe(500);
  });
});

describe('quota accounting with Redis healthy', () => {
  it('still enforces the ceiling', async () => {
    const { quotaTracker } = await import('./quota.js');
    // One over the CDSE catalogue limit of 500.
    incrby.mockResolvedValue(501);

    await expect(quotaTracker.consume('CDSE:catalogue')).rejects.toThrow(/quota/i);
    // The over-count is rolled back so a later window is not poisoned by the rejected call.
    // `stringMatching`, not concatenation — `'prefix' + expect.anything()` stringifies the
    // matcher into the literal text "Anything" and compares against that.
    expect(decrby).toHaveBeenCalledWith(expect.stringMatching(/^quota:CDSE:catalogue:\d+$/), 1);
  });

  it('allows a call below the ceiling and records it', async () => {
    const { quotaTracker } = await import('./quota.js');
    incrby.mockResolvedValue(12);

    await expect(quotaTracker.consume('CDSE:catalogue')).resolves.toBeUndefined();
    expect(incrby).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reads back a real count', async () => {
    const { quotaTracker } = await import('./quota.js');
    get.mockResolvedValue('37');

    const snap = await quotaTracker.snapshot('CDSE:catalogue');
    expect(snap.used).toBe(37);
  });
});
