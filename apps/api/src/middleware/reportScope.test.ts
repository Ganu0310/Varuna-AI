import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { reportScopeGuard } from './reportScope.js';
import { signReportToken, verifyReportToken } from '../modules/reports/reportToken.js';
import { verifyAccessToken, signAccessToken } from '../modules/auth/tokens.js';

/**
 * The report token is the one credential in this system that is handed to a subprocess, so
 * the tests worth writing are the ones that show it cannot be used for anything else.
 */

const INV = '6a91da2cbd22a223a1fc44a0';
const OTHER = '6a91af9a7c5ec677130573e0';

function run(req: Partial<Request>) {
  const next = vi.fn();
  reportScopeGuard()(req as Request, {} as Response, next);
  return next;
}

/** The error the guard passed to `next`, typed so assertions read straight. */
function refusal(next: ReturnType<typeof vi.fn>): { status: number; detail: string } {
  const err = next.mock.calls[0]?.[0];
  expect(err).toBeInstanceOf(Error);
  return err as { status: number; detail: string };
}

describe('reportScopeGuard', () => {
  it('does not touch a request that was authenticated normally', () => {
    const next = run({ method: 'POST', path: `/investigations/${INV}/report/generate` });
    expect(next).toHaveBeenCalledWith();
  });

  it('allows a GET on the investigation the token names', () => {
    const next = run({ method: 'GET', path: `/investigations/${INV}/summary`, reportScope: INV });
    expect(next).toHaveBeenCalledWith();
  });

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])('refuses %s', (method) => {
    const next = run({ method, path: `/investigations/${INV}/report/generate`, reportScope: INV });
    const err = refusal(next);
    expect(err.status).toBe(403);
    expect(err.detail).toContain('only issue GET');
  });

  it('refuses a read of a different investigation', () => {
    // The user this token was minted for may well have access to OTHER. The token does not.
    const next = run({ method: 'GET', path: `/investigations/${OTHER}/summary`, reportScope: INV });
    const err = refusal(next);
    expect(err.status).toBe(403);
    expect(err.detail).toContain('only read the investigation');
  });

  it('refuses a read of a route naming no investigation at all', () => {
    const next = run({ method: 'GET', path: '/admin/users', reportScope: INV });
    expect(refusal(next).status).toBe(403);
  });
});

describe('report tokens are not session tokens', () => {
  it('round-trips the investigation it is scoped to', async () => {
    const token = await signReportToken({ sub: 'user-1', investigationId: INV });
    await expect(verifyReportToken(token)).resolves.toEqual({
      sub: 'user-1',
      investigationId: INV,
    });
  });

  it('is rejected by the access-token verifier', async () => {
    // Different audience. Presenting a report token as a session cookie must fail closed,
    // whatever else goes wrong upstream.
    const token = await signReportToken({ sub: 'user-1', investigationId: INV });
    await expect(verifyAccessToken(token)).resolves.toBeNull();
  });

  it('does not accept an access token in its place', async () => {
    const token = await signAccessToken({ sub: 'user-1', email: 'a@b.c', role: 'admin' });
    await expect(verifyReportToken(token)).resolves.toBeNull();
  });

  it('expires in well under two minutes', async () => {
    const token = await signReportToken({ sub: 'user-1', investigationId: INV });
    const [, body] = token.split('.');
    const { exp, iat } = JSON.parse(Buffer.from(body!, 'base64url').toString()) as {
      exp: number;
      iat: number;
    };
    expect(exp - iat).toBeLessThanOrEqual(120);
  });
});
