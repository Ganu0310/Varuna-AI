import { Router, type Request, type Response } from 'express';

/**
 * Liveness + readiness. `/health` is public; `/health/deep` (checks datastores + ML service)
 * is internal-only and will be guarded once the service-token middleware lands (06_BACKEND
 * §6.4.10).
 */
export const healthRouter: Router = Router();

const startedAt = Date.now();

healthRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'varuna-api',
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    now: new Date().toISOString(),
  });
});

healthRouter.get('/health/deep', async (_req: Request, res: Response) => {
  // TODO(phase-2): probe Mongo, Redis, S3, and the ML service /health.
  res.json({
    status: 'ok',
    checks: {
      mongo: 'not_wired',
      redis: 'not_wired',
      objectStorage: 'not_wired',
      mlService: 'not_wired',
    },
    now: new Date().toISOString(),
  });
});
