import { createHash } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { simplify as turfSimplify } from '@turf/turf';
import type { Polygon } from 'geojson';
import { GeoPolygon } from '@varuna/shared';
import { rbac, canAccessInvestigation } from '../../middleware/rbac.js';
import { validate, validatedQuery, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { NotFoundError } from '../../errors.js';
import { env } from '../../env.js';
import { SpillDetectionModel } from './model.js';
import { detectionVersions, reviewDetection } from './review.js';

/** Detections — 06_BACKEND §6.4.5. */
export const detectionsRouter: Router = Router();

const IdParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

/** A detection is visible only to someone who can see its investigation. */
async function visibleDetection(req: Request, id: string) {
  const doc = await SpillDetectionModel.findById(id).lean();
  if (!doc) throw new NotFoundError('Detection not found');
  const ok = await canAccessInvestigation(req.user!, String(doc.investigationId));
  if (!ok) throw new NotFoundError('Detection not found');
  return doc;
}

detectionsRouter.get(
  '/:id',
  rbac('viewer'),
  validate({ params: IdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await visibleDetection(req, param(req, 'id')));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Geometry at a zoom-appropriate simplification, with an ETag.
 *
 * Simplification is for DISPLAY only — `areaKm2` on the detection stays the geodesic figure
 * measured on the full-resolution outline, because a number that becomes evidence must not
 * change with the map's zoom level (02_TRD TR-3).
 */
const GeometryQuery = z
  .object({
    simplify: z
      .string()
      .regex(/^z\d{1,2}$/)
      .optional(),
  })
  .strict();

// Tolerance in degrees, roughly one screen pixel at each zoom level.
function toleranceForZoom(z: number): number {
  return 360 / (256 * Math.pow(2, Math.max(0, Math.min(22, z))));
}

detectionsRouter.get(
  '/:id/geometry',
  rbac('viewer'),
  validate({ params: IdParam, query: GeometryQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await visibleDetection(req, param(req, 'id'));
      const q = validatedQuery<z.infer<typeof GeometryQuery>>(req);

      let geometry = doc.geometry as unknown as Polygon;
      let simplifiedTo: number | null = null;

      if (q.simplify) {
        const zoom = Number(q.simplify.slice(1));
        const tolerance = toleranceForZoom(zoom);
        const out = turfSimplify(geometry, { tolerance, highQuality: false });
        geometry = (('geometry' in out ? out.geometry : out) as Polygon) ?? geometry;
        simplifiedTo = zoom;
      }

      const body = {
        detectionId: String(doc._id),
        geometry,
        simplifiedForZoom: simplifiedTo,
        // Restated on every response so a simplified outline is never mistaken for a
        // re-measurement of the slick.
        areaKm2: doc.areaKm2,
        areaNote: 'areaKm2 is geodesic, measured on the full-resolution outline.',
        reviewStatus: doc.reviewStatus,
      };

      const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 24)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=60');

      if (req.header('if-none-match') === etag) {
        res.status(304).end();
        return;
      }
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

const ReviewBody = z
  .object({
    action: z.enum(['CONFIRM', 'REJECT', 'EDIT', 'REOPEN']),
    note: z.string().trim().max(4000).optional(),
    geometry: GeoPolygon.optional(),
  })
  .strict();

detectionsRouter.post(
  '/:id/review',
  rbac('analyst'),
  validate({ params: IdParam, body: ReviewBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = param(req, 'id');
      await visibleDetection(req, id);
      const result = await reviewDetection({
        detectionId: id,
        action: req.body.action,
        actorId: req.user!.id,
        note: req.body.note,
        geometry: req.body.geometry as Polygon | undefined,
        requestId: reqId(req),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

detectionsRouter.get(
  '/:id/versions',
  rbac('viewer'),
  validate({ params: IdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = param(req, 'id');
      await visibleDetection(req, id);
      const versions = await detectionVersions(id);
      res.json({
        items: versions,
        note:
          'Version 0 is the detector output, retained unchanged. Review actions add ' +
          'versions; they never overwrite it.',
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * A TiTiler template for the scene raster this detection came from.
 *
 * The URL points at the same COG the analysis ran on, so what is displayed cannot drift
 * from what was measured (03_ARCHITECTURE §3.7.2).
 */
detectionsRouter.get(
  '/:id/tiles',
  rbac('viewer'),
  validate({ params: IdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await visibleDetection(req, param(req, 'id'));
      const key = doc.maskKey;
      if (!key) throw new NotFoundError('This detection has no associated raster');

      const params = new URLSearchParams({
        url: `s3://${env.S3_BUCKET}/${key}`,
        rescale: '0,0.3',
        colormap_name: 'gray',
      });
      res.json({
        tileUrlTemplate: `${env.TITILER_URL}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${params}`,
        minZoom: 6,
        maxZoom: 16,
        source: { bucket: env.S3_BUCKET, key },
        rescale: [0, 0.3],
        note: 'Sigma0 linear, rescaled for display only; analysis used the same pixels.',
      });
    } catch (err) {
      next(err);
    }
  },
);
