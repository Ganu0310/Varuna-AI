import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ROLES } from '@varuna/shared';
import { rbac } from '../../middleware/rbac.js';
import { validate, validatedQuery, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { NotFoundError } from '../../errors.js';
import { audit, listAudit } from '../audit/service.js';
import { UserModel } from '../auth/model.js';
import { detectionLabels } from '../detections/labels.js';
import { TrainingLabelQuery } from './schema.js';
import { toPublicUser } from '../auth/service.js';
import { quotaTracker } from '../../providers/quota.js';
import { ALL_SATELLITE_PROVIDERS } from '../../providers/chain.js';

/** Admin — 06_BACKEND §6.4.10. Every route is admin-only. */
export const adminRouter: Router = Router();

adminRouter.use(rbac('admin'));

adminRouter.get('/users', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await UserModel.find().sort({ createdAt: -1 }).limit(200);
    res.json({ items: users.map(toPublicUser), nextCursor: null });
  } catch (err) {
    next(err);
  }
});

const SetRoleBody = z.object({ role: z.enum(ROLES) }).strict();
const UserIdParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

adminRouter.post(
  '/users/:id/role',
  validate({ params: UserIdParam, body: SetRoleBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await UserModel.findById(param(req, 'id'));
      if (!user) throw new NotFoundError('User not found');
      const before = user.role;
      user.role = req.body.role;
      await user.save();
      await audit({
        actorId: req.user!.id,
        action: 'ADMIN_SET_ROLE',
        entityType: 'User',
        entityId: String(user._id),
        before: { role: before },
        after: { role: user.role },
        requestId: reqId(req),
      });
      res.json({ user: toPublicUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

const AuditQuery = z
  .object({
    actorId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    entityType: z.string().max(80).optional(),
    entityId: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
type AuditQuery = z.infer<typeof AuditQuery>;

adminRouter.get(
  '/audit',
  validate({ query: AuditQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await listAudit(validatedQuery<AuditQuery>(req));
      res.json({ items, nextCursor: null });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Provider health and quota consumption — 06_BACKEND §6.5.
 *
 * These were stubs returning `NOT_CONFIGURED` with "Provider clients are introduced in
 * Phase 3". That was honest when written and became false when Phase 3 shipped: the chain
 * has been contacting real providers for some time, and an admin screen reporting "no
 * provider has been contacted yet" while the catalogue is actively querying three of them
 * is worse than no screen at all.
 */
adminRouter.get('/providers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const quotas = await quotaTracker.snapshotAll();
    res.json({
      items: ALL_SATELLITE_PROVIDERS.map((p) => {
        const health = p.health();
        return { ...health, quotas: quotas.filter((q) => q.quotaKey.startsWith(`${p.name}:`)) };
      }),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/quotas', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await quotaTracker.snapshotAll();
    res.json({
      items,
      // `used: null` means the counter could not be read, which is NOT the same as zero
      // consumption — the admin screen must be able to tell those apart.
      note:
        'Soft limits, set below each provider’s real fair-use ceiling. A null `used` means ' +
        'the counter was unreachable, not that nothing has been consumed.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The labelled training set that analyst review has produced — 07_AIML §7.2.12.
 *
 * ADMIN-ONLY, and for one reason: this is the only route in the system that deliberately
 * crosses investigation boundaries. A training set is worthless confined to one case —
 * it is the accumulation across every case that makes it a set — and there is no
 * membership that spans them. The admin role is the honest boundary, and the read is
 * audited, because assembling every reviewed detection on the instance into one document
 * is exactly the access an auditor would want recorded.
 *
 * `summary` is the part that matters day to day. It answers "have we accumulated enough to
 * retrain, and against which class are we short?" — and it answers it in counts, so the
 * decision to retrain is never made on a feeling that we have "plenty by now".
 */
adminRouter.get(
  '/training-labels',
  validate({ query: TrainingLabelQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = validatedQuery<TrainingLabelQuery>(req);
      const { items, unusable, summary } = await detectionLabels(q);

      res.json({
        items,
        // Reported, not dropped. A rejection that cannot be trained on is still a decision
        // somebody made, and a set that quietly shed 40% of its input would misrepresent
        // how much review work has actually been done.
        unusable,
        summary,
        note:
          'Assembled from review actions on real detections; nothing here is generated. A ' +
          'confirmed detection is a positive, a categorised look-alike rejection is a ' +
          'negative, and an operational rejection is neither. Nothing is trained ' +
          'automatically — a retrained model must still beat the shipped detector on the ' +
          'held-out split before it ships.',
      });

      await audit({
        actorId: req.user!.id,
        action: 'ADMIN_EXPORT_TRAINING_LABELS',
        entityType: 'SpillDetection',
        entityId: q.investigationId ?? 'all',
        after: { usable: summary.usable, unusable: summary.unusable.count },
        requestId: reqId(req),
      });
    } catch (err) {
      next(err);
    }
  },
);
