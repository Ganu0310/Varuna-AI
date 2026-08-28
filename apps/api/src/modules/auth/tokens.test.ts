import { describe, it, expect } from 'vitest';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
} from './tokens.js';

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const token = await signAccessToken({ sub: 'u1', email: 'a@b.co', role: 'analyst' });
    const claims = await verifyAccessToken(token);
    expect(claims).toEqual({ sub: 'u1', email: 'a@b.co', role: 'analyst' });
  });

  it('rejects a tampered token', async () => {
    const token = await signAccessToken({ sub: 'u1', email: 'a@b.co', role: 'viewer' });
    const parts = token.split('.');
    // Swap the payload for one claiming admin, keeping the original signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'u1', email: 'a@b.co', role: 'admin' }),
    ).toString('base64url');
    const forged = `${parts[0]}.${forgedPayload}.${parts[2]}`;
    expect(await verifyAccessToken(forged)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifyAccessToken('not-a-jwt')).toBeNull();
    expect(await verifyAccessToken('')).toBeNull();
  });

  it('uses the TTLs from 02_TRD SEC-2 (15 min access, 7 day refresh)', () => {
    expect(ACCESS_TTL_SECONDS).toBe(15 * 60);
    expect(REFRESH_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe('refresh tokens', () => {
  it('are opaque high-entropy values, not JWTs', () => {
    const { token } = generateRefreshToken();
    expect(token).not.toContain('.');
    // 32 random bytes as base64url
    expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it('are unique per call', () => {
    const a = generateRefreshToken().token;
    const b = generateRefreshToken().token;
    expect(a).not.toBe(b);
  });

  it('hash deterministically, and the hash is not the token', () => {
    const { token, hash } = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hash);
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
