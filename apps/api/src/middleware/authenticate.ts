import type { Request, Response, NextFunction } from 'express';
import type { Role } from '@varuna/shared';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { verifyReportToken } from '../modules/reports/reportToken.js';

export const ACCESS_COOKIE = 'varuna_access';
export const REFRESH_COOKIE = 'varuna_refresh';
export const REPORT_COOKIE = 'varuna_report';

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
      /**
       * Set when the credential was a report token rather than a session. `reportScopeGuard`
       * reads it to confine the request to GETs against this one investigation.
       */
      reportScope?: string;
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
      if (claims) {
        req.user = { id: claims.sub, email: claims.email, role: claims.role };
        return next();
      }
    }

    // A report token, presented by the headless browser that prints the dossier. Tried only
    // after the access token fails, so a real session is never downgraded to a scoped one.
    // The role is fixed at `viewer` regardless of who the render is attributed to: the token
    // must not carry a lead's or admin's permissions into a subprocess.
    const reportToken = (req.cookies as Record<string, string> | undefined)?.[REPORT_COOKIE];
    if (reportToken) {
      const claims = await verifyReportToken(reportToken);
      if (claims) {
        req.user = { id: claims.sub, email: '', role: 'viewer' };
        req.reportScope = claims.investigationId;
      }
    }

    next();
  };
}
