import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Polygon } from 'geojson';
import { rbac } from '../../middleware/rbac.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { catalogueLimiter } from '../../middleware/rateLimits.js';
import { ALL_SATELLITE_PROVIDERS, searchCatalogue } from '../../providers/chain.js';
import { quotaTracker } from '../../providers/quota.js';
import { CatalogueSearchQuery, parseAoi } from './schema.js';

/**
 * Catalogue — 06_BACKEND §6.4.3.
 *
 * A LIVE provider query. Nothing is persisted here: this endpoint reports what the
 * providers say right now, and `providerStatus` makes a partial failure visible rather than
 * quietly returning a smaller list.
 */
export const catalogueRouter: Router = Router();

catalogueRouter.get(
  '/search',
  rbac('viewer'),
  catalogueLimiter,
  validate({ query: CatalogueSearchQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = validatedQuery<CatalogueSearchQuery>(req);
      const aoi = parseAoi(q.aoi) as Polygon;

      const result = await searchCatalogue({
        aoi,
        from: q.from,
        to: q.to,
        platforms: q.platforms
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        orbitDirection: q.orbitDirection,
        polarisation: q.polarisation,
        maxCloudPct: q.maxCloud,
        limit: q.limit,
      });

      // Polarisation filtering is applied here rather than per-provider: the providers
      // express it differently, and filtering after normalisation keeps the semantics one.
      const items = q.polarisation
        ? result.items.filter((i) => i.polarisations.includes(q.polarisation!))
        : result.items;

      res.json({
        items,
        providerStatus: result.providerStatus,
        query: { from: q.from, to: q.to, limit: q.limit },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Provider health — circuit state, quota consumed, p95 latency, last success
 * (06_BACKEND §6.4.3 / §6.4.10, 02_TRD §2.12). Reports the truth, including
 * "not configured", rather than inventing green ticks.
 */
catalogueRouter.get(
  '/providers',
  rbac('viewer'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const quotas = await quotaTracker.snapshotAll();
      res.json({
        items: ALL_SATELLITE_PROVIDERS.map((p) => {
          const health = p.health();
          return {
            ...health,
            quotas: quotas.filter((q) => q.quotaKey.startsWith(`${p.name}:`)),
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  },
);
