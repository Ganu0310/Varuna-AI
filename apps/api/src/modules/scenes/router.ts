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
import { NotFoundError, HttpError } from '../../errors.js';
import { SatelliteSceneModel } from './model.js';
import { inspectGeoTiff } from './geotiff.js';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SpillDetectionModel } from '../detections/model.js';

/** Scenes and ingest — 06_BACKEND §6.4.4. */
export const scenesRouter: Router = Router();

/**
 * In memory, with a hard ceiling.
 *
 * The ceiling exists because this route is reachable by any analyst and a Sentinel-1 GRD is
 * around 1 GB; without it, one upload is a denial of service against the API process. Memory
 * rather than a temp directory so an upload that fails validation never touches the disk at
 * all — nothing to clean up, and nothing left behind if the process dies mid-request.
 */
const uploadScene = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 600 * 1024 * 1024, files: 1 },
});

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

      /**
       * A second template, Terrain-RGB encoded, for the relief surface (04_UIUX §4.6.2).
       *
       * MapLibre reads elevation from packed RGB, so the SAME Sigma0 raster can drive a 3D
       * surface. What that surface shows is BACKSCATTER, not height — oil appears as a
       * depression because it damps capillary waves and returns less energy, not because the
       * sea is lower there. The view carries a caption saying so, and it cannot be dismissed.
       */
      const terrainParams = new URLSearchParams({
        url: `s3://${scene.storage?.bucket ?? env.S3_BUCKET}/${key}`,
        algorithm: 'terrainrgb',
        rescale: '0,0.3',
      });

      res.json({
        tileUrlTemplate: `${env.TITILER_URL}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${params}`,
        terrainUrlTemplate: `${env.TITILER_URL}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${terrainParams}`,
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

/**
 * Operator-supplied scene — 06_BACKEND §6.4.4.
 *
 * Scenes could only enter by product id from a public catalogue, which meant an analyst
 * holding a GeoTIFF from a national agency, or an acquisition the free catalogues do not
 * carry, had no way in at all.
 *
 * Two things make this different from every other input, and both are handled explicitly:
 *
 *  1. **It is checked harder.** `inspectGeoTiff` reads the TIFF directory rather than
 *     trusting the extension or the client-supplied MIME type. A plain TIFF or a GeoTIFF with
 *     its georeferencing stripped loads fine as pixels, and detection would produce polygons
 *     in pixel space that get written out as if they were positions on the Earth — a result
 *     indistinguishable from a real one and in the wrong ocean. Rejected at the boundary,
 *     before anything is stored.
 *
 *  2. **Its provenance says where it really came from.** There is no provider to cite, so the
 *     record names the uploader, the checksum and the original filename, and states plainly
 *     that VARUNA did not retrieve this from a published archive and cannot vouch for it.
 *     Anything downstream — a dossier, an export — carries that with it
 *     (13_REAL_DATA_POLICY §13.2). Writing a provider name here would be the single most
 *     damaging thing this endpoint could do.
 */
scenesRouter.post(
  '/:id/scenes/upload',
  rbac('analyst'),
  jobCreationLimiter,
  uploadScene.single('scene'),
  validate({ params: IdParam }),
  requireInvestigationAccess('analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const investigationId = param(req, 'id');
      await getInvestigation(investigationId);

      const file = req.file;
      if (!file) {
        throw new HttpError(
          400,
          'No file',
          'Send the GeoTIFF as multipart/form-data under the field name "scene".',
          'https://varuna.dev/problems/no-upload',
        );
      }

      const check = inspectGeoTiff(file.buffer);
      if (!check.ok) {
        // 422, not 400: the request was well-formed, the CONTENT is unusable. The reason is
        // the analyst's next action, so it is returned verbatim rather than summarised.
        throw new HttpError(
          422,
          'Not a georeferenced GeoTIFF',
          check.reason,
          'https://varuna.dev/problems/ungeoreferenced-upload',
        );
      }

      const checksum = createHash('sha256').update(file.buffer).digest('hex');
      const productId = `UPLOAD-${checksum.slice(0, 16)}`;

      await mkdir(env.UPLOADS_DIR, { recursive: true });
      const storedAt = join(env.UPLOADS_DIR, `${productId}.tif`);

      /**
       * Idempotent on CONTENT, not on filename: the same bytes uploaded twice are one scene,
       * and two different files sharing a name are two.
       *
       * The check is against the stored FILE rather than a `SatelliteScene` document, because
       * at this point no such document exists — the scene record is written by preprocess,
       * once the CRS has actually been resolved. A first version of this route looked for the
       * document, which meant the branch could never fire and every re-upload silently
       * rewrote the file.
       */
      const alreadyHeld = await stat(storedAt).then(
        () => true,
        () => false,
      );
      if (alreadyHeld) {
        res.status(200).json({
          productId,
          checksum,
          deduplicated: true,
          storedAt,
          note: 'These exact bytes were already uploaded to this investigation.',
        });
        return;
      }

      await writeFile(storedAt, file.buffer);

      await audit({
        actorId: req.user!.id,
        action: 'SCENE_UPLOADED',
        entityType: 'Investigation',
        entityId: investigationId,
        after: {
          productId,
          originalName: file.originalname,
          bytes: file.size,
          checksum,
          bigTiff: check.bigTiff ?? false,
        },
        requestId: reqId(req),
      });

      res.status(202).json({
        productId,
        checksum,
        bytes: file.size,
        storedAt,
        // Said in the response, not only in the database. Whoever uploaded this should learn
        // here that the resulting scene will be labelled unverified everywhere it appears.
        provenanceNotice:
          'Recorded as OPERATOR_SUPPLIED. VARUNA did not retrieve this from a published ' +
          'archive and cannot vouch for its origin; every detection derived from it carries ' +
          'that label into the dossier and exports.',
        nextStep:
          'Georeferencing is confirmed at preprocess time, where the CRS is resolved properly.',
      });
    } catch (err) {
      next(err);
    }
  },
);
