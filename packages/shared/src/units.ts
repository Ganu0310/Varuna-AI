/**
 * Branded units — the single largest source of silent geospatial bugs is coordinate-order
 * and unit confusion. We eliminate it at compile time.
 *
 * Rules (05_FRONTEND §5.2, enforced in review + lint):
 *  - No function accepts a bare `number` for a distance, area, speed or bearing.
 *  - Any conversion between units happens in exactly one place (this file).
 *  - `LonLat` is the only accepted coordinate pair type; `[lat, lon]` cannot type-check.
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type Longitude = Brand<number, 'Longitude'>;
export type Latitude = Brand<number, 'Latitude'>;
export type Kilometres = Brand<number, 'Kilometres'>;
export type Metres = Brand<number, 'Metres'>;
export type SquareKm = Brand<number, 'SquareKm'>;
export type Knots = Brand<number, 'Knots'>;
export type DegreesTrue = Brand<number, 'DegreesTrue'>;
/** ISO-8601 UTC string with an explicit `Z`. Storage + transport format (02_TRD TR-1). */
export type UtcIso = Brand<string, 'UtcIso'>;

export const lon = (n: number): Longitude => {
  if (!Number.isFinite(n) || n < -180 || n > 180)
    throw new RangeError(`Longitude out of range: ${n}`);
  return n as Longitude;
};

export const lat = (n: number): Latitude => {
  if (!Number.isFinite(n) || n < -90 || n > 90) throw new RangeError(`Latitude out of range: ${n}`);
  return n as Latitude;
};

export const km = (n: number): Kilometres => {
  if (!Number.isFinite(n) || n < 0)
    throw new RangeError(`Kilometres must be finite and >= 0: ${n}`);
  return n as Kilometres;
};

export const metres = (n: number): Metres => {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`Metres must be finite and >= 0: ${n}`);
  return n as Metres;
};

export const sqKm = (n: number): SquareKm => {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`SquareKm must be finite and >= 0: ${n}`);
  return n as SquareKm;
};

export const knots = (n: number): Knots => {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`Knots must be finite and >= 0: ${n}`);
  return n as Knots;
};

/** Normalises to [0, 360). */
export const degTrue = (n: number): DegreesTrue => {
  if (!Number.isFinite(n)) throw new RangeError(`DegreesTrue must be finite: ${n}`);
  return (((n % 360) + 360) % 360) as DegreesTrue;
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
export const utcIso = (s: string): UtcIso => {
  if (!ISO_UTC.test(s) || Number.isNaN(Date.parse(s))) {
    throw new RangeError(`Not an ISO-8601 UTC timestamp with explicit Z: ${s}`);
  }
  return s as UtcIso;
};

export const toUtcIso = (d: Date): UtcIso => d.toISOString() as UtcIso;

/** GeoJSON order is ALWAYS [lon, lat]. This type makes the mistake unrepresentable. */
export type LonLat = readonly [Longitude, Latitude];

export const lonLat = (longitude: number, latitude: number): LonLat => [
  lon(longitude),
  lat(latitude),
];

export const KM_PER_NAUTICAL_MILE = 1.852;
export const nmToKm = (nm: number): Kilometres => km(nm * KM_PER_NAUTICAL_MILE);
export const kmToNm = (k: Kilometres): number => (k as number) / KM_PER_NAUTICAL_MILE;
