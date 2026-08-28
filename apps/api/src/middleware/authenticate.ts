import type { Request, Response, NextFunction } from 'express';
import type { Role } from '@varuna/shared';
import { verifyAccessToken } from '../modules/auth/tokens.js';

export const ACCESS_COOKIE = 'varuna_access';
export const REFRESH_COOKIE = 'varuna_refresh';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Populates `req.user` from the access-token cookie. It **authenticates, it does not
 * authorise** — an unauthenticated request continues and is stopped by `rbac()` on the
 * route (06_BACKEND §6.2, deny-by-default lives in rbac.ts).
 */
export function authenticate() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    if (token) {
      const claims = await verifyAccessToken(token);
      if (claims) req.user = { id: claims.sub, email: claims.email, role: claims.role };
    }
    next();
  };
}
