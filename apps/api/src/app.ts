import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';

import { env } from './env.js';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { sanitizeMongo } from './middleware/sanitizeMongo.js';
import { authenticate } from './middleware/authenticate.js';
import { globalLimiter } from './middleware/rateLimits.js';
import { provenanceGuard } from './middleware/provenanceGuard.js';
import { errorHandler } from './middleware/errorHandler.js';
import { NotFoundError } from './errors.js';
import { healthRouter } from './modules/health/router.js';
import { authRouter } from './modules/auth/router.js';
import { investigationsRouter } from './modules/investigations/router.js';
import { jobsRouter } from './modules/jobs/router.js';
import { adminRouter } from './modules/admin/router.js';
import { openApiDocument } from './openapi.js';

/**
 * Middleware order matters — 06_BACKEND §6.2:
 *   requestId → pino-http → helmet(CSP) → cors → json → cookieParser → mongoSanitize →
 *   rateLimit → authenticate → router (per-route rbac + validate) → provenanceGuard → errorHandler
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

  // Patches res.json, so it must register before any route handler runs.
  app.use('/api/v1', provenanceGuard);

  // ── routes ────────────────────────────────────────────────────────
  app.use('/', healthRouter);
  app.get('/api/v1', (_req, res) => res.json({ name: 'varuna-api', version: 'v1' }));
  app.get('/api/v1/openapi.json', (_req, res) => res.json(openApiDocument()));
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/investigations', investigationsRouter);
  app.use('/api/v1/jobs', jobsRouter);
  app.use('/api/v1/admin', adminRouter);

  app.use((req, _res, next) => next(new NotFoundError(`No route for ${req.method} ${req.path}`)));
  app.use(errorHandler);

  return app;
}
