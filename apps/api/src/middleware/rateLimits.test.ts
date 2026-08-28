import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import { RATE_LIMITS } from './rateLimits.js';

/**
 * The production limits are a security control (02_TRD SEC-5) and must not drift.
 * Integration tests raise these values so a suite driving many requests from one IP is not
 * throttled; this file pins the real numbers and proves the mechanism still returns 429.
 */
describe('rate limit configuration', () => {
  it('matches 02_TRD SEC-5 / 06_BACKEND §6.9', () => {
    expect(RATE_LIMITS.global).toEqual({ windowMs: 60_000, limit: 100 });
    expect(RATE_LIMITS.auth).toEqual({ windowMs: 60_000, limit: 10 });
    expect(RATE_LIMITS.jobCreation).toEqual({ windowMs: 3_600_000, limit: 20 });
    expect(RATE_LIMITS.catalogue).toEqual({ windowMs: 3_600_000, limit: 60 });
  });

  it('returns 429 with problem+json once the limit is exceeded', async () => {
    const app = express();
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 2,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: {
          type: 'https://varuna.dev/problems/rate-limit',
          title: 'Too many requests',
          status: 429,
        },
      }),
    );
    app.get('/x', (_req, res) => res.json({ ok: true }));

    expect((await request(app).get('/x')).status).toBe(200);
    expect((await request(app).get('/x')).status).toBe(200);
    const blocked = await request(app).get('/x');
    expect(blocked.status).toBe(429);
    expect(blocked.body.title).toBe('Too many requests');
  });
});
