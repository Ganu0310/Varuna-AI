import { Router, type NextFunction, type Request, type Response } from 'express';
import { env } from '../../env.js';
import { NotFoundError } from '../../errors.js';
import { InvestigationModel } from '../investigations/model.js';
import { SatelliteSceneModel } from '../scenes/model.js';
import { SpillDetectionModel } from '../detections/model.js';
import { OriginEstimateModel } from '../origin/model.js';
import { CandidateVesselModel } from '../candidates/model.js';

/**
 * The one unauthenticated route — 14 §14.6 Phase 13, 05_FRONTEND §5.5.2.
 *
 * The landing page has to show a real incident. A page describing what the system *would*
 * find, illustrated with numbers nobody can retrieve, is the exact failure
 * 13_REAL_DATA_POLICY exists to prevent — and it is the first thing an evaluator sees.
 *
 * So this reads one nominated, already-completed investigation and returns it in a form safe
 * to publish. Four constraints make that safe:
 *
 *   1. **One investigation, named in configuration.** Not "the most recent", which would
 *      publish whatever an analyst happened to open last.
 *   2. **Read-only, and no id echoed.** Nothing here can be used to address the private API.
 *   3. **No vessel identity.** Ranked candidates appear as evidence STRENGTH, with MMSI, name
 *      and flag withheld. Naming a real vessel on a public page, on a system whose own guide
 *      says its output is a lead and not a verdict, would be an accusation — the single thing
 *      this product must never make.
 *   4. **Nothing is computed here.** It reports what the pipeline already stored. A landing
 *      page that ran analysis on demand would be a free compute endpoint pointed at the
 *      internet.
 *
 * Unset `DEMO_INVESTIGATION_ID` answers 404 with the reason. An unconfigured demo must not
 * silently fall back to any other case.
 */
export const publicRouter: Router = Router();

publicRouter.get('/demo-incident', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const id = env.DEMO_INVESTIGATION_ID;
    if (!id) {
      throw new NotFoundError(
        'No demo incident is configured. Set DEMO_INVESTIGATION_ID to a completed investigation.',
      );
    }

    const inv = await InvestigationModel.findById(id).lean();
    if (!inv) {
      throw new NotFoundError('The configured demo incident no longer exists.');
    }

    const [scenes, detections, origin, candidates] = await Promise.all([
      SatelliteSceneModel.find({ investigationId: inv._id }).lean(),
      SpillDetectionModel.find({ investigationId: inv._id }).lean(),
      OriginEstimateModel.findOne({ investigationId: inv._id }).sort({ createdAt: -1 }).lean(),
      CandidateVesselModel.find({ investigationId: inv._id }).sort({ score: -1 }).limit(5).lean(),
    ]);

    const scene = scenes[0];

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      incident: {
        name: inv.name,
        aoiAreaKm2: inv.aoiAreaKm2,
        window: { start: inv.windowStart, end: inv.windowEnd },
        aoi: inv.aoi,
      },
      scene: scene
        ? {
            productId: scene.productId,
            platform: scene.platform,
            acquiredAt: scene.acquiredAt,
            polarisations: scene.polarisations,
            mode: scene.mode,
            gsdMeters: scene.gsdMeters,
            // "Which satellite, from whom" is the first thing a sceptical reader asks, and
            // the answer is the point.
            processingChain: scene.processing?.chain ?? null,
          }
        : null,
      detections: detections.map((d) => ({
        areaKm2: d.areaKm2,
        confidence: d.confidence?.overall ?? null,
        lookAlikeCompetition: d.confidence?.lookAlikeCompetition ?? null,
        reviewStatus: d.reviewStatus,
        geometry: d.geometry,
      })),
      origin: origin
        ? {
            status: origin.status,
            // The degradation label travels with it. A drift estimate computed without
            // currents is a weaker claim, and hiding that on the public page would be
            // exactly the kind of flattering omission the policy forbids.
            releaseWindow: origin.releaseWindow ?? null,
            method: origin.method,
            degradationReason: origin.degradationReason ?? null,
            forcing: origin.forcing ?? null,
          }
        : null,
      /**
       * Rank and tier only. No MMSI, no name, no flag, no track.
       */
      candidates: candidates.map((c, i) => ({
        rank: i + 1,
        tier: c.tier,
        score: c.score,
        scoreCI: c.scoreCI ?? null,
        measuredFeatureCount: c.measuredFeatureCount ?? 0,
        calibrated: c.calibrated ?? false,
        identityWithheld: true,
      })),
      disclaimer:
        'A reconstruction of one real incident. Candidate vessels are shown as evidence ' +
        'strength only, with identity withheld: this system produces investigative leads, ' +
        'not verdicts.',
      counts: { scenes: scenes.length, detections: detections.length },
    });
  } catch (err) {
    next(err);
  }
});
