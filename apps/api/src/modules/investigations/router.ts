import { Router, type NextFunction, type Request, type Response } from 'express';
import { rbac, requireInvestigationAccess } from '../../middleware/rbac.js';
import { validate, validatedQuery, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { listAudit } from '../audit/service.js';
import {
  AddMemberBody,
  CommentBody,
  CommentParams,
  CommentQuery,
  CreateInvestigationBody,
  IdParam,
  ListInvestigationsQuery,
  UpdateInvestigationBody,
} from './schema.js';
import * as service from './service.js';

/**
 * Investigations — 06_BACKEND §6.4.2.
 *
 * Two independent gates on every scoped route:
 *   rbac(...)                      — the GLOBAL role: may this account use the feature at all
 *   requireInvestigationAccess(...) — the role ON THIS INVESTIGATION (creator or member)
 *
 * The "lead" requirement in the spec's table is a per-investigation role, so an analyst who
 * leads an investigation may modify it, while an analyst who is a mere member may not.
 */
export const investigationsRouter: Router = Router();

investigationsRouter.get(
  '/',
  rbac('analyst'),
  validate({ query: ListInvestigationsQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = validatedQuery<ListInvestigationsQuery>(req);
      res.json(await service.listInvestigations(q, req.user!));
    } catch (err) {
      next(err);
    }
  },
);

investigationsRouter.post(
  '/',
  rbac('analyst'),
  validate({ body: CreateInvestigationBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await service.createInvestigation(req.body, req.user!, reqId(req));
      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  },
);

investigationsRouter.get(
  '/:id',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await service.getInvestigation(param(req, 'id')));
    } catch (err) {
      next(err);
    }
  },
);

investigationsRouter.get(
  '/:id/summary',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await service.investigationSummary(param(req, 'id')));
    } catch (err) {
      next(err);
    }
  },
);

investigationsRouter.patch(
  '/:id',
  rbac('analyst'),
  validate({ params: IdParam, body: UpdateInvestigationBody }),
  requireInvestigationAccess('lead'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { doc, scopeChanged, invalidated } = await service.updateInvestigation(
        param(req, 'id'),
        req.body,
        req.user!,
        reqId(req),
      );
      res.json({
        investigation: doc,
        // State the consequence explicitly — changing the AOI or window invalidates
        // everything computed downstream (06_BACKEND §6.4.2, 04_UIUX §4.11).
        ...(scopeChanged
          ? {
              warning: {
                code: 'SCOPE_CHANGED',
                message:
                  'The area of interest or time window changed. Scenes, detections and any ' +
                  'downstream results were computed for the previous scope and are no longer valid.',
                affected: invalidated,
              },
            }
          : {}),
      });
    } catch (err) {
      next(err);
    }
  },
);

investigationsRouter.delete(
  '/:id',
  rbac('analyst'),
  validate({ params: IdParam }),
  requireInvestigationAccess('lead'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await service.deleteInvestigation(param(req, 'id'), req.user!, reqId(req));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

investigationsRouter.post(
  '/:id/members',
  rbac('analyst'),
  validate({ params: IdParam, body: AddMemberBody }),
  requireInvestigationAccess('lead'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await service.addMember(param(req, 'id'), req.body, req.user!, reqId(req)));
    } catch (err) {
      next(err);
    }
  },
);

investigationsRouter.get(
  '/:id/audit',
  rbac('analyst'),
  validate({ params: IdParam }),
  requireInvestigationAccess('lead'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await listAudit({ entityType: 'Investigation', entityId: param(req, 'id') });
      res.json({ items, nextCursor: null });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Comments — 06_BACKEND §6.4.2.
 *
 * `analyst` to write, `viewer` to read: a viewer is someone shown the case, and the notes are
 * a large part of what makes the case comprehensible. Membership is required for both, so an
 * analyst on another team cannot read this team's reasoning.
 */
investigationsRouter.get(
  '/:id/comments',
  rbac('viewer'),
  validate({ params: IdParam, query: CommentQuery }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = validatedQuery<{ subjectType?: string; subjectId?: string }>(req);
      const subject =
        q.subjectType && q.subjectId ? { type: q.subjectType, id: q.subjectId } : undefined;
      const items = await service.listComments(param(req, 'id'), subject);
      res.json({ items, nextCursor: null });
    } catch (err) {
      next(err);
    }
  },
);

investigationsRouter.post(
  '/:id/comments',
  rbac('analyst'),
  validate({ params: IdParam, body: CommentBody }),
  requireInvestigationAccess('analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await service.addComment(param(req, 'id'), req.body, req.user!, reqId(req));
      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  },
);

investigationsRouter.delete(
  '/:id/comments/:commentId',
  rbac('analyst'),
  validate({ params: CommentParams }),
  requireInvestigationAccess('analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await service.retractComment(
        param(req, 'id'),
        param(req, 'commentId'),
        req.user!,
        reqId(req),
      );
      res.json(doc);
    } catch (err) {
      next(err);
    }
  },
);
