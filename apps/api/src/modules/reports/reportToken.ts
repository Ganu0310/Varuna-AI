import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { env } from '../../env.js';

/**
 * A short-lived, read-only, single-investigation credential — 06_BACKEND §6.8.
 *
 * The PDF is produced by pointing a headless browser at the dossier route and printing what
 * it renders. That browser has to authenticate, and the obvious shortcut — mint the
 * requesting user a normal access token and hand it over — gives a subprocess a full session
 * with that user's role for fifteen minutes. If the render ever loads attacker-influenced
 * content, that session is what it gets.
 *
 * So this token is deliberately not a session. It carries the investigation it may read,
 * expires in ninety seconds, and is refused on anything but a GET (`reportScopeGuard`). It
 * names the user it was minted for only so the audit log records who caused the read, never
 * to grant that user's other permissions.
 *
 * Separate audience from the access token, so neither verifier will ever accept the other's
 * tokens no matter how the cookie is presented.
 */

const key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

/** Long enough for a cold browser start and a heavy map render; short enough to be useless if it leaks. */
export const REPORT_TOKEN_TTL_SECONDS = 90;

const AUDIENCE = 'varuna-report';

export interface ReportClaims {
  /** The user the render is attributed to. Not a grant of that user's access. */
  sub: string;
  /** The one investigation this token can read. */
  investigationId: string;
}

export async function signReportToken(claims: ReportClaims): Promise<string> {
  return new SignJWT({ inv: claims.investigationId, scope: 'report:read' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer('varuna')
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${REPORT_TOKEN_TTL_SECONDS}s`)
    .setJti(randomUUID())
    .sign(key);
}

export async function verifyReportToken(token: string): Promise<ReportClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: 'varuna',
      audience: AUDIENCE,
    });
    if (!payload.sub || typeof payload.inv !== 'string') return null;
    if (payload.scope !== 'report:read') return null;
    return { sub: payload.sub, investigationId: payload.inv };
  } catch {
    return null;
  }
}
