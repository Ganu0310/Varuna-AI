import type { Request, Response, NextFunction } from 'express';
import type { ZodTypeAny } from 'zod';

/**
 * Zod boundary validation (02_TRD SEC-6, 06_BACKEND §6.2).
 *
 * The parsed value REPLACES the raw input, so downstream code can only ever see data that
 * satisfied the schema. Schemas are `.strict()`, so unknown keys are rejected rather than
 * silently carried. A `ZodError` is turned into RFC 9457 problem+json by `errorHandler`.
 *
 * `req.query` is read-only in Express 5, so the validated query is exposed as
 * `req.validatedQuery` instead of being assigned back.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validatedQuery?: unknown;
    }
  }
}

export function validate(schemas: { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.params) req.params = schemas.params.parse(req.params) as Request['params'];
      if (schemas.query) req.validatedQuery = schemas.query.parse(req.query);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Typed accessor for the validated query, to avoid casts at every call site. */
export function validatedQuery<T>(req: Request): T {
  return req.validatedQuery as T;
}

/**
 * Typed accessor for a validated route param. Express 5 types params as
 * `string | string[]`; anything that passed a Zod string schema is a string.
 */
export function param(req: Request, name: string): string {
  const v = (req.params as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : String(v ?? '');
}
