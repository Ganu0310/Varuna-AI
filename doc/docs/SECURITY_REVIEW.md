# Security review — VARUNA

Scope from IMPLEMENTATION_PLAN.md §14.6 Phase 13: RBAC matrix, upload validation chain,
signed-URL TTLs, CSP, secret redaction, audit-log write-protection.

Reviewed against the build at the time of writing, by reading the code rather than the
specification — the point of the exercise is to find where the two disagree.

---

## Findings

### 1. The SPA document was served with no security headers — FIXED

**Severity: high.** `helmet()` sets a CSP on the API, and it was easy to read that as "the
app has a CSP". It does not. The API returns JSON, where a CSP prevents almost nothing. The
document that actually executes script in an analyst's browser is `index.html`, served by
nginx from `apps/web/nginx.conf` — and that file set no `Content-Security-Policy`, no
`X-Frame-Options`, no `X-Content-Type-Options` and no `Referrer-Policy`.

Fixed in `apps/web/nginx.conf`. Two details that are easy to get wrong and were:

- `add_header` does **not** merge into a `location` block that declares its own — nginx
  replaces the inherited set. The `/assets/` block sets `Cache-Control`, so without repeating
  them there, every JS bundle would still have been served bare.
- `always` is required, or nginx omits the headers on error responses — exactly where a
  reflected payload would surface.

The policy allows `worker-src blob:` and `style-src 'unsafe-inline'` because MapLibre GL
compiles its renderer into a blob worker and injects style rules at runtime. `script-src`
stays `'self'`: no CDN, no inline script, no `eval`.

### 2. `python-multipart` was running below its own declared floor — FIXED

**Severity: high.** `pyproject.toml` declares `python-multipart>=0.0.12`; the installed
version was **0.0.9**, carrying seven advisories. The declared constraint was not being
enforced by anything, so it drifted without a signal. This is the library that parses
multipart bodies — the code path an attacker reaches first on any form post.

Upgraded to 0.0.32, along with `python-dotenv`, `idna` and `pygments`. `pnpm check:audit`
now blocks on this, auditing the closure declared in `pyproject.toml` rather than the whole
interpreter (see below).

### 3. `vite` and `vitest` carried a high and a critical advisory — FIXED

Dev-only, but both were reachable in the developer's own environment (`vite`'s
`server.fs.deny` bypass on Windows alternate paths; arbitrary file read/execute via the
Vitest UI server). Upgraded to `vite ^6.4.3` and `vitest ^3.2.6`. Full suite re-run: 140 API
+ 53 integration + 38 web + 24 shared, all passing, plus a clean `vite build`.

Two moderate advisories remain and do not block. They are recorded rather than suppressed.

### 4. `pip-audit` run bare audits the wrong thing — FIXED (process)

Running `pip-audit` with no arguments audits the entire interpreter. On the development
machine that surfaced `youtube-dl`, `transformers`, `werkzeug` and `tornado` — none of which
VARUNA depends on. A gate that reports twenty findings nobody can act on is a gate that gets
skipped, which is worse than no gate.

`scripts/check-audit.mjs` resolves the dependency closure declared in `pyproject.toml` and
audits only that: 36 packages, currently clean.

---

## Reviewed and found sound

**RBAC.** Every route module guards its routes. `admin` appears to guard only one route by
line count, but uses `adminRouter.use(rbac('admin'))` at the router level, which covers all
five. The public surface is exactly `register`, `login`, `refresh`, `logout` and the two
health endpoints; `/auth/me` is guarded at `viewer`.

Authorisation is deliberately two-layered, and the distinction is load-bearing:
`authenticate()` populates `req.user` app-wide but authorises nothing, while `rbac()` and
`requireInvestigationAccess()` run per route. That split is what makes the global-role vs
per-investigation-role bug (D-016) impossible to reintroduce silently — a global `rbac('lead')`
would lock creators out of their own investigations, because "lead" is a role *within* an
investigation, not a rank in the system.

**Audit log.** `audit_log` refuses `updateOne`, `updateMany`, `findOneAndUpdate`, `deleteOne`
and `deleteMany` via `pre` hooks that error rather than no-op. Append-only at the application
layer as specified.

**Secret redaction.** The pino redaction list covers `authorization` and `cookie` headers plus
`password`, `token`, `client_secret`, `api_key`/`apiKey`, `access_token`, `refresh_token` and
both JWT secrets, at any depth.

**Auth tokens.** argon2id at m=19456/t=2/p=1. Access tokens are short-lived JWTs; refresh
tokens are opaque, stored hashed, and revoked as a family on reuse.

**Rate limits.** Global 100/min, auth 10/min, job creation 20/hour, catalogue 60/hour.

**Injection.** Mongo operator injection is handled by an explicit sanitiser on request input.
Note that `mongoose.set('sanitizeFilter', true)` was removed deliberately (D-015): it rewrote
the application's own `$in`/`$gte`/`$geoWithin` operators into `$eq`, silently corrupting
every geospatial query. Input sanitisation belongs at the boundary, not on internally
constructed filters.

---

## Not applicable

**Upload validation chain.** There is no upload endpoint. No `multer`, no multipart route, no
`fileFilter`. Every byte of data enters through a provider client or a CLI import that a human
runs against a file they already have. This is worth stating explicitly rather than marking
the item "passed": the control is absent because the attack surface is absent, and if an
upload endpoint is ever added, this line is the reminder that the chain must be built with it.

**Signed-URL TTLs.** Scene rasters are served through TiTiler from MinIO within the compose
network; no pre-signed URLs are minted for clients today. The only TTL-bearing credential is
the refresh-token cookie, which is `httpOnly`, `sameSite`, and expires with the token record.
This item becomes real the moment tiles are served from a public bucket.

---

## Residual risks

- **CSP `connect-src` names `localhost` origins.** Correct for docker-compose, where the
  browser reaches the API on a different port and therefore a different origin. A deployment
  behind a single load balancer should tighten this to `'self'`.
- **`style-src 'unsafe-inline'`** is required by MapLibre. It cannot be removed without
  nonce-ing the styles the library injects at runtime, which the library does not support.
- **Two moderate JS advisories** remain, in dev-only dependency paths.
- **No gitleaks run in CI yet.** `.env` is git-ignored and `check-real-data-policy.mjs` covers
  fixture integrity, but neither scans history for committed secrets.
