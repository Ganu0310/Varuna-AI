import { randomUUID, createHash } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response, raw } from 'express';
import { rbac } from '../../middleware/rbac.js';
import { jobCreationLimiter } from '../../middleware/rateLimits.js';
import { HttpError } from '../../errors.js';
import { putObject } from '../../lib/objectStore.js';

/**
 * Analyst raster upload — 06_BACKEND §6.4.4 (upload path).
 *
 * Accepts a single geocoded GeoTIFF as a raw request body (streamed by the browser, no
 * multipart), stores it in object storage under `uploads/<uuid>/`, and returns the key. The
 * file is then run through the SAME ingest → SAR-preprocess → detection pipeline as an
 * archive scene (`POST /investigations/:id/scenes/ingest` with `uploadKey`).
 *
 * Only real geocoded rasters are accepted here. A JPEG/PNG is not Sentinel-1 SAR data and a
 * radar-geometry SAFE/SLC/GRD has no CRS — both are rejected, at the boundary, with a
 * reason.
 */
export const uploadsRouter: Router = Router();

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB — a windowed AOI GeoTIFF, not a full swath

function detectFormat(buf: Buffer): 'tiff' | 'jpeg' | 'png' | 'zip' | 'unknown' {
  if (buf.length < 4) return 'unknown';
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  )
    return 'tiff';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return 'zip';
  return 'unknown';
}

uploadsRouter.post(
  '/raster',
  rbac('analyst'),
  jobCreationLimiter,
  raw({ type: () => true, limit: MAX_BYTES }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new HttpError(400, 'Empty upload', 'No file bytes were received.');
      }

      const rawName = String((req.query.filename as string | undefined) ?? 'upload.tif');
      const safeName = rawName.replace(/[^\w.-]+/g, '_').slice(-120) || 'upload.tif';
      const ext = (safeName.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
      const fmt = detectFormat(body);

      if (fmt === 'jpeg' || fmt === 'png') {
        throw new HttpError(
          415,
          'Not SAR data',
          'This is an optical image (JPEG/PNG). Sentinel-1 is radar; an optical picture ' +
            'cannot be run through SAR oil-spill detection. Upload a geocoded GeoTIFF, or ' +
            'search the archive.',
        );
      }
      if (fmt === 'zip' || ext === 'safe' || ext === 'zip') {
        throw new HttpError(
          415,
          'Terrain correction required',
          'A raw Sentinel-1 SAFE/SLC/GRD product is in radar geometry with no map ' +
            'projection. This build does not run terrain correction, so it cannot ingest ' +
            'one directly. Upload a geocoded GeoTIFF (for example a Sentinel-1 RTC export), ' +
            'or use the archive search — it pulls already-corrected RTC scenes.',
        );
      }
      if (fmt !== 'tiff') {
        throw new HttpError(
          415,
          'Unsupported file',
          'Expected a GeoTIFF (.tif/.tiff). The first bytes of this file are not a TIFF header.',
        );
      }

      const uid = randomUUID();
      const key = `uploads/${uid}/${safeName.endsWith('.tif') || safeName.endsWith('.tiff') ? safeName : `${safeName}.tif`}`;
      const stored = await putObject(key, body, 'image/tiff; application=geotiff');

      res.status(201).json({
        uploadKey: stored.key,
        filename: safeName,
        sizeBytes: stored.sizeBytes,
        format: 'GeoTIFF',
        sha256: createHash('sha256').update(body).digest('hex'),
        note: 'Stored. Ingest it with POST /investigations/:id/scenes/ingest {"uploadKey": …}.',
      });
    } catch (err) {
      next(err);
    }
  },
);
