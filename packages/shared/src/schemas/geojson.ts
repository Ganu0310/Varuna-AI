import { z } from 'zod';

/**
 * GeoJSON sub-schemas. Storage geometry is EPSG:4326, coordinate order [longitude, latitude],
 * right-hand-rule winding for polygons (02_TRD TR-2).
 *
 * Winding (right-hand rule) is normalised with @turf/rewind on write and validated at the
 * Mongoose layer — see 06_BACKEND §6.3.2. A wrongly-wound polygon is interpreted by MongoDB
 * as the COMPLEMENT of the intended area (the whole globe minus your slick), so a $geoWithin
 * would match every AIS position on Earth. This module validates structure; winding is
 * enforced downstream where turf is available.
 */

export const Position = z
  .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .rest(z.number()); // allow optional elevation as a 3rd element, ignored

export type Position = z.infer<typeof Position>;

export const GeoPoint = z.object({
  type: z.literal('Point'),
  coordinates: Position,
});
export type GeoPoint = z.infer<typeof GeoPoint>;

export const GeoLineString = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(Position).min(2),
});
export type GeoLineString = z.infer<typeof GeoLineString>;

const isClosedRing = (ring: Position[]): boolean => {
  if (ring.length < 4) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return !!first && !!last && first[0] === last[0] && first[1] === last[1];
};

const LinearRing = z.array(Position).min(4).refine(isClosedRing, {
  message: 'polygon rings must be closed (first position === last position)',
});

export const GeoPolygon = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(LinearRing).min(1),
});
export type GeoPolygon = z.infer<typeof GeoPolygon>;

export const GeoMultiPolygon = z.object({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(z.array(LinearRing).min(1)).min(1),
});
export type GeoMultiPolygon = z.infer<typeof GeoMultiPolygon>;

export const GeoBBox = z.tuple([z.number(), z.number(), z.number(), z.number()]); // [west, south, east, north]
export type GeoBBox = z.infer<typeof GeoBBox>;
