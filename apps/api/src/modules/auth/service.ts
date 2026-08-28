import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { Role } from '@varuna/shared';
import { logger } from '../../lib/logger.js';
import { UnauthorizedError, HttpError } from '../../errors.js';
import { UserModel, RefreshTokenModel } from './model.js';
import {
  REFRESH_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  newTokenFamily,
  signAccessToken,
} from './tokens.js';
import type { PublicUser } from './schema.js';

/**
 * Argon2id parameters from 02_TRD SEC-1 / 06_BACKEND §6.9:
 * memoryCost >= 19456 KiB, timeCost >= 2, parallelism 1.
 *
 * `algorithm: 2` is `Algorithm.Argon2id`. The literal is used because that enum is an
 * ambient const enum, which `isolatedModules` forbids importing as a value. Asserted in
 * auth.test.ts against the `$argon2id$` prefix of a produced hash.
 */
const ARGON_OPTS = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A pre-computed hash of an unguessable value. Verifying against this on a missing user
 * keeps login timing roughly constant, so the endpoint does not leak which addresses are
 * registered.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= argonHash('varuna-timing-equaliser-not-a-real-password', ARGON_OPTS);
  return dummyHashPromise;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface AuthResult {
  user: PublicUser;
  tokens: SessionTokens;
}

function toPublicUser(doc: {
  _id: unknown;
  email: string;
  name: string;
  role: string;
  orgId?: unknown;
  lastLoginAt?: Date | null;
}): PublicUser {
  return {
    _id: String(doc._id),
    email: doc.email,
    name: doc.name,
    role: doc.role as Role,
    ...(doc.orgId ? { orgId: String(doc.orgId) } : {}),
    ...(doc.lastLoginAt ? { lastLoginAt: doc.lastLoginAt.toISOString() } : {}),
  };
}

async function issueSession(
  userId: string,
  email: string,
  role: Role,
  family: string,
  meta: { userAgent?: string; ip?: string },
): Promise<SessionTokens> {
  const accessToken = await signAccessToken({ sub: userId, email, role });
  const { token, hash } = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);

  await RefreshTokenModel.create({
    userId,
    tokenHash: hash,
    family,
    expiresAt: refreshExpiresAt,
    userAgent: meta.userAgent,
    ip: meta.ip,
  });

  return { accessToken, refreshToken: token, refreshExpiresAt };
}

export async function register(
  input: { email: string; password: string; name: string },
  meta: { userAgent?: string; ip?: string } = {},
): Promise<AuthResult> {
  const email = input.email.toLowerCase().trim();
  if (await UserModel.exists({ email })) {
    throw new HttpError(409, 'Email already registered', 'An account with this email exists.');
  }

  const passwordHash = await argonHash(input.password, ARGON_OPTS);
  const user = await UserModel.create({
    email,
    name: input.name,
    passwordHash,
    role: 'analyst', // 01_PRD FR-9.2 — never self-assign a privileged role
  });

  const tokens = await issueSession(
    String(user._id),
    email,
    user.role as Role,
    newTokenFamily(),
    meta,
  );
  return { user: toPublicUser(user), tokens };
}

export async function login(
  input: { email: string; password: string },
  meta: { userAgent?: string; ip?: string } = {},
): Promise<AuthResult> {
  const email = input.email.toLowerCase().trim();
  const user = await UserModel.findOne({ email }).select('+passwordHash');

  if (!user) {
    // Constant-ish time: still perform a verification against a dummy hash.
    await argonVerify(await dummyHash(), input.password).catch(() => false);
    throw new UnauthorizedError('Invalid email or password');
  }
  if (user.disabledAt) throw new UnauthorizedError('This account is disabled');

  const ok = await argonVerify(user.passwordHash, input.password).catch(() => false);
  if (!ok) throw new UnauthorizedError('Invalid email or password');

  user.lastLoginAt = new Date();
  await user.save();

  const tokens = await issueSession(
    String(user._id),
    email,
    user.role as Role,
    newTokenFamily(),
    meta,
  );
  return { user: toPublicUser(user), tokens };
}

/**
 * Rotate a refresh token.
 *
 * Presenting a token that was already used is a theft signal — the legitimate holder and
 * the attacker both hold a copy of the same value. We revoke the ENTIRE family, forcing a
 * fresh login (02_TRD SEC-2).
 */
export async function refresh(
  presentedToken: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<AuthResult> {
  const tokenHash = hashRefreshToken(presentedToken);
  const stored = await RefreshTokenModel.findOne({ tokenHash });

  if (!stored) throw new UnauthorizedError('Invalid refresh token');

  if (stored.usedAt || stored.revokedAt) {
    await RefreshTokenModel.updateMany(
      { family: stored.family, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' } },
    );
    logger.error(
      { userId: String(stored.userId), family: stored.family },
      'refresh token reuse detected — family revoked',
    );
    throw new UnauthorizedError('Refresh token reuse detected. Please sign in again.');
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedError('Refresh token expired');
  }

  const user = await UserModel.findById(stored.userId);
  if (!user || user.disabledAt) throw new UnauthorizedError('Account unavailable');

  stored.usedAt = new Date();
  await stored.save();

  const tokens = await issueSession(
    String(user._id),
    user.email,
    user.role as Role,
    stored.family, // rotation stays within the same family
    meta,
  );
  return { user: toPublicUser(user), tokens };
}

/** Revoke the presented token's whole family — a logout ends the session everywhere it rotated. */
export async function logout(presentedToken: string | undefined): Promise<void> {
  if (!presentedToken) return;
  const stored = await RefreshTokenModel.findOne({ tokenHash: hashRefreshToken(presentedToken) });
  if (!stored) return;
  await RefreshTokenModel.updateMany(
    { family: stored.family, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'LOGOUT' } },
  );
}

export async function getPublicUser(userId: string): Promise<PublicUser | null> {
  const user = await UserModel.findById(userId);
  return user ? toPublicUser(user) : null;
}

export { toPublicUser };
