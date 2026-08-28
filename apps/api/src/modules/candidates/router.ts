import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { ATTRIBUTION_FEATURES, DEFAULT_WEIGHT_PROFILE_ID } from '@varuna/shared';
import { rbac, canAccessInvestigation, requireInvestigationAccess } from '../../middleware/rbac.js';
import { validate, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { NotFoundError } from '../../errors.js';
import { CandidateVesselModel } from './model.js';
import { DEFAULT_WEIGHTS, excludeCandidate, reweight } from './service.js';

/** Candidates — 06_BACKEND §6.4.8. */
export const candidatesRouter: Router = Router();

const IdParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

candidatesRouter.get(
  '/:id/candidates',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await CandidateVesselModel.find({
        investigationId: new Types.ObjectId(param(req, 'id')),
      })
        .sort({ rank: 1 })
        .lean();

      const insufficient = items.filter((i) => i.tier === 'INSUFFICIENT_EVIDENCE').length;
      const excluded = items.filter((i) => i.excluded).length;

      res.json({
        items,
        summary: {
          total: items.length,
          insufficientEvidence: insufficient,
          // Excluded candidates are hidden from the ranking but still counted, so a reader
          // can see that a decision was made rather than that a vessel never existed.
          excluded,
          topTier: items[0]?.tier ?? null,
        },
        // Restated on every response: this is a ranking of leads, not a finding of guilt.
        disclaimer:
          'A ranking of investigative leads, not a determination of responsibility. Scores ' +
          'are weighted evidence renormalised over measured features only.',
      });
    } catch (err) {
      next(err);
    }
  },
);

candidatesRouter.get(
  '/candidates/:id',
  rbac('viewer'),
  validate({ params: IdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await CandidateVesselModel.findById(param(req, 'id')).lean();
      if (!doc) throw new NotFoundError('Candidate not found');
      const ok = await canAccessInvestigation(req.user!, String(doc.investigationId));
      if (!ok) throw new NotFoundError('Candidate not found');
      res.json(doc);
    } catch (err) {
      next(err);
    }
  },
);

/** The source records behind one feature — every number drills down to real AIS fixes. */
candidatesRouter.get(
  '/candidates/:id/evidence/:featureKey',
  rbac('viewer'),
  validate({
    params: z.object({
      id: z.string().regex(/^[a-f\d]{24}$/i),
      featureKey: z.string().max(64),
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await CandidateVesselModel.findById(param(req, 'id')).lean();
      if (!doc) throw new NotFoundError('Candidate not found');
      const ok = await canAccessInvestigation(req.user!, String(doc.investigationId));
      if (!ok) throw new NotFoundError('Candidate not found');

      const key = param(req, 'featureKey');
      const feature = doc.features.find((f) => f.key === key);
      if (!feature) throw new NotFoundError(`No feature "${key}" on this candidate`);

      const definition = ATTRIBUTION_FEATURES.find((f) => f.key === key);

      res.json({
        feature,
        definition: definition
          ? {
              unit: definition.unit,
              defaultWeight: definition.defaultWeight,
              family: definition.family,
            }
          : null,
        mmsi: doc.mmsi,
        evidenceRefs: feature.evidenceRefs ?? [],
        // A feature that could not be measured still answers "why not".
        measurable: feature.status === 'MEASURED',
      });
    } catch (err) {
      next(err);
    }
  },
);

const ReweightBody = z
  .object({
    detectionId: z.string().regex(/^[a-f\d]{24}$/i),
    profileId: z.string().trim().min(1).max(80).default('CUSTOM'),
    weights: z.record(z.string(), z.number().min(0).max(1)),
  })
  .strict();

candidatesRouter.post(
  '/:id/candidates/reweight',
  rbac('analyst'),
  validate({ params: IdParam, body: ReweightBody }),
  requireInvestigationAccess('analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await reweight(
        param(req, 'id'),
        req.body.detectionId,
        req.body.weights,
        req.body.profileId,
        req.user!.id,
        reqId(req),
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

const ExcludeBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();

candidatesRouter.post(
  '/candidates/:id/exclude',
  rbac('analyst'),
  validate({ params: IdParam, body: ExcludeBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await CandidateVesselModel.findById(param(req, 'id')).lean();
      if (!existing) throw new NotFoundError('Candidate not found');
      const ok = await canAccessInvestigation(req.user!, String(existing.investigationId));
      if (!ok) throw new NotFoundError('Candidate not found');

      const doc = await excludeCandidate(
        param(req, 'id'),
        req.body.reason,
        req.user!.id,
        reqId(req),
      );
      res.json(doc);
    } catch (err) {
      next(err);
    }
  },
);

candidatesRouter.get('/weight-profiles', rbac('viewer'), (_req: Request, res: Response) => {
  res.json({
    items: [
      {
        profileId: DEFAULT_WEIGHT_PROFILE_ID,
        weights: DEFAULT_WEIGHTS,
        description:
          'Expert-elicited defaults (07_AIML §7.6). Spatial and temporal evidence dominates; ' +
          'the vessel-type prior is weighted low so it can never be the reason a vessel ranks first.',
      },
    ],
    features: ATTRIBUTION_FEATURES,
  });
});
