import { describe, it, expect } from 'vitest';
import { formatUtc, formatLat, formatLon, formatAreaKm2, formatDurationMin } from './format.ts';

/** The typographic rules are error-prevention measures — 04_UIUX §4.2.2. */
describe('formatUtc (T4)', () => {
  it('renders ISO order with an explicit Z', () => {
    expect(formatUtc('2023-08-14T06:12:47.000Z')).toBe('2023-08-14 06:12:47 Z');
  });
  it('handles missing and invalid values without inventing a time', () => {
    expect(formatUtc(null)).toBe('—');
    expect(formatUtc('not-a-date')).toBe('—');
  });
});

describe('coordinates (T3)', () => {
  it('uses hemisphere letters, not signs, at 5 dp', () => {
    expect(formatLat(19.07283)).toBe('19.07283° N');
    expect(formatLat(-19.07283)).toBe('19.07283° S');
    expect(formatLon(72.87765)).toBe('072.87765° E');
    expect(formatLon(-72.87765)).toBe('072.87765° W');
  });
});

describe('units are always rendered (T5)', () => {
  it('area', () => {
    expect(formatAreaKm2(18.42)).toBe('18.42 km²');
    expect(formatAreaKm2(1920)).toBe('1,920 km²');
    expect(formatAreaKm2(null)).toBe('—');
  });
  it('duration', () => {
    expect(formatDurationMin(45)).toBe('45 min');
    expect(formatDurationMin(120)).toBe('2 h');
    expect(formatDurationMin(62)).toBe('1 h 2 min');
  });
});
