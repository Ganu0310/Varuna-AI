import { z } from 'zod';
import { GeoPolygon } from '@varuna/shared';

/**
 * Catalogue query — 06_BACKEND §6.4.3.
 * The AOI arrives urlencoded as GeoJSON; a bad polygon must fail at the boundary rather
 * than being sent to a provider.
 */
export const CatalogueSearchQuery = z
  .object({
    /** URL-encoded GeoJSON Polygon. */
    aoi: z.string().min(2),
    from: z.string().datetime(),
    to: z.string().datetime(),
    platforms: z.string().optional(),
    orbitDirection: z.enum(['ASCENDING', 'DESCENDING']).optional(),
    polarisation: z.enum(['VV', 'VH', 'HH', 'HV']).optional(),
    maxCloud: z.coerce.number().min(0).max(100).optional(),
    provider: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(250).default(100),
  })
  .strict()
  .refine((v) => new Date(v.to) > new Date(v.from), {
    message: 'to must be after from',
    path: ['to'],
  });
export type CatalogueSearchQuery = z.infer<typeof CatalogueSearchQuery>;

/** Parse the `aoi` query parameter into a validated Polygon. */
export function parseAoi(raw: string): z.infer<typeof GeoPolygon> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new z.ZodError([
      { code: 'custom', path: ['aoi'], message: 'aoi must be URL-encoded GeoJSON' },
    ]);
  }
  const parsed = GeoPolygon.safeParse(json);
  if (!parsed.success) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['aoi'],
        message: `aoi must be a GeoJSON Polygon with closed rings and [lon, lat] positions: ${parsed.error.issues[0]?.message ?? ''}`,
      },
    ]);
  }
  return parsed.data;
}
