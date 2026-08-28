import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { rbac, canAccessInvestigation, requireInvestigationAccess } from '../../middleware/rbac.js';
import { validate, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { jobCreationLimiter } from '../../middleware/rateLimits.js';
import { NotFoundError } from '../../errors.js';
import { enqueue } from '../../queue/producer.js';
import { audit } from '../audit/service.js';
import { getOrigin, latestOriginForInvestigation } from './service.js';

/** Origin estimation — 06_BACKEND §6.4.6. */
export const originRouter: Router = Router();

const IdParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

const RunBody = z
  .object({
    detectionId: z.string().regex(/^[a-f\d]{24}$/i),
    // Bounded because the ensemble cost is linear in both and an analyst should not be able
    // to queue an hour of compute by mistyping a number.
    horizonHours: z.coerce.number().int().min(1).max(72).optional(),
    particleCount: z.coerce.number().int().min(100).max(20000).optional(),
  })
  .strict();

originRouter.post(
  '/:id/origin/run',
  rbac('analyst'),
  jobCreationLimiter,
  validate({ params: IdParam, body: RunBody }),
  requireInvestigationAccess('analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const investigationId = param(req, 'id');

      // Deterministic key so re-requesting the same back-track is a no-op rather than a
      // second multi-second ensemble run.
      const jobKey = `drift:${investigationId}:${req.body.detectionId}`;
      const { jobId, deduplicated } = await enqueue({
        queue: 'drift',
        kind: 'DRIFT',
        jobKey,
        payload: {
          investigationId,
          detectionId: req.body.detectionId,
          horizonHours: req.body.horizonHours ?? 24,
          particleCount: req.body.particleCount ?? 5000,
        },
        investigationId,
        userId: req.user!.id,
      });

      await audit({
        actorId: req.user!.id,
        action: 'ORIGIN_RUN_REQUESTED',
        entityType: 'Investigation',
        entityId: investigationId,
        after: { detectionId: req.body.detectionId, jobId },
        requestId: reqId(req),
      });

      res.status(deduplicated ? 200 : 202).json({ jobId, deduplicated });
    } catch (err) {
      next(err);
    }
  },
);

originRouter.get(
  '/:id/origin',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await latestOriginForInvestigation(param(req, 'id'));
      if (!doc) {
        // An absent origin estimate is a real state, not an error: it means back-tracking has
        // not run, and the UI should say that rather than showing an empty zone.
        res.json({
          origin: null,
          reason: 'NOT_RUN',
          message:
            'No origin estimate exists for this investigation. Run back-tracking on a ' +
            'reviewed detection to produce one.',
        });
        return;
      }
      res.json({ origin: doc, reason: 'OK' });
    } catch (err) {
      next(err);
    }
  },
);

originRouter.get(
  '/origin/:id',
  rbac('viewer'),
  validate({ params: IdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await getOrigin(param(req, 'id'));
      const ok = await canAccessInvestigation(req.user!, String(doc.investigationId));
      if (!ok) throw new NotFoundError('Origin estimate not found');
      res.json(doc);
    } catch (err) {
      next(err);
    }
  },
);
