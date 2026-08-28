import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ROLES } from '@varuna/shared';
import { rbac } from '../../middleware/rbac.js';
import { validate, validatedQuery, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { NotFoundError } from '../../errors.js';
import { audit, listAudit } from '../audit/service.js';
import { UserModel } from '../auth/model.js';
import { toPublicUser } from '../auth/service.js';

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
 * Provider health and quota. Real per-provider circuit-breaker state and quota counters
 * land with the ProviderClient in Phase 3 (06_BACKEND §6.5); until then this reports the
 * honest truth — that no providers are wired yet — rather than inventing green ticks.
 */
adminRouter.get('/providers', (_req: Request, res: Response) => {
  res.json({
    items: [],
    status: 'NOT_CONFIGURED',
    detail: 'Provider clients are introduced in Phase 3. No provider has been contacted yet.',
  });
});

adminRouter.get('/quotas', (_req: Request, res: Response) => {
  res.json({
    items: [],
    status: 'NOT_CONFIGURED',
    detail: 'Quota accounting is introduced with the provider clients in Phase 3.',
  });
});
