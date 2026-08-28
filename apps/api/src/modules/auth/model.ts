import { Schema, model, type InferSchemaType } from 'mongoose';
import { ROLES } from '@varuna/shared';

/**
 * Users and refresh tokens (06_BACKEND §6.9, 02_TRD SEC-1/SEC-2).
 *
 * `passwordHash` is argon2id and is `select: false` — it is never returned by a query
 * unless explicitly asked for, so it cannot leak into an API response by accident.
 */
const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, default: 'analyst' },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation' },
    disabledAt: { type: Date, default: null },
    lastLoginAt: Date,
  },
  { timestamps: true, collection: 'users' },
);

// The unique index comes from `unique: true` on the field above; re-declaring it here
// would create a duplicate-index warning at boot.

/**
 * Refresh tokens are stored ONLY as a SHA-256 hash, rotate on every use, and carry a
 * `family` id. Presenting an already-rotated token is a theft signal: the whole family is
 * revoked (06_BACKEND §6.9, 02_TRD SEC-2).
 */
const RefreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: String,
    userAgent: String,
    ip: String,
  },
  { timestamps: true, collection: 'refresh_tokens' },
);

// Expire documents shortly after the token itself expires; revocation state is not needed
// once the token could no longer be accepted anyway.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export type User = InferSchemaType<typeof UserSchema>;
export type RefreshToken = InferSchemaType<typeof RefreshTokenSchema>;
export const UserModel = model('User', UserSchema);
export const RefreshTokenModel = model('RefreshToken', RefreshTokenSchema);
