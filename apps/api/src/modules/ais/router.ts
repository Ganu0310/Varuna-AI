import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import mongoose, { Types } from 'mongoose';
import type { Polygon } from 'geojson';
import { rbac, requireInvestigationAccess } from '../../middleware/rbac.js';
import { validate, validatedQuery, param } from '../../middleware/validate.js';
import { NotFoundError } from '../../errors.js';
import { getInvestigation } from '../investigations/service.js';
import { OriginEstimateModel } from '../origin/model.js';
import { VesselTrackModel } from './model.js';
import { coverage, darkPeriods, reconstructTracks, chooseHint } from './service.js';

/** AIS — 06_BACKEND §6.4.7. */
export const aisRouter: Router = Router();

const IdParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

function bboxOfInvestigation(aoi: unknown): [number, number, number, number] {
  const ring = (aoi as { coordinates: number[][][] }).coordinates[0]!;
  const lons = ring.map((c) => c[0]!);
  const lats = ring.map((c) => c[1]!);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/**
 * The honesty endpoint — 06_BACKEND §6.4.7.
 *
 * Deliberately placed first in the AIS panel: an attribution is only as good as the AIS
 * coverage under it, and with sparse coverage a "top candidate" may simply be the only
 * vessel that was transmitting.
 */
aisRouter.get(
  '/:id/ais/coverage',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inv = await getInvestigation(param(req, 'id'));
      const result = await coverage(
        inv.windowStart.toISOString(),
        inv.windowEnd.toISOString(),
        bboxOfInvestigation(inv.aoi),
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

const TracksQuery = z
  .object({
    persist: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

aisRouter.get(
  '/:id/ais/tracks',
  rbac('viewer'),
  validate({ params: IdParam, query: TracksQuery }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = param(req, 'id');
      const inv = await getInvestigation(id);
      const bbox = bboxOfInvestigation(inv.aoi);
      const from = inv.windowStart.toISOString();
      const to = inv.windowEnd.toISOString();

      const hint = chooseHint(bbox, from, to);
      const tracks = await reconstructTracks(from, to, bbox);
      const q = validatedQuery<z.infer<typeof TracksQuery>>(req);

      // The origin zone, when one exists, lets each gap be reported with whether it
      // overlaps the plausible release area.
      const origin = await OriginEstimateModel.findOne({
        investigationId: new Types.ObjectId(id),
      })
        .sort({ createdAt: -1 })
        .lean();
      const zone = (origin?.originField?.support90 as unknown as Polygon | undefined) ?? null;

      const gaps = darkPeriods(
        tracks,
        zone,
        origin?.releaseWindow?.earliest?.toISOString(),
        origin?.releaseWindow?.latest?.toISOString(),
      );

      res.json({
        items: tracks.slice(0, q.limit).map((t) => ({
          mmsi: t.mmsi,
          fixCount: t.fixes.length,
          line: t.line,
          /**
           * The observation TIME of each vertex in `line`, same order and length.
           *
           * Without these a client can only assume the fixes are evenly spaced, and AIS
           * reporting is nothing like even — intervals swing from seconds to hours and
           * `gaps` exists precisely because of it. Animating a vessel on that assumption
           * would place it where it was never reported, which is fabricated positional data
           * whatever the intent (13_REAL_DATA_POLICY §13.3). Sending the real times is what
           * lets a client interpolate honestly, and know when it is interpolating.
           */
          times: t.fixes.map((f) => f.t),
          medianIntervalSec: t.medianIntervalSec,
          // Surfaced per vessel: a track that had points removed is not the raw record.
          removedOutlierCount: t.removedOutlierCount,
          gapCount: t.gaps.length,
          firstAt: t.fixes[0]?.t ?? null,
          lastAt: t.fixes[t.fixes.length - 1]?.t ?? null,
        })),
        darkPeriods: gaps,
        queryPlan: hint,
        originZoneAvailable: zone !== null,
      });
    } catch (err) {
      next(err);
    }
  },
);

const MmsiParam = z.object({ mmsi: z.string().regex(/^\d{6,9}$/) });

/**
 * Vessel identity. `flag` is derived from the MMSI's MID prefix using the vendored ITU
 * table; an MMSI whose prefix is not an assigned country is reported as invalid rather than
 * given a plausible-looking flag.
 */
aisRouter.get(
  '/ais/vessel/:mmsi',
  rbac('viewer'),
  validate({ params: MmsiParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const mmsi = Number(param(req, 'mmsi'));
      const db = mongoose.connection.db;
      if (!db) throw new Error('no mongo connection');

      const latest = (await db
        .collection('ais_positions')
        .find({ 'meta.mmsi': mmsi })
        .sort({ t: -1 })
        .limit(1)
        .toArray()) as unknown as Array<{
        t: Date;
        meta: { mmsi: number; source: string };
        position: { coordinates: [number, number] };
        draught: number | null;
        quality?: { flags?: string[] };
      }>;

      if (latest.length === 0) throw new NotFoundError(`No AIS positions held for MMSI ${mmsi}`);

      const { flag, midValid } = await flagForMmsi(mmsi);
      const positionCount = await db
        .collection('ais_positions')
        .countDocuments({ 'meta.mmsi': mmsi });

      res.json({
        mmsi,
        flag,
        mmsiValid: midValid && String(mmsi).length === 9,
        // Static AIS messages (names, IMO, dimensions) are not present in this archive
        // export; saying so is better than an empty field that reads as "unknown vessel".
        identity: {
          name: null,
          imo: null,
          callsign: null,
          shipType: null,
          note:
            'Static AIS messages are not included in this archive export, so name, IMO and ' +
            'ship type are unavailable. Attribution features that need them report MISSING.',
        },
        lastSeenAt: latest[0]!.t.toISOString(),
        lastPosition: latest[0]!.position,
        draught: latest[0]!.draught,
        positionCount,
        source: latest[0]!.meta.source,
        qualityFlags: latest[0]!.quality?.flags ?? [],
      });
    } catch (err) {
      next(err);
    }
  },
);

let MID_CACHE: Record<string, string[]> | null = null;
async function flagForMmsi(mmsi: number): Promise<{ flag: string | null; midValid: boolean }> {
  if (!MID_CACHE) {
    try {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const raw = await readFile(
        resolve(here, '../../../../../data/reference/mid-table.json'),
        'utf8',
      );
      MID_CACHE = JSON.parse(raw) as Record<string, string[]>;
    } catch {
      MID_CACHE = {};
    }
  }
  const entry = MID_CACHE[String(mmsi).slice(0, 3)];
  return { flag: entry?.[3] ?? null, midValid: Boolean(entry) };
}

aisRouter.get(
  '/:id/ais/vessels',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await VesselTrackModel.find({
        investigationId: new Types.ObjectId(param(req, 'id')),
      })
        .sort({ mmsi: 1 })
        .lean();
      res.json({ items, nextCursor: null });
    } catch (err) {
      next(err);
    }
  },
);
