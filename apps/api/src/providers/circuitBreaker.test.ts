import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from './circuitBreaker.js';

describe('CircuitBreaker — 06_BACKEND §6.5', () => {
  it('starts closed and stays closed below the threshold', () => {
    const b = new CircuitBreaker(5, 60_000);
    expect(b.state()).toBe('CLOSED');
    for (let i = 0; i < 4; i++) b.recordFailure();
    expect(b.state()).toBe('CLOSED');
    expect(b.isOpen()).toBe(false);
  });

  it('opens on the 5th consecutive failure', () => {
    const b = new CircuitBreaker(5, 60_000);
    for (let i = 0; i < 5; i++) b.recordFailure();
    expect(b.state()).toBe('OPEN');
    expect(b.isOpen()).toBe(true);
    expect(b.retryAt()).toBeTruthy();
  });

  it('a success resets the failure count, so failures must be CONSECUTIVE', () => {
    const b = new CircuitBreaker(5, 60_000);
    for (let i = 0; i < 4; i++) b.recordFailure();
    b.recordSuccess();
    for (let i = 0; i < 4; i++) b.recordFailure();
    expect(b.state()).toBe('CLOSED');
  });

  it('half-opens after the reset window and admits exactly one probe', () => {
    const t0 = 1_000_000;
    const b = new CircuitBreaker(2, 60_000);
    b.recordFailure(t0);
    b.recordFailure(t0);
    expect(b.state(t0)).toBe('OPEN');

    const later = t0 + 60_001;
    expect(b.state(later)).toBe('HALF_OPEN');
    expect(b.isOpen(later)).toBe(false); // first caller becomes the probe
    expect(b.isOpen(later)).toBe(true); // a second concurrent caller is held back
  });

  it('a successful probe closes the breaker; a failed probe re-opens it', () => {
    const t0 = 2_000_000;
    const b = new CircuitBreaker(2, 60_000);
    b.recordFailure(t0);
    b.recordFailure(t0);

    const later = t0 + 60_001;
    b.isOpen(later);
    b.recordSuccess(later);
    expect(b.state(later)).toBe('CLOSED');

    b.recordFailure(later);
    b.recordFailure(later);
    expect(b.state(later)).toBe('OPEN');
  });

  it('snapshot exposes the state the admin panel reports', () => {
    const b = new CircuitBreaker(1, 60_000);
    b.recordSuccess();
    const ok = b.snapshot();
    expect(ok.state).toBe('CLOSED');
    expect(ok.lastSuccessAt).toBeTruthy();

    b.recordFailure();
    const bad = b.snapshot();
    expect(bad.state).toBe('OPEN');
    expect(bad.consecutiveFailures).toBe(1);
    expect(bad.retryAt).toBeTruthy();
  });
});
