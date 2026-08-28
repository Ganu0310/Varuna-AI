import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';
import { HttpError, ProviderUnavailable, ProvenanceError, QuotaExhausted } from '../errors.js';

const problem = 'application/problem+json';

/** RFC 9457 problem+json — always last in the chain (06_BACKEND §6.10). */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.id;

  if (err instanceof ZodError) {
    return res
      .status(400)
      .type(problem)
      .json({
        type: 'https://varuna.dev/problems/validation',
        title: 'Request validation failed',
        status: 400,
        requestId,
        errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
  }

  if (err instanceof ProviderUnavailable) {
    return res
      .status(503)
      .type(problem)
      .json({
        type: 'https://varuna.dev/problems/data-unavailable',
        title: `${err.provider} unavailable`,
        status: 503,
        requestId,
        detail: err.detail ?? err.reason,
        attempted: err.attempted,
        consequence: err.consequence,
      });
  }

  if (err instanceof QuotaExhausted) {
    return res
      .status(429)
      .type(problem)
      .json({
        type: 'https://varuna.dev/problems/quota-exhausted',
        title: `${err.provider} quota exhausted`,
        status: 429,
        requestId,
        detail: `Consumed ${err.used} of ${err.limit}.`,
      });
  }

  if (err instanceof ProvenanceError) {
    // Severity-1: the no-fake-data guarantee has been breached somewhere upstream.
    logger.error({ err, requestId }, 'PROVENANCE VIOLATION');
    return res.status(500).type(problem).json({
      type: 'https://varuna.dev/problems/provenance',
      title: 'Data integrity violation',
      status: 500,
      requestId,
      detail: err.message,
    });
  }

  if (err instanceof HttpError) {
    return res.status(err.status).type(problem).json({
      type: err.type,
      title: err.title,
      status: err.status,
      requestId,
      detail: err.detail,
    });
  }

  logger.error({ err, requestId }, 'Unhandled error');
  return res.status(500).type(problem).json({
    type: 'about:blank',
    title: 'Internal server error',
    status: 500,
    requestId,
  });
}
