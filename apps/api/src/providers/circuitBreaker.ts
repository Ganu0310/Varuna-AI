/**
 * Circuit breaker — 06_BACKEND §6.5.
 *
 * Opens after `threshold` consecutive failures and stays open for `resetMs`, then admits a
 * single probe (half-open). A success closes it; a failure re-opens it.
 *
 * The point is not merely to fail fast: a provider that is down must advance the chain
 * rather than being retried until the request times out, so the analyst gets a real answer
 * from a fallback instead of a hang.
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;
  private lastSuccessAt: number | null = null;

  constructor(
    private readonly threshold = 5,
    private readonly resetMs = 60_000,
  ) {}

  state(now = Date.now()): BreakerState {
    if (this.openedAt === null) return 'CLOSED';
    if (now - this.openedAt >= this.resetMs) return 'HALF_OPEN';
    return 'OPEN';
  }

  /** True when the call must not be attempted. A half-open breaker admits one probe. */
  isOpen(now = Date.now()): boolean {
    const s = this.state(now);
    if (s === 'CLOSED') return false;
    if (s === 'OPEN') return true;
    if (this.probing) return true; // a probe is already in flight
    this.probing = true;
    return false;
  }

  retryAt(): string | null {
    return this.openedAt === null ? null : new Date(this.openedAt + this.resetMs).toISOString();
  }

  recordSuccess(now = Date.now()): void {
    this.failures = 0;
    this.openedAt = null;
    this.probing = false;
    this.lastSuccessAt = now;
  }

  recordFailure(now = Date.now()): void {
    this.probing = false;
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = now;
  }

  snapshot(now = Date.now()) {
    return {
      state: this.state(now),
      consecutiveFailures: this.failures,
      retryAt: this.retryAt(),
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
    };
  }
}
