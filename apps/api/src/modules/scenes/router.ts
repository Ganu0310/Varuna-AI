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
import { env } from '../../env.js';
import { NotFoundError } from '../../errors.js';
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

/**
 * A TiTiler raster-tile template for one scene's COG — M1.
 *
 * The SAR image is what every downstream claim rests on, so the map must show the ACTUAL
 * pixels the detector ran over. The URL therefore points at the same COG the analysis read
 * (`storage.cogKey`), not a re-rendered copy: what is displayed cannot drift from what was
 * measured (03_ARCHITECTURE §3.7.2).
 *
 * `rescale` is display-only. Sigma0 is stored linear and spans a huge dynamic range, so it
 * has to be stretched to be visible at all; the analysis used the untouched values.
 */
scenesRouter.get(
  '/:id/scenes/:sceneId/tiles',
  rbac('viewer'),
  validate({
    params: z.object({
      id: z.string().regex(/^[a-f\d]{24}$/i),
      sceneId: z.string().regex(/^[a-f\d]{24}$/i),
    }),
  }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scene = await SatelliteSceneModel.findOne({
        _id: new Types.ObjectId(param(req, 'sceneId')),
        investigationId: new Types.ObjectId(param(req, 'id')),
      }).lean();
      if (!scene) throw new NotFoundError('Scene not found in this investigation');

      const key = scene.storage?.cogKey ?? scene.storage?.key;
      if (!key) {
        throw new NotFoundError(
          'This scene has no raster stored. It was catalogued but never ingested, so there ' +
            'are no pixels to display.',
        );
      }

      const params = new URLSearchParams({
        url: `s3://${scene.storage?.bucket ?? env.S3_BUCKET}/${key}`,
        rescale: '0,0.3',
        colormap_name: 'gray',
      });

      // Bounds come from the stored footprint, so the raster is placed by the same geometry
      // the rest of the analysis uses rather than by anything the tile server reports.
      const ring = (scene.footprint as unknown as { coordinates: number[][][] } | undefined)
        ?.coordinates?.[0];
      const bounds = ring
        ? ([
            Math.min(...ring.map((c) => c[0]!)),
            Math.min(...ring.map((c) => c[1]!)),
            Math.max(...ring.map((c) => c[0]!)),
            Math.max(...ring.map((c) => c[1]!)),
          ] as [number, number, number, number])
        : null;

      res.json({
        tileUrlTemplate: `${env.TITILER_URL}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${params}`,
        bounds,
        minZoom: 6,
        maxZoom: 16,
        attribution:
          (scene as unknown as { provenance?: { provider?: string } }).provenance?.provider ?? null,
        rescale: [0, 0.3],
        note: 'Sigma0 linear, stretched for display only; the analysis used the same pixels.',
      });
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
