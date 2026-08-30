import { z } from 'zod';
import { GeoPolygon, REJECTION_CATEGORY_IDS } from '@varuna/shared';

/** Detection request contracts — 06_BACKEND §6.4.5. Shared by the router and the OpenAPI doc. */

export const ReviewBody = z
  .object({
    action: z.enum(['CONFIRM', 'REJECT', 'EDIT', 'REOPEN']),
    note: z.string().trim().max(4000).optional(),
    /**
     * Required for REJECT, but enforced in the service rather than by this schema: the
     * requirement is conditional on the action, and a flat 400 "invalid body" would lose
     * the explanation of why a category is being asked for at all.
     */
    rejectionCategory: z.enum(REJECTION_CATEGORY_IDS).optional(),
    geometry: GeoPolygon.optional(),
  })
  .strict();
export type ReviewBody = z.infer<typeof ReviewBody>;
