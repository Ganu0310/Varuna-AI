import { Router, type NextFunction, type Request, type Response } from 'express';
import { rbac } from '../../middleware/rbac.js';
import { buildCapabilityReport } from './capabilities.js';
import { buildOverview } from './overview.js';
import { runVerifiedDemo, VERIFIED } from './verifiedDemo.js';
import { reqId } from '../../middleware/requestId.js';
import { jobCreationLimiter } from '../../middleware/rateLimits.js';

/**
 * `GET /api/v1/system/capabilities` — 14 Phase 17.
 *
 * The status panel behind Judge Demo Mode, and the honest answer to "is this thing actually
 * running on real data right now?".
 *
 * Authenticated but not admin-gated: an analyst needs to know the ocean-current chain is
 * degraded *before* they read an origin estimate, not after they have filed the dossier.
 * Nothing here is a secret — it reports whether a credential is configured, never its value,
 * and the provider list is public knowledge from the documentation.
 */
export const systemRouter: Router = Router();

/**
 * Signed in, any role.
 *
 * `authenticate()` populates `req.user` when a token is present and otherwise waves the
 * request through — it identifies, it does not gate. Without this line both routes answered
 * ANONYMOUSLY: `/capabilities` published which provider credentials this deployment holds to
 * anyone who asked, and `/overview` dereferenced an absent `req.user` and returned a 500
 * where it owed a 401.
 *
 * Neither is admin-gated, though. An analyst must be able to see that the ocean-current chain
 * is degraded BEFORE they read an origin estimate, not after they have filed the dossier.
 */
systemRouter.use(rbac('viewer'));

systemRouter.get('/capabilities', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Short cache: the panel is polled from every screen, and configuration does not change
    // between requests. Long enough to spare the AIS count, short enough that a restart with
    // new credentials shows up while someone is still looking at it.
    res.set('Cache-Control', 'private, max-age=30');
    res.json(await buildCapabilityReport());
  } catch (err) {
    next(err);
  }
});

/**
 * `GET /api/v1/system/overview` — the operations dashboard.
 *
 * Scoped to what the caller can see, so an analyst's tiles count their own cases and an
 * admin's count the instance. The `scope` field says which, because a number without its
 * denominator is a number nobody can act on.
 */
systemRouter.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'private, max-age=15');
    res.json(await buildOverview(req.user!));
  } catch (err) {
    next(err);
  }
});

/**
 * `GET /api/v1/system/verified-scenario` — what the button will do, before it is pressed.
 *
 * Read-only. The dashboard card describes the scenario from this rather than from constants
 * duplicated in the frontend, so the two cannot drift into describing different incidents.
 */
systemRouter.get('/verified-scenario', (_req: Request, res: Response) => {
  res.json({
    ...VERIFIED,
    summary:
      'Runs the chain against a real Sentinel-1C RTC acquisition from Microsoft Planetary ' +
      'Computer, over an area carrying 2,672,855 real NOAA Marine Cadastre AIS positions ' +
      'across 2025. Ocean currents come from Copernicus Marine and are confirmed available ' +
      'for this date, so the back-track runs on a real field.',
    stages: ['INGEST', 'DETECT', 'BACKTRACK', 'AIS', 'CORRELATE', 'RANK', 'DOSSIER'],
    automated: ['INGEST', 'DETECT'],
    note:
      'The button performs setup only: find or create the investigation, locate the product ' +
      'in a live catalogue, queue the real ingest. Back-tracking and ranking are run from ' +
      'the workspace — pre-computing them would make a live demonstration a playback.',
  });
});

/**
 * `POST /api/v1/system/verified-scenario` — start it.
 *
 * Rate-limited as a job creation route, because it queues one. Idempotent: pressing it twice
 * reuses the investigation and de-duplicates the ingest rather than reading the provider again.
 */
systemRouter.post(
  '/verified-scenario',
  rbac('analyst'),
  jobCreationLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await runVerifiedDemo(req.user!, reqId(req)));
    } catch (err) {
      next(err);
    }
  },
);
