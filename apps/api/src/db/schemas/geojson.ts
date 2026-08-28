import { Schema } from 'mongoose';

/**
 * GeoJSON sub-schemas for Mongoose. EPSG:4326, coordinate order [lon, lat] (02_TRD TR-2).
 *
 * The winding validator is load-bearing: MongoDB interprets a wrongly-wound `2dsphere`
 * polygon as its COMPLEMENT — the entire globe minus the intended area — so a `$geoWithin`
 * against it matches nearly every AIS position on Earth (06_BACKEND §6.3.2, 12 F-10).
 * Callers normalise winding with the Turf `rewindPolygon` helper on write; this validator is
 * the backstop that rejects anything that slipped through.
 */

const lonLatValid = (c: number[]): boolean =>
  Array.isArray(c) && c.length >= 2 && c[0]! >= -180 && c[0]! <= 180 && c[1]! >= -90 && c[1]! <= 90;

export const PointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: lonLatValid,
        message: 'coordinates must be [longitude, latitude] within valid ranges',
      },
    },
  },
  { _id: false },
);

export const LineStringSchema = new Schema(
  {
    type: { type: String, enum: ['LineString'], required: true },
    coordinates: {
      type: [[Number]],
      required: true,
      validate: {
        validator: (pts: number[][]) => pts.length >= 2 && pts.every(lonLatValid),
        message: 'LineString needs >= 2 valid [lon, lat] positions',
      },
    },
  },
  { _id: false },
);

export function isClosedRing(ring: number[][]): boolean {
  if (ring.length < 4) return false;
  const a = ring[0]!;
  const b = ring[ring.length - 1]!;
  return a[0] === b[0] && a[1] === b[1];
}

/** Shoelace signed area in coordinate space. Positive => counter-clockwise. */
export function ringSignedArea(ring: number[][]): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    s += x1! * y2! - x2! * y1!;
  }
  return s / 2;
}

/**
 * GeoJSON right-hand rule (RFC 7946 §3.1.6): exterior ring counter-clockwise, holes
 * clockwise. This is also what MongoDB's `2dsphere` expects for a "small" polygon.
 */
export function isRightHandWound(rings: number[][][]): boolean {
  if (rings.length === 0) return false;
  if (ringSignedArea(rings[0]!) <= 0) return false; // exterior must be CCW
  for (let i = 1; i < rings.length; i++) {
    if (ringSignedArea(rings[i]!) >= 0) return false; // holes must be CW
  }
  return true;
}

export const PolygonSchema = new Schema(
  {
    type: { type: String, enum: ['Polygon'], required: true },
    coordinates: {
      type: [[[Number]]],
      required: true,
      validate: [
        {
          validator: (rings: number[][][]) =>
            rings.length >= 1 && rings.every((r) => r.every(lonLatValid)),
          message: 'polygon positions must be [lon, lat] within valid ranges',
        },
        {
          validator: (rings: number[][][]) => rings.every(isClosedRing),
          message: 'polygon rings must be closed (first position === last position)',
        },
        {
          validator: isRightHandWound,
          message:
            'polygon rings must follow the right-hand rule (exterior CCW, holes CW). ' +
            'A wrongly-wound 2dsphere polygon matches the whole globe — see 06_BACKEND §6.3.2.',
        },
      ],
    },
  },
  { _id: false },
);
