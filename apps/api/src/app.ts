import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { rateLimit } from 'express-rate-limit';

import { env } from './env.js';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { sanitizeMongo } from './middleware/sanitizeMongo.js';
import { provenanceGuard } from './middleware/provenanceGuard.js';
import { errorHandler } from './middleware/errorHandler.js';
import { NotFoundError } from './errors.js';
import { healthRouter } from './modules/health/router.js';

/**
 * Middleware order matters — 06_BACKEND §6.2:
 *   requestId → pino-http → helmet(CSP) → cors → json → cookieParser → mongoSanitize →
 *   rateLimit → authenticate → router (per-route rbac + validate) → provenanceGuard → errorHandler
 *
 * authenticate / rbac / validate / provenanceGuard land in Phase 2/1 respectively; the
 * slots are marked so the order is not accidentally changed later.
 */
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
          // WebGL / worker sources for the client are allowed explicitly (02_TRD SEC-4);
          // tightened when the web app CSP is finalised (Phase 10).
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

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 100, // global: 100 req/min/IP (06_BACKEND §6.9)
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  // ── authenticate (Phase 2): populates req.user, does not authorise ──
  // app.use('/api/v1', authenticate);

  // provenanceGuard patches res.json, so it must register BEFORE any route handler runs
  // (13_REAL_DATA_POLICY §13.4 L3). Health is exempt — it carries no data objects.
  app.use('/api/v1', provenanceGuard);

  // ── routes ────────────────────────────────────────────────────────
  app.use('/', healthRouter);
  app.get('/api/v1', (_req, res) => res.json({ name: 'varuna-api', version: 'v1' }));

  app.use((req, _res, next) => next(new NotFoundError(`No route for ${req.method} ${req.path}`)));
  app.use(errorHandler);

  return app;
}
