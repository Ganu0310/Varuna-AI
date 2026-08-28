import { describe, it, expect } from 'vitest';
import { lon, lat, lonLat, degTrue, utcIso, toUtcIso, nmToKm } from './units.js';

describe('branded coordinate constructors', () => {
  it('accepts in-range longitude and latitude', () => {
    expect(lon(72.87765)).toBe(72.87765);
    expect(lat(19.07283)).toBe(19.07283);
    expect(lonLat(72.8, 19.0)).toEqual([72.8, 19.0]);
  });

  it('rejects out-of-range longitude', () => {
    expect(() => lon(181)).toThrow(RangeError);
    expect(() => lon(-181)).toThrow(RangeError);
    expect(() => lon(Number.NaN)).toThrow(RangeError);
  });

  it('rejects out-of-range latitude', () => {
    expect(() => lat(91)).toThrow(RangeError);
    expect(() => lat(-90.0001)).toThrow(RangeError);
  });
});

describe('degTrue', () => {
  it('normalises to [0, 360)', () => {
    expect(degTrue(0)).toBe(0);
    expect(degTrue(360)).toBe(0);
    expect(degTrue(-90)).toBe(270);
    expect(degTrue(450)).toBe(90);
  });
});

describe('utcIso', () => {
  it('accepts ISO-8601 with explicit Z', () => {
    expect(utcIso('2023-08-14T06:12:47Z')).toBe('2023-08-14T06:12:47Z');
    expect(utcIso('2023-08-14T06:12:47.123Z')).toBe('2023-08-14T06:12:47.123Z');
  });

  it('rejects timestamps without Z or with an offset', () => {
    expect(() => utcIso('2023-08-14T06:12:47')).toThrow(RangeError);
    expect(() => utcIso('2023-08-14T06:12:47+05:30')).toThrow(RangeError);
    expect(() => utcIso('2023-08-14 06:12:47Z')).toThrow(RangeError);
  });

  it('round-trips a Date', () => {
    const d = new Date('2023-08-14T06:12:47.000Z');
    expect(utcIso(toUtcIso(d))).toBe('2023-08-14T06:12:47.000Z');
  });
});

describe('unit conversion lives in one place', () => {
  it('nautical miles to km', () => {
    expect(nmToKm(1)).toBeCloseTo(1.852, 6);
  });
});
