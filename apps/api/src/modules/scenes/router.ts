import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
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
import { extractSceneMetadata, type ExtractedSceneMetadata } from './sceneMetadata.js';
import multer from 'multer';
import * as turf from '@turf/turf';
import { createHash } from 'node:crypto';
import { putScene, sceneExists, uploadKey } from '../../lib/objectStore.js';
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

/**
 * Turn multer's own failures into problem+json instead of a 500.
 *
 * Multer signals a body over the ceiling by calling `next(MulterError)`, which nothing in the
 * error chain recognised — so the one predictable way to fail these routes, sending a file
 * that is too big, came back as "Internal server error" with no number and no remedy. That
 * reads like an outage and is a limit working exactly as intended.
 *
 * Wrapped per route rather than handled centrally because the useful part of the message is
 * the ceiling, and the ceiling is a property of the route.
 */
function receiveFile(handler: RequestHandler, limitBytes: number, hint: string): RequestHandler {
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(
            new HttpError(
              413,
              'File too large',
              `This endpoint accepts at most ${Math.round(limitBytes / (1024 * 1024))} MB. ${hint}`,
              'https://varuna.dev/problems/upload-too-large',
            ),
          );
        }
        return next(
          new HttpError(
            400,
            'Upload rejected',
            `${err.message}. Send exactly one file under the field name "scene".`,
            'https://varuna.dev/problems/no-upload',
          ),
        );
      }
      next(err);
    });
  };
}

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

      // INGESTIBILITY, checked here rather than discovered three services downstream.
      //
      // The ML service resolves a product id against the Planetary Computer `sentinel-1-rtc`
      // collection. A product id from another provider — a CDSE `.SAFE`, say — is a perfectly
      // real acquisition that simply is not in that collection, and it came back as
      // `ML_SERVICE unavailable: HTTP_404` after a queue round trip. That reads like an
      // outage and is actually a provider mismatch, so it is refused up front with the reason
      // and the remedy.
      const collection = req.body.collection ?? 'sentinel-1-rtc';
      if (collection !== 'sentinel-1-rtc') {
        throw new HttpError(
          422,
          'Unsupported collection',
          `Scenes are ingested from the "sentinel-1-rtc" collection, not "${collection}". ` +
            'That collection is radiometrically terrain-corrected already, which is what lets ' +
            'ingest window a scene in seconds instead of running SNAP. The acquisition may well ' +
            'exist elsewhere — pick the Planetary Computer RTC product for the same overpass.',
        );
      }

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
          collection,
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
        /*
         * Ordered by triage, then by the detector's confidence.
         *
         * Triage ranks on extent, backscatter contrast and elongation — measurements that do
         * not depend on the look-alike channel, which held-out evaluation found uninformative
         * about its own errors (07_AIML §9). Confidence remains the tie-break and the fallback
         * for detections written before triage existed, which sort last with a null score.
         */
        .sort({ 'triage.score': -1, 'confidence.overall': -1 })
        .lean();
      res.json({ items, nextCursor: null });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Only ever handed a header slice, so the ceiling is small.
 *
 * A GeoTIFF states everything about itself in its first image file directory. The browser
 * therefore sends the first few megabytes rather than the whole file — asking an analyst to
 * upload a 4 GB scene twice, once to look at it and once to keep it, would make the preview
 * cost more than the thing it previews.
 */
const inspectSlice = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024, files: 1 },
});

/** How the preview extent sits against the investigation's own AOI. */
function aoiRelation(
  footprint: ExtractedSceneMetadata['footprint'],
  aoi: unknown,
): { intersects: boolean; aoiCoveredPct: number | null; note: string } | null {
  if (!footprint) return null;
  try {
    const scene = turf.polygon(footprint.coordinates);
    const area = turf.polygon((aoi as { coordinates: number[][][] }).coordinates);
    const overlap = turf.intersect(turf.featureCollection([scene, area]));
    if (!overlap) {
      return {
        intersects: false,
        aoiCoveredPct: 0,
        note:
          'This scene does not cover the investigation area at all. Detections from it would ' +
          'be real, and would be somewhere else — check you have the right acquisition.',
      };
    }
    const pct = (turf.area(overlap) / turf.area(area)) * 100;
    return {
      intersects: true,
      aoiCoveredPct: Number(pct.toFixed(1)),
      note:
        pct >= 99
          ? 'The scene covers the whole area of interest.'
          : `The scene covers ${pct.toFixed(1)}% of the area of interest; the rest is outside the swath.`,
    };
  } catch {
    // A self-intersecting or otherwise degenerate ring is not worth failing the inspect over.
    return null;
  }
}

/**
 * Read an uploaded scene and report what it says about itself — 06_BACKEND §6.4.4.
 *
 * Nothing is stored, nothing is queued, and nothing is written to the investigation. This
 * exists so the upload form can be filled in FROM THE FILE instead of from memory: the
 * analyst holding a GeoTIFF should not have to retype the coordinate system, the pixel size
 * or — the dangerous one — the acquisition instant that every AIS query is centred on.
 *
 * What comes back is evidence, not a decision. Each acquisition time is returned with the
 * place in the file it came from and how far it can be trusted, and the form adopts only the
 * ones the file states unambiguously. A guess presented as a default is worse than an empty
 * field, because an empty field gets filled in and a wrong default gets submitted.
 *
 * The body of the handler is shared by two routes because there are two moments an analyst
 * has a file and no investigation record for it yet: adding a scene to a case that exists,
 * and starting a case FROM the scene. The only difference is that the first can say how the
 * extent sits against an AOI and the second has no AOI to compare with.
 */
function describeScene(
  req: Request,
  res: Response,
  scope: { aoi: unknown; windowStart: Date; windowEnd: Date } | null,
): void {
  const file = req.file;
  if (!file) {
    throw new HttpError(
      400,
      'No file',
      'Send the GeoTIFF (or its leading bytes) as multipart/form-data under the field name "scene".',
      'https://varuna.dev/problems/no-upload',
    );
  }

  // The name is part of the evidence: mission product identifiers carry the sensing time,
  // and the browser sends the real filename even when the body is only a slice of it.
  const originalName = String(
    (req.body as { originalName?: string } | undefined)?.originalName ?? file.originalname,
  );

  const check = inspectGeoTiff(file.buffer);
  const metadata = extractSceneMetadata(file.buffer, originalName);

  // Whether the whole file was sent, or only a head slice. It changes what "absent" means:
  // a value missing from a slice may well be present in the file.
  const declaredBytes = Number((req.body as { totalBytes?: string } | undefined)?.totalBytes);
  const partial =
    Number.isFinite(declaredBytes) && declaredBytes > file.size ? declaredBytes : null;

  res.json({
    acceptable: check.ok,
    // The refusal is the analyst's next action, so it is returned before they upload
    // rather than after — same text the upload route would have used.
    rejectionReason: check.ok ? null : (check.reason ?? null),
    originalName,
    bytesInspected: file.size,
    totalBytes: partial,
    partial: partial !== null,
    metadata,
    aoi: scope ? aoiRelation(metadata.footprint, scope.aoi) : null,
    window: scope ? { start: scope.windowStart, end: scope.windowEnd } : null,
    // Said plainly, because the preview map is persuasive and this is not the real read.
    note:
      'Read from the file header only. The authoritative coordinate system, footprint and ' +
      'pixel geometry are resolved by the ingest, which can construct the CRS properly.',
  });
}

const RECEIVE_SLICE = receiveFile(
  inspectSlice.single('scene'),
  16 * 1024 * 1024,
  'Only the leading bytes are needed — a GeoTIFF states everything about itself in its ' +
    'first directory, so send a slice rather than the whole scene.',
);

scenesRouter.post(
  '/:id/scenes/inspect',
  rbac('analyst'),
  RECEIVE_SLICE,
  validate({ params: IdParam }),
  requireInvestigationAccess('analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inv = await getInvestigation(param(req, 'id'));
      describeScene(req, res, {
        aoi: inv.aoi,
        windowStart: inv.windowStart,
        windowEnd: inv.windowEnd,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The same read, before any investigation exists — mounted at `/api/v1/scenes/inspect`.
 *
 * An analyst who has been handed a SAR image and told "there is a slick in this" starts from
 * the file, not from a map. Requiring them to guess an area of interest and a time window
 * first, and only then discover whether the file was usable, had the sequence backwards: the
 * file already states where it looked and when, so it can define the case rather than be
 * checked against one. This route is what lets the new-investigation form be filled in from
 * the scene.
 *
 * Unscoped, so there is no investigation to authorise against — `rbac('analyst')` is the whole
 * gate, which is right because nothing is read from the database and nothing is written to it.
 * The response omits the AOI comparison for the honest reason that there is no AOI yet.
 */
export const sceneInspectRouter: Router = Router();

sceneInspectRouter.post(
  '/inspect',
  rbac('analyst'),
  RECEIVE_SLICE,
  (req: Request, res: Response, next: NextFunction) => {
    try {
      describeScene(req, res, null);
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
  receiveFile(
    uploadScene.single('scene'),
    600 * 1024 * 1024,
    'A Sentinel-1 GRD is around 1 GB whole; upload the AOI window as a COG, or ingest it ' +
      'from a catalogue by product id instead.',
  ),
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

      // What the file says about itself, read before anything is stored. The acquisition
      // instant below is taken from here when the uploader did not state one.
      const metadata = extractSceneMetadata(file.buffer, file.originalname);

      /**
       * The one field with no safe default — and the one worth extracting properly.
       *
       * Finding the vessel means querying AIS in a window around the observation. With the
       * wrong instant the query returns real positions of real ships that were simply
       * somewhere else at the time — a confident ranking of vessels that could not have done
       * it. So there are exactly two ways this value may be set, and guessing is neither:
       *
       *  1. The uploader states it. Always wins; they may know something the file does not.
       *  2. The FILE states it, unambiguously — a mission product identifier, or a metadata
       *     key that means acquisition rather than production. `extractSceneMetadata` only
       *     fills `acquiredAt` from those, and leaves it null when two such sources disagree.
       *
       * A weak signal (TIFFTAG_DATETIME, a bare date, a timestamp under an unknown key) is
       * never adopted. It is returned in the refusal instead, so the analyst can confirm it
       * in one click rather than being silently given it.
       */
      const supplied = String((req.body as { acquiredAt?: string } | undefined)?.acquiredAt ?? '');
      const suppliedOk = supplied !== '' && !Number.isNaN(Date.parse(supplied));

      const acquiredAt = suppliedOk ? new Date(supplied).toISOString() : metadata.acquiredAt;
      const acquiredAtSource = suppliedOk
        ? 'SUPPLIED_BY_UPLOADER'
        : (metadata.acquiredAtSource ?? null);

      if (!acquiredAt) {
        throw new HttpError(
          400,
          'Acquisition time required',
          (metadata.acquisitionConflict ??
            'This file does not state, unambiguously, when the radar observed the scene, so it ' +
              'has to be supplied. Send `acquiredAt` as an ISO 8601 UTC instant alongside the ' +
              'file.') +
            ' AIS is searched in a window around this time, so a wrong value ranks vessels that ' +
            'were nowhere near the spill.' +
            (metadata.acquisitionCandidates.length > 0
              ? ' The file does mention: ' +
                metadata.acquisitionCandidates
                  .map((c) => `${c.value} (${c.source}, ${c.confidence.toLowerCase()} confidence)`)
                  .join('; ') +
                '.'
              : ''),
          'https://varuna.dev/problems/acquisition-time-required',
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

      /**
       * Object storage, not local disk.
       *
       * The ML service owns raster IO and reads from S3; when the two run in separate
       * containers it cannot see the API's filesystem at all. Writing the bytes where the ML
       * service already knows how to look is what makes an uploaded scene take the SAME path
       * as a catalogue one, rather than needing a second, weaker pipeline.
       */
      const key = uploadKey(checksum);

      // Idempotent on CONTENT, not on filename: the same bytes uploaded twice are one scene,
      // two different files sharing a name are two. Checked against the stored OBJECT rather
      // than a `SatelliteScene` document, because no such document exists until `/adopt` has
      // resolved the CRS — an earlier version looked for the document, so the branch could
      // never fire and every re-upload silently rewrote the file.
      const alreadyHeld = await sceneExists(key);
      if (!alreadyHeld) {
        await putScene(key, file.buffer);
      }

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
          // WHERE the acquisition instant came from, not only what it was. Everything
          // downstream is centred on it, so "the analyst typed this" and "the Sentinel-1
          // product name says this" have to stay distinguishable after the fact.
          acquiredAt,
          acquiredAtSource,
          extracted: {
            crs: metadata.crs,
            width: metadata.width,
            height: metadata.height,
            pixelSize: metadata.pixelSize,
            platform: metadata.platform,
            mode: metadata.mode,
            polarisations: metadata.polarisations,
          },
        },
        requestId: reqId(req),
      });

      // The AOI is the investigation's, and it is only used to record what was asked for —
      // an uploaded scene defines its own extent from its transform, so nothing is windowed.
      const { jobId, deduplicated } = await enqueue({
        queue: 'ingest',
        kind: 'INGEST',
        jobKey: `adopt:${investigationId}:${checksum}`,
        payload: {
          investigationId,
          productId,
          aoi: [0, 0, 0, 0],
          source: {
            kind: 'UPLOAD',
            bucket: env.S3_BUCKET,
            key,
            acquiredAt,
            acquiredAtSource,
            platform: metadata.platform,
            uploadedBy: req.user!.id,
            originalName: file.originalname,
            checksum,
          },
        },
        investigationId,
        userId: req.user!.id,
      });

      res.status(deduplicated ? 200 : 202).json({
        jobId,
        deduplicated,
        productId,
        checksum,
        bytes: file.size,
        alreadyStored: alreadyHeld,
        acquiredAt,
        acquiredAtSource,
        // What was read off the file, returned so the analyst can see what VARUNA understood
        // rather than having to infer it from the scene record that appears a minute later.
        extracted: metadata,
        // Said in the response, not only in the database. Whoever uploaded this should learn
        // here that the resulting scene is labelled unverified everywhere it appears.
        provenanceNotice:
          'Recorded as OPERATOR_SUPPLIED. VARUNA did not retrieve this from a published ' +
          'archive and cannot vouch for its origin or its processing history. ' +
          (suppliedOk
            ? 'The acquisition time is the one you supplied'
            : `The acquisition time was read from the file itself (${acquiredAtSource})`) +
          ' — and every AIS correlation depends on that time being right.',
      });
    } catch (err) {
      next(err);
    }
  },
);
