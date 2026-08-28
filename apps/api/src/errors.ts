/**
 * Typed errors. The error handler (middleware/errorHandler.ts) maps these to RFC 9457
 * application/problem+json bodies (06_BACKEND §6.10).
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly type = 'about:blank',
  ) {
    super(detail ?? title);
    this.name = 'HttpError';
  }
}

export class NotFoundError extends HttpError {
  constructor(detail?: string) {
    super(404, 'Not found', detail, 'https://varuna.dev/problems/not-found');
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends HttpError {
  constructor(detail = 'Authentication required') {
    super(401, 'Unauthorized', detail, 'https://varuna.dev/problems/unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends HttpError {
  constructor(detail = 'You do not have access to this resource') {
    super(403, 'Forbidden', detail, 'https://varuna.dev/problems/forbidden');
    this.name = 'ForbiddenError';
  }
}

/**
 * A data-provider (or a whole fallback chain) is unavailable. The body states the
 * CONSEQUENCE — that is a requirement, not a nicety (06_BACKEND §6.5.1).
 */
export class ProviderUnavailable extends Error {
  constructor(
    readonly provider: string,
    readonly reason: string,
    readonly retryAt?: string | Date,
    readonly detail?: string,
    readonly attempted: Array<{ provider: string; outcome: string }> = [],
    readonly consequence?: string,
  ) {
    super(`${provider} unavailable: ${reason}`);
    this.name = 'ProviderUnavailable';
  }
}

/**
 * An object without a verifiable source was blocked from a response. This is a
 * SEVERITY-1 integrity incident, not an ordinary error (13_REAL_DATA_POLICY §13.4 L3).
 */
export class ProvenanceError extends Error {
  constructor(detail = 'An object without a verifiable source was blocked from the response.') {
    super(detail);
    this.name = 'ProvenanceError';
  }
}

export class QuotaExhausted extends Error {
  constructor(
    readonly provider: string,
    readonly used: number,
    readonly limit: number,
    readonly resetAt?: string | Date,
  ) {
    super(`${provider} quota exhausted: ${used}/${limit}`);
    this.name = 'QuotaExhausted';
  }
}
