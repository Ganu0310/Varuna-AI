import { z } from 'zod';

/** Discover request contracts — 06_BACKEND §6.4.10. All `.strict()`. */

export const DiscoverDetectionsQuery = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    regionId: z.string().min(1).max(80).optional(),
  })
  .strict()
  .refine((v) => new Date(v.to) > new Date(v.from), {
    message: 'to must be after from',
    path: ['to'],
  })
  .refine(
    (v) => (new Date(v.to).getTime() - new Date(v.from).getTime()) / 86_400_000 <= 90,
    // A generous cap, not the 30-day investigation-window limit: Discover is browsing
    // ALREADY-COMPUTED results, not commissioning new work, so a wider look-back costs one
    // extra query rather than a live provider read.
    { message: 'the period must not exceed 90 days', path: ['to'] },
  );
export type DiscoverDetectionsQuery = z.infer<typeof DiscoverDetectionsQuery>;

/** Same window rules as the detections query — see its own comments. */
export const DiscoverOverpassesQuery = DiscoverDetectionsQuery;
export type DiscoverOverpassesQuery = z.infer<typeof DiscoverOverpassesQuery>;

export const TriggerSweepBody = z
  .object({
    /** One watch region, or every one of them when omitted. */
    regionId: z.string().min(1).max(80).optional(),
  })
  .strict();
export type TriggerSweepBody = z.infer<typeof TriggerSweepBody>;

export const AdoptDetectionParams = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

export const AdoptDetectionBody = z
  .object({
    /** Adopt into an EXISTING investigation instead of creating one. Omit for the primary
     * "start investigating" path, which creates a new investigation from the scene. */
    investigationId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
  })
  .strict();
export type AdoptDetectionBody = z.infer<typeof AdoptDetectionBody>;
