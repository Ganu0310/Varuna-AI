import { logger } from '../lib/logger.js';
import { ProviderUnavailable, QuotaExhausted } from '../errors.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { quotaTracker } from './quota.js';

/**
 * Base for every external data provider — 06_BACKEND §6.5, 02_TRD TR-8.
 *
 * Every provider call goes through `request()`, which gives it: quota accounting, retry
 * with exponential backoff, a circuit breaker, latency sampling, and structured logging
 * that never carries a credential (11_API_KEYS KEY-3/KEY-5).
 *
 * The critical distinction (06_BACKEND §6.5.1): a TRANSPORT failure makes the provider
 * unavailable and advances the chain, whereas a provider legitimately returning zero
 * results is a REAL ANSWER and must not advance it. Confusing the two is how a system ends
 * up presenting one provider's data as another's, or hiding a true empty result.
 */
export interface ProviderCallOptions {
  /** Quota bucket, e.g. 'CDSE:catalogue'. Omit for untracked calls. */
  quotaKey?: string;
  cost?: number;
  retries?: number;
  timeoutMs?: number;
}

export interface ProviderHealth {
  provider: string;
  circuit: ReturnType<CircuitBreaker['snapshot']>;
  calls: number;
  failures: number;
  p95LatencyMs: number | null;
  configured: boolean;
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly provider: string,
    readonly body: string,
  ) {
    super(`${provider} responded ${status}`);
    this.name = 'ProviderHttpError';
  }

  get transient(): boolean {
    return TRANSIENT_STATUS.has(this.status);
  }
}

export abstract class ProviderClient {
  abstract readonly name: string;

  /** False when the credentials this provider needs are absent from the environment. */
  abstract isConfigured(): boolean;

  protected readonly breaker = new CircuitBreaker(5, 60_000);
  private latencies: number[] = [];
  private calls = 0;
  private failures = 0;

  /**
   * Run a provider call with the full protection stack. `fn` should throw
   * `ProviderHttpError` (or any error) on transport failure and RESOLVE — possibly with an
   * empty result — when the provider answered.
   */
  protected async request<T>(fn: () => Promise<T>, opts: ProviderCallOptions = {}): Promise<T> {
    if (!this.isConfigured()) {
      throw new ProviderUnavailable(
        this.name,
        'NOT_CONFIGURED',
        undefined,
        `${this.name} has no credentials configured.`,
      );
    }

    if (this.breaker.isOpen()) {
      throw new ProviderUnavailable(
        this.name,
        'CIRCUIT_OPEN',
        this.breaker.retryAt() ?? undefined,
        `${this.name} is in a circuit-open state after repeated failures.`,
      );
    }

    if (opts.quotaKey) {
      try {
        await quotaTracker.consume(opts.quotaKey, opts.cost ?? 1);
      } catch (err) {
        if (err instanceof QuotaExhausted) {
          throw new ProviderUnavailable(
            this.name,
            'QUOTA_EXHAUSTED',
            err.resetAt ? String(err.resetAt) : undefined,
            `${this.name} quota exhausted (${err.used}/${err.limit}).`,
          );
        }
        throw err;
      }
    }

    const retries = opts.retries ?? 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const started = Date.now();
      try {
        const result = await fn();
        this.recordLatency(Date.now() - started);
        this.calls += 1;
        this.breaker.recordSuccess();
        return result;
      } catch (err) {
        lastError = err;
        const isTransient = err instanceof ProviderHttpError ? err.transient : isNetworkError(err);

        if (!isTransient || attempt === retries) break;

        // Exponential backoff, factor 2 from 1 s (06_BACKEND §6.5).
        const delay = 1000 * Math.pow(2, attempt);
        logger.warn(
          { provider: this.name, attempt: attempt + 1, delay, reason: describe(err) },
          'provider call failed, retrying',
        );
        await sleep(delay);
      }
    }

    this.calls += 1;
    this.failures += 1;
    this.breaker.recordFailure();
    logger.error({ provider: this.name, reason: describe(lastError) }, 'provider call failed');

    throw new ProviderUnavailable(
      this.name,
      lastError instanceof ProviderHttpError ? `HTTP_${lastError.status}` : 'TRANSPORT_ERROR',
      this.breaker.retryAt() ?? undefined,
      describe(lastError),
    );
  }

  /** `fetch` with a timeout, returning the parsed JSON or throwing `ProviderHttpError`. */
  protected async fetchJson<T>(
    url: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ProviderHttpError(res.status, this.name, body.slice(0, 500));
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  health(): ProviderHealth {
    return {
      provider: this.name,
      circuit: this.breaker.snapshot(),
      calls: this.calls,
      failures: this.failures,
      p95LatencyMs: this.p95(),
      configured: this.isConfigured(),
    };
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 200) this.latencies = this.latencies.slice(-200);
  }

  private p95(): number | null {
    if (this.latencies.length === 0) return null;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null;
  }
}

function isNetworkError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'AbortError' || name === 'TypeError' || name === 'FetchError';
}

function describe(err: unknown): string {
  if (err instanceof ProviderHttpError) return `HTTP ${err.status}: ${err.body.slice(0, 200)}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
