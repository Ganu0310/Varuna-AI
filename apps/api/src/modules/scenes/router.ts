import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { rbac, requireInvestigationAccess } from '../../middleware/rbac.js';
import { validate, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { jobCreationLimiter } from '../../middleware/rateLimits.js';
import { enqueue } from '../../queue/producer.js';
import { audit } from '../audit/service.js';
import { getInvestigation } from '../investigations/service.js';
import { SatelliteSceneModel } from './model.js';
import { SpillDetectionModel } from '../detections/model.js';

/** Scenes and ingest — 06_BACKEND §6.4.4. */
export const scenesRouter: Router = Router();

const IdParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

const IngestBody = z
  .object({
    productId: z.string().min(4).max(200),
    collection: z.string().min(2).max(80).optional(),
  })
  .strict();

scenesRouter.post(
  '/:id/scenes/ingest',
  rbac('analyst'),
  jobCreationLimiter,
  validate({ params: IdParam, body: IngestBody }),
  requireInvestigationAccess('analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const investigationId = param(req, 'id');
      const inv = await getInvestigation(investigationId);

      // Ingest is scoped to the investigation AOI, not the whole swath: that is what keeps
      // the read to seconds rather than gigabytes (Phase 4 design note).
      const ring = (inv.aoi as unknown as { coordinates: number[][][] }).coordinates[0]!;
      const lons = ring.map((c) => c[0]!);
      const lats = ring.map((c) => c[1]!);
      const aoi: [number, number, number, number] = [
        Math.min(...lons),
        Math.min(...lats),
        Math.max(...lons),
        Math.max(...lats),
      ];

      // Deterministic key: re-requesting the same product for the same investigation is a
      // no-op rather than a second multi-second provider read (03_ARCHITECTURE §3.6).
      const jobKey = `ingest:${investigationId}:${req.body.productId}`;
      const { jobId, deduplicated } = await enqueue({
        queue: 'ingest',
        kind: 'INGEST',
        jobKey,
        payload: {
          investigationId,
          productId: req.body.productId,
          aoi,
          collection: req.body.collection ?? 'sentinel-1-rtc',
        },
        investigationId,
        userId: req.user!.id,
      });

      await audit({
        actorId: req.user!.id,
        action: 'SCENE_INGEST_REQUESTED',
        entityType: 'Investigation',
        entityId: investigationId,
        after: { productId: req.body.productId, jobId, deduplicated },
        requestId: reqId(req),
      });

      res.status(deduplicated ? 200 : 202).json({ jobId, deduplicated, aoi });
    } catch (err) {
      next(err);
    }
  },
);

scenesRouter.get(
  '/:id/scenes',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await SatelliteSceneModel.find({
        investigationId: new Types.ObjectId(param(req, 'id')),
      })
        .sort({ acquiredAt: 1 })
        .lean();
      res.json({ items, nextCursor: null });
    } catch (err) {
      next(err);
    }
  },
);

scenesRouter.get(
  '/:id/detections',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await SpillDetectionModel.find({
        investigationId: new Types.ObjectId(param(req, 'id')),
      })
        .sort({ 'confidence.overall': -1 })
        .lean();
      res.json({ items, nextCursor: null });
    } catch (err) {
      next(err);
    }
  },
);
