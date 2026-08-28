import { describe, it, expect } from 'vitest';
import { GeoPoint, GeoPolygon, GeoLineString } from './geojson.js';

describe('GeoJSON sub-schemas — 02_TRD TR-2 ([lon, lat], closed rings)', () => {
  it('accepts a valid point in [lon, lat] order', () => {
    expect(GeoPoint.safeParse({ type: 'Point', coordinates: [72.87, 19.07] }).success).toBe(true);
  });

  it('rejects a point with latitude out of range (a [lat, lon] swap in the tropics survives; a polar one does not)', () => {
    // 100 as latitude is impossible — catches an obvious [lat, lon] swap
    expect(GeoPoint.safeParse({ type: 'Point', coordinates: [19.07, 100] }).success).toBe(false);
  });

  it('accepts a closed polygon ring', () => {
    const square = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
      ],
    };
    expect(GeoPolygon.safeParse(square).success).toBe(true);
  });

  it('rejects an unclosed polygon ring', () => {
    const open = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ],
      ],
    };
    const res = GeoPolygon.safeParse(open);
    expect(res.success).toBe(false);
  });

  it('requires at least two positions for a line string', () => {
    expect(GeoLineString.safeParse({ type: 'LineString', coordinates: [[0, 0]] }).success).toBe(
      false,
    );
    expect(
      GeoLineString.safeParse({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }).success,
    ).toBe(true);
  });
});
