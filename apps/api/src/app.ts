import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';

import { env } from './env.js';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { sanitizeMongo } from './middleware/sanitizeMongo.js';
import { authenticate } from './middleware/authenticate.js';
import { reportScopeGuard } from './middleware/reportScope.js';
import { globalLimiter } from './middleware/rateLimits.js';
import { provenanceGuard } from './middleware/provenanceGuard.js';
import { errorHandler } from './middleware/errorHandler.js';
import { NotFoundError } from './errors.js';
import { healthRouter } from './modules/health/router.js';
import { authRouter } from './modules/auth/router.js';
import { catalogueRouter } from './modules/catalogue/router.js';
import { investigationsRouter } from './modules/investigations/router.js';
import { scenesRouter } from './modules/scenes/router.js';
import { detectionsRouter } from './modules/detections/router.js';
import { aisRouter } from './modules/ais/router.js';
import { candidatesRouter } from './modules/candidates/router.js';
import { originRouter } from './modules/origin/router.js';
import { reportsRouter } from './modules/reports/router.js';
import { jobsRouter } from './modules/jobs/router.js';
import { adminRouter } from './modules/admin/router.js';
import { publicRouter } from './modules/public/router.js';
import { openApiDocument } from './openapi.js';

/**
 * Middleware order matters — 06_BACKEND §6.2:
 *   requestId → pino-http → helmet(CSP) → cors → json → cookieParser → mongoSanitize →
 *   rateLimit → authenticate → router (per-route rbac + validate) → provenanceGuard → errorHandler
 */
/**
 * Where each router is mounted.
 *
 * A table rather than a run of `app.use` calls because the mount path is not recoverable from
 * a mounted router afterwards — Express 5 keeps it as a matcher function, not a string. Tools
 * that need to enumerate the real API surface (`scripts/check-openapi.mjs` measures how much
 * of it the spec describes) would otherwise have to re-derive it by parsing this file, which
 * would be a second source of truth and would drift.
 *
 * Several routers are mounted twice on purpose: their routes divide into ones scoped to an
 * investigation and ones addressed globally, and they are written as a single module.
 */
export const ROUTE_MOUNTS: ReadonlyArray<readonly [string, Router]> = [
  ['/', healthRouter],
  ['/api/v1/auth', authRouter],
  ['/api/v1/catalogue', catalogueRouter],
  ['/api/v1/investigations', investigationsRouter],
  ['/api/v1/investigations', scenesRouter],
  ['/api/v1/detections', detectionsRouter],
  ['/api/v1/investigations', aisRouter],
  ['/api/v1', aisRouter],
  ['/api/v1/investigations', originRouter],
  ['/api/v1', originRouter],
  ['/api/v1/investigations', candidatesRouter],
  ['/api/v1', candidatesRouter],
  ['/api/v1/investigations', reportsRouter],
  ['/api/v1/jobs', jobsRouter],
  ['/api/v1/admin', adminRouter],
  // Unauthenticated by design; the router itself is the security boundary. See its header.
  ['/api/v1/public', publicRouter],
] as const;

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId());
  app.use(pinoHttp({ logger, genReqId: (req) => (req as { id?: string }).id ?? 'unknown' }));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          workerSrc: ["'self'", 'blob:'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(cors({ origin: env.PUBLIC_APP_URL, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(sanitizeMongo());
  app.use(globalLimiter);

  // Populates req.user; does NOT authorise. Authorisation is per-route via rbac().
  app.use('/api/v1', authenticate());
  // Immediately after authenticate, so nothing downstream ever sees an unconfined request
  // that was authenticated by a report token.
  app.use('/api/v1', reportScopeGuard());

  // Patches res.json, so it must register before any route handler runs.
  app.use('/api/v1', provenanceGuard);

  // ── routes ────────────────────────────────────────────────────────
  app.get('/api/v1', (_req, res) => res.json({ name: 'varuna-api', version: 'v1' }));
  app.get('/api/v1/openapi.json', (_req, res) => res.json(openApiDocument()));
  for (const [mount, router] of ROUTE_MOUNTS) app.use(mount, router);

  app.use((req, _res, next) => next(new NotFoundError(`No route for ${req.method} ${req.path}`)));
  app.use(errorHandler);

  return app;
}
