import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@varuna/shared';
import { env } from '../../env.js';

/**
 * JWT access tokens + opaque refresh tokens (02_TRD SEC-2, 06_BACKEND §6.9).
 *
 * Access token : JWT, 15 minutes, signed HS256.
 * Refresh token: an opaque 256-bit random value — NOT a JWT. It is only ever stored as a
 *                SHA-256 hash server-side, so a database leak does not yield usable tokens.
 */
export const ACCESS_TTL_SECONDS = 15 * 60; // 15 min
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessClaims {
  sub: string;
  email: string;
  role: Role;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer('varuna')
    .setAudience('varuna-api')
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .setJti(randomUUID())
    .sign(accessKey);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, accessKey, {
      issuer: 'varuna',
      audience: 'varuna-api',
    });
    if (!payload.sub || typeof payload.role !== 'string') return null;
    return {
      sub: payload.sub,
      email: String(payload.email ?? ''),
      role: payload.role as Role,
    };
  } catch {
    return null;
  }
}

/** A refresh token is opaque randomness; only its hash is ever persisted. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newTokenFamily(): string {
  return randomUUID();
}
