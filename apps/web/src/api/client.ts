import { assertProvenance } from '../lib/provenance.ts';

/**
 * The single fetch wrapper — 05_FRONTEND §5.6.1.
 *
 * Every response passes `assertProvenance` BEFORE it can reach a component, so an
 * unsourced object throws here rather than being rendered (13_REAL_DATA_POLICY §13.4 L4).
 * Credentials are cookies; the client never holds a token or a provider key
 * (02_TRD TR-7 / SEC-2).
 */
const BASE = import.meta.env.VITE_API_URL ?? '';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  requestId?: string;
  errors?: Array<{ path: string; message: string }>;
  attempted?: Array<{ provider: string; outcome: string }>;
  consequence?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages for a form, keyed by path. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.problem?.errors ?? []).map((e) => [e.path, e.message]));
  }
}

export class AuthError extends ApiError {
  constructor(problem: ProblemDetails | null) {
    super(401, problem, problem?.detail ?? 'Not authenticated');
    this.name = 'AuthError';
  }
}

type UnauthorisedHandler = () => void;
let onUnauthorised: UnauthorisedHandler = () => {};
export function setUnauthorisedHandler(fn: UnauthorisedHandler): void {
  onUnauthorised = fn;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': crypto.randomUUID(),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    const problem = (await res.json().catch(() => null)) as ProblemDetails | null;
    onUnauthorised();
    throw new AuthError(problem);
  }

  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as ProblemDetails | null;
    throw new ApiError(res.status, problem, problem?.title ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;

  const data = (await res.json()) as unknown;
  assertProvenance(data); // throws before the data can reach a component
  return data as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};
