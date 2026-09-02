import { Router, type NextFunction, type Request, type Response } from 'express';
import { rbac } from '../../middleware/rbac.js';
import { validate, validatedQuery, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { jobCreationLimiter } from '../../middleware/rateLimits.js';
import { watchRegionById } from '@varuna/shared';
import { NotFoundError } from '../../errors.js';
import { audit } from '../audit/service.js';
import { enqueue } from '../../queue/producer.js';
import * as service from './service.js';
import {
  AdoptDetectionBody,
  AdoptDetectionParams,
  DiscoverDetectionsQuery,
  DiscoverOverpassesQuery,
  TriggerSweepBody,
} from './schema.js';

/**
 * Discover — browse a time period across the sweep's watch regions, and start an
 * investigation from what it already found (06_BACKEND §6.4.10).
 *
 * `rbac('viewer')` on the reads: this is meant to be usable by anyone deciding whether a
 * region is worth opening a case for, the same bar `/catalogue` already sets.
 *
 * `/regions` and `/overpasses` are not membership-scoped, deliberately: a watch region and
 * the catalogue listings over it are system facts, authored by nobody. `/detections` IS
 * scoped, and must be — it selects by geography across investigation boundaries, so without
 * the filter in `visibleInvestigationIds` a public bounding box would become a way to read
 * other analysts' private findings. The adopt side stays a real, audited write.
 */
export const discoverRouter: Router = Router();

discoverRouter.get(
  '/regions',
  rbac('viewer'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ items: await service.listWatchRegions() });
    } catch (err) {
      next(err);
    }
  },
);

discoverRouter.get(
  '/detections',
  rbac('viewer'),
  validate({ query: DiscoverDetectionsQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = validatedQuery<DiscoverDetectionsQuery>(req);
      // The caller decides what is visible, not just what is asked for — see the service.
      res.json(await service.listDetections(q, req.user!));
    } catch (err) {
      next(err);
    }
  },
);

discoverRouter.get(
  '/overpasses',
  rbac('viewer'),
  validate({ query: DiscoverOverpassesQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = validatedQuery<DiscoverOverpassesQuery>(req);
      res.json({ items: await service.listOverpasses(q) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Run a sweep now — the "Discover now" button.
 *
 * Same shape as every other manual job trigger in this codebase (`POST /origin/run`,
 * `POST /system/verified-scenario`): analyst-gated, rate-limited, audited, returns the job id.
 *
 * Two details are deliberate. The job key is STABLE per scope, so pressing the button twice
 * cannot start two sweeps — `enqueue` reports the second as `deduplicated` while the first is
 * still running, and re-runs cleanly once it has finished. And the job is attributed to the
 * CALLER rather than the sweep's own system account, because `GET /jobs` shows an unscoped job
 * only to whoever created it — attributing it to the system user would hide the analyst's own
 * sweep from them.
 */
discoverRouter.post(
  '/sweep',
  rbac('analyst'),
  jobCreationLimiter,
  validate({ body: TriggerSweepBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const regionId = (req.body as TriggerSweepBody).regionId;
      if (regionId && !watchRegionById(regionId)) {
        throw new NotFoundError(`No watch region "${regionId}"`);
      }

      const { jobId, deduplicated } = await enqueue({
        queue: 'sweep',
        kind: 'SWEEP_TICK',
        jobKey: `sweep:manual:${regionId ?? 'all'}`,
        payload: { triggeredBy: 'MANUAL', ...(regionId ? { regionId } : {}) },
        userId: req.user!.id,
      });

      await audit({
        actorId: req.user!.id,
        action: 'DISCOVER_SWEEP_REQUESTED',
        entityType: 'WatchRegion',
        entityId: regionId ?? 'all',
        after: { jobId, deduplicated },
        requestId: reqId(req),
      });

      res
        .status(deduplicated ? 200 : 202)
        .json({ jobId, deduplicated, regionId: regionId ?? null });
    } catch (err) {
      next(err);
    }
  },
);

discoverRouter.post(
  '/detections/:id/adopt',
  rbac('analyst'),
  jobCreationLimiter,
  validate({ params: AdoptDetectionParams, body: AdoptDetectionBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.adoptDetection(
        param(req, 'id'),
        req.user!,
        req.body.investigationId,
        reqId(req),
      );
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      next(err);
    }
  },
);
