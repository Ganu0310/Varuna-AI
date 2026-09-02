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

function send(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${BASE}/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      // Minted per attempt, not per call: a retried request is a different request, and a
      // shared id would make the two indistinguishable in the API log.
      'X-Request-Id': crypto.randomUUID(),
      ...init.headers,
    },
  });
}

/**
 * Routes that must never trigger a refresh.
 *
 * `/auth/refresh` would recurse into itself; the other three are the endpoints that
 * ESTABLISH a session, so a 401 from them means the credentials were wrong, not that the
 * access token aged out. `/auth/me` is deliberately absent — it is the first call a reloaded
 * tab makes, and it is exactly the one worth retrying.
 */
const NO_REFRESH = new Set(['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout']);

let refreshInFlight: Promise<boolean> | null = null;
let refreshExhausted = false;

/**
 * Trade the refresh cookie for a fresh access token.
 *
 * The access token lives 15 minutes (`ACCESS_TTL_SECONDS`) and the refresh cookie lives 7
 * days. Nothing used to spend the second one, so a tab left open through a meeting started
 * answering 401 to everything and dumped the analyst back on the login form mid-case.
 *
 * ONE refresh at a time, and this is not merely an optimisation. A screen has several
 * queries in flight at once; letting each 401 start its own refresh would present the same
 * token twice, and the API treats a spent refresh token as a stolen one — it revokes the
 * entire family. Racing here would log the user out for real.
 */
async function refreshSession(): Promise<boolean> {
  if (refreshExhausted) return false;
  const pending = (refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Request-Id': crypto.randomUUID() },
      });
      // A visitor who never had a session gets one failed attempt, not one per query. The
      // refresh route is rate-limited, and hammering it would lock out the login that follows.
      refreshExhausted = !res.ok;
      return res.ok;
    } catch {
      refreshExhausted = true;
      return false;
    } finally {
      refreshInFlight = null;
    }
  })());
  return pending;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await send(path, init);

  // One silent rotation, then one retry. Only after that does a 401 mean "sign in again".
  if (res.status === 401 && !NO_REFRESH.has(path) && (await refreshSession())) {
    res = await send(path, init);
  }

  if (res.status === 401) {
    const problem = (await res.json().catch(() => null)) as ProblemDetails | null;
    onUnauthorised();
    throw new AuthError(problem);
  }

  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as ProblemDetails | null;
    throw new ApiError(res.status, problem, problem?.title ?? res.statusText);
  }

  // A clean response proves the session is alive again, so an earlier failed refresh stops
  // standing in the way of the next one.
  refreshExhausted = false;

  if (res.status === 204) return undefined as T;

  const data = (await res.json()) as unknown;
  assertProvenance(data); // throws before the data can reach a component
  return data as T;
}

/**
 * Download an export as a file.
 *
 * Fetched as a blob rather than linked with `<a href download>`. The API can sit on another
 * origin (`VITE_API_URL`), where a plain navigation would not reliably carry the session
 * cookie — and when it failed the browser would simply navigate to a JSON error page,
 * losing the current view and telling the analyst nothing useful. Going through fetch keeps
 * the failure in the app, where it can be shown.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (!res.ok) {
    let problem: ProblemDetails | null = null;
    try {
      problem = (await res.json()) as ProblemDetails;
    } catch {
      /* a non-JSON error body is still an error */
    }
    throw new ApiError(res.status, problem, problem?.title ?? `Export failed (${res.status})`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Released on the next tick: revoking synchronously can cancel the download in some
  // browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
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
