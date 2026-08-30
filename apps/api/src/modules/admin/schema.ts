import { z } from 'zod';

/** Admin request contracts — 06_BACKEND §6.4.10. Shared by the router and the OpenAPI doc. */

export const TrainingLabelQuery = z
  .object({
    /** Scope to one case. Omitted, the export spans every investigation on the instance. */
    investigationId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    limit: z.coerce.number().int().min(1).max(10_000).default(2000),
  })
  .strict();
export type TrainingLabelQuery = z.infer<typeof TrainingLabelQuery>;
