import { rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../env.js';

/**
 * Rate limits — 02_TRD SEC-5, 06_BACKEND §6.9.
 *   global           100 req/min per IP
 *   auth              10 req/min per IP
 *   job creation      20 per hour per user
 *   catalogue search  60 per hour per user
 *
 * These are the production values and they are asserted by `rateLimits.test.ts`.
 * Integration tests drive many requests from one IP, so the limits are raised (never
 * removed) under NODE_ENV=test — the middleware still runs and still counts.
 */
export const RATE_LIMITS = {
  global: { windowMs: 60_000, limit: 100 },
  auth: { windowMs: 60_000, limit: 10 },
  jobCreation: { windowMs: 60 * 60_000, limit: 20 },
  catalogue: { windowMs: 60 * 60_000, limit: 60 },
} as const;

const TEST_MULTIPLIER = 1000;
const limitFor = (n: number) => (env.NODE_ENV === 'test' ? n * TEST_MULTIPLIER : n);

const problemJson = (title: string, detail: string) => ({
  type: 'https://varuna.dev/problems/rate-limit',
  title,
  status: 429,
  detail,
});

const byUserOrIp = (req: Request) => req.user?.id ?? req.ip ?? 'unknown';

export const globalLimiter = rateLimit({
  windowMs: RATE_LIMITS.global.windowMs,
  limit: limitFor(RATE_LIMITS.global.limit),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: problemJson('Too many requests', 'Global limit is 100 requests per minute per IP.'),
});

export const authLimiter = rateLimit({
  windowMs: RATE_LIMITS.auth.windowMs,
  limit: limitFor(RATE_LIMITS.auth.limit),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: problemJson(
    'Too many authentication attempts',
    'Authentication is limited to 10 requests per minute per IP.',
  ),
});

export const jobCreationLimiter = rateLimit({
  windowMs: RATE_LIMITS.jobCreation.windowMs,
  limit: limitFor(RATE_LIMITS.jobCreation.limit),
  keyGenerator: byUserOrIp,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: problemJson('Job quota exceeded', 'Job creation is limited to 20 per hour per user.'),
});

export const catalogueLimiter = rateLimit({
  windowMs: RATE_LIMITS.catalogue.windowMs,
  limit: limitFor(RATE_LIMITS.catalogue.limit),
  keyGenerator: byUserOrIp,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: problemJson(
    'Catalogue search quota exceeded',
    'Catalogue search is limited to 60 per hour per user.',
  ),
});
