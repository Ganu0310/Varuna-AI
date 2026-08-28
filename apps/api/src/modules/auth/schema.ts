import { z } from 'zod';
import { ROLES } from '@varuna/shared';

/**
 * Auth request contracts. `.strict()` so unknown keys are rejected rather than silently
 * ignored (02_TRD SEC-6, 06_BACKEND §6.9).
 */
export const RegisterBody = z
  .object({
    email: z.string().email().max(320),
    // 12 chars minimum: this is an evidence system, and the hashing cost is already high.
    password: z.string().min(12, 'password must be at least 12 characters').max(200),
    name: z.string().trim().min(1).max(120),
    orgInviteCode: z.string().trim().max(120).optional(),
  })
  .strict();
export type RegisterBody = z.infer<typeof RegisterBody>;

export const LoginBody = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(1).max(200),
  })
  .strict();
export type LoginBody = z.infer<typeof LoginBody>;

export const PublicUser = z.object({
  _id: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: z.enum(ROLES),
  orgId: z.string().optional(),
  lastLoginAt: z.string().datetime().optional(),
});
export type PublicUser = z.infer<typeof PublicUser>;
