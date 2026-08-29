import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../errors.js';

/**
 * Confines a request authenticated by a report token to reading one investigation.
 *
 * `authenticate()` sets `req.reportScope` when the presented credential was a report token
 * rather than a session. Everything after that point would otherwise treat the request as a
 * normal one from `req.user`, which is precisely the escalation the report token exists to
 * avoid — so this narrows it back down before any route sees it.
 *
 * Two independent conditions, both required:
 *
 *   1. **GET only.** A render reads. There is no legitimate reason for a printing browser to
 *      create a job, post a comment or trigger a re-run, and a rendered page is exactly the
 *      place a request could be smuggled in from.
 *   2. **That investigation only.** The token names one id. A path that does not contain it
 *      is refused, so the render cannot walk sideways into another team's investigation even
 *      though the underlying user might legitimately have access to it.
 *
 * The second check is a substring match on the path, which is blunt but conservative in the
 * right direction: it can only ever refuse a request that a stricter parse would allow, never
 * admit one it would refuse. Ids are 24-character hex, so a chance collision is not a
 * practical concern.
 */

/**
 * Paths a report token may read that do not name an investigation.
 *
 * Exactly one. The SPA asks who it is before it renders anything, and treats a refusal as
 * being logged out — so without this the printing browser lands on the login page and prints
 * that instead of the dossier. What it discloses is bounded by what `authenticate()` puts in
 * `req.user` for a report token: the subject id, an empty email, and the `viewer` role
 * regardless of what the real user holds.
 *
 * Kept as an exact-match list rather than a prefix so it cannot be widened by accident.
 */
const SCOPE_EXEMPT_PATHS = new Set(['/auth/me']);
export function reportScopeGuard() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const scope = req.reportScope;
    if (!scope) return next();

    if (req.method !== 'GET') {
      return next(
        new ForbiddenError(`A report token may only issue GET requests; this was a ${req.method}.`),
      );
    }

    if (SCOPE_EXEMPT_PATHS.has(req.path)) return next();

    if (!req.path.includes(scope)) {
      return next(
        new ForbiddenError('A report token may only read the investigation it was issued for.'),
      );
    }

    next();
  };
}
