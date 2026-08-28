import type { Request, Response, NextFunction } from 'express';

/**
 * Strips keys beginning with `$` or containing `.` from request bodies and route params, to
 * prevent NoSQL operator injection (06_BACKEND §6.9 SEC-8, 02_TRD SEC-8).
 *
 * Note: `express-mongo-sanitize` mutates `req.query`, which is read-only in Express 5. Query
 * strings are validated by Zod at the boundary (`validate` middleware) and never spread into
 * a query object, so this middleware covers body + params only. See IMPLEMENTATION_PLAN
 * §14.4 (custom lint rule: no user string concatenated into a query object).
 */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith('$') || k.includes('.')) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

export function sanitizeMongo() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.body && typeof req.body === 'object') req.body = scrub(req.body);
    if (req.params && typeof req.params === 'object') {
      req.params = scrub(req.params) as Request['params'];
    }
    next();
  };
}
