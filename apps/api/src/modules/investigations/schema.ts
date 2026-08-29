import { z } from 'zod';
import { GeoPolygon, MAX_WINDOW_DAYS, ROLES } from '@varuna/shared';

/** Investigation request contracts — 06_BACKEND §6.4.2. All `.strict()`. */

export const CreateInvestigationBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
    incidentReference: z.string().trim().max(200).optional(),
    aoi: GeoPolygon,
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
    /** Optional known/reported incident time — seeds the release-window prior (01_PRD A1). */
    reportedIncidentAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((v) => new Date(v.windowEnd) > new Date(v.windowStart), {
    message: 'windowEnd must be after windowStart',
    path: ['windowEnd'],
  })
  .refine(
    (v) =>
      (new Date(v.windowEnd).getTime() - new Date(v.windowStart).getTime()) / 86_400_000 <=
      MAX_WINDOW_DAYS,
    { message: `time window must not exceed ${MAX_WINDOW_DAYS} days`, path: ['windowEnd'] },
  );
export type CreateInvestigationBody = z.infer<typeof CreateInvestigationBody>;

export const UpdateInvestigationBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).optional(),
    incidentReference: z.string().trim().max(200).optional(),
    aoi: GeoPolygon.optional(),
    windowStart: z.string().datetime().optional(),
    windowEnd: z.string().datetime().optional(),
    reportedIncidentAt: z.string().datetime().optional(),
  })
  .strict();
export type UpdateInvestigationBody = z.infer<typeof UpdateInvestigationBody>;

export const ListInvestigationsQuery = z
  .object({
    status: z.string().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ListInvestigationsQuery = z.infer<typeof ListInvestigationsQuery>;

export const AddMemberBody = z.object({ userId: z.string().min(1), role: z.enum(ROLES) }).strict();
export type AddMemberBody = z.infer<typeof AddMemberBody>;

export const IdParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'invalid id') });

// ── comments (06_BACKEND §6.4.2) ──────────────────────────────────────

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i);
const SubjectType = z.enum(['DETECTION', 'CANDIDATE', 'ORIGIN', 'SCENE']);

/**
 * A note is about the whole investigation or about one named object — never half of each. A
 * subject type with no id points at nothing; an id with no type cannot be resolved.
 */
export const CommentBody = z
  .object({
    body: z.string().trim().min(1, 'a comment cannot be empty').max(4000),
    subjectType: SubjectType.optional(),
    subjectId: ObjectIdString.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.subjectType) === Boolean(v.subjectId), {
    message: 'subjectType and subjectId must be given together, or neither',
  });

export const CommentQuery = z
  .object({ subjectType: SubjectType.optional(), subjectId: ObjectIdString.optional() })
  .strict()
  .refine((v) => Boolean(v.subjectType) === Boolean(v.subjectId), {
    message: 'subjectType and subjectId must be given together, or neither',
  });

export const CommentParams = z.object({ id: ObjectIdString, commentId: ObjectIdString }).strict();
