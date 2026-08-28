import type { Request, Response, NextFunction } from 'express';
import { ROLE_RANK, type Role } from '@varuna/shared';
import { UnauthorizedError, ForbiddenError, NotFoundError } from '../errors.js';
import { InvestigationModel } from '../modules/investigations/model.js';

/**
 * Role gate — **deny by default** (02_TRD SEC-3, 01_PRD FR-9.2).
 * Roles are ranked: viewer < analyst < lead < admin. `rbac('analyst')` admits analyst and
 * above. Every non-public route must be wrapped.
 */
export function rbac(minimum: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
    if (ROLE_RANK[req.user.role] < ROLE_RANK[minimum]) {
      return next(new ForbiddenError(`Requires role "${minimum}" or higher`));
    }
    next();
  };
}

/**
 * Resource-level ownership check for investigation-scoped routes.
 *
 * Returns 404 rather than 403 for an investigation the caller cannot see, so the endpoint
 * does not confirm that an id exists to someone with no access. Admins bypass; the
 * creator and listed members are admitted at their member role.
 */
export async function canAccessInvestigation(
  user: { id: string; role: Role },
  investigationId: string,
  minimum: Role = 'viewer',
): Promise<boolean> {
  if (user.role === 'admin') return true;

  const inv = await InvestigationModel.findOne({ _id: investigationId, deletedAt: null })
    .select({ createdBy: 1, members: 1 })
    .lean();
  if (!inv) return false;

  if (String(inv.createdBy) === user.id) return true;

  const member = (inv.members ?? []).find((m) => String(m.userId) === user.id);
  if (!member) return false;
  return ROLE_RANK[member.role as Role] >= ROLE_RANK[minimum];
}

/** Express wrapper around `canAccessInvestigation`, reading `:id` (or `:investigationId`). */
export function requireInvestigationAccess(minimum: Role = 'viewer') {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
    const params = req.params as Record<string, unknown>;
    const raw = params.id ?? params.investigationId;
    const id = typeof raw === 'string' ? raw : undefined;
    if (!id) return next(new NotFoundError('No investigation id in the route'));
    const ok = await canAccessInvestigation(req.user, id, minimum);
    if (!ok) return next(new NotFoundError('Investigation not found'));
    next();
  };
}
