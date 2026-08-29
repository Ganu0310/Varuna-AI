import { describe, it, expect } from 'vitest';
import { subsolarPoint, solarTerminator } from './terminator.ts';

/**
 * A decorative terminator would be a fabricated observation dressed as a real one. These pin
 * it against facts of the solar year that are known independently of this code — solstice and
 * equinox declinations, and which pole is dark when — so the astronomy cannot quietly rot into
 * a tilted circle that merely looks plausible.
 *
 * Tolerances are a few tenths of a degree: this is the standard low-precision solar position,
 * far finer than the pixel it is drawn at.
 */

const at = (iso: string) => Date.parse(iso);

describe('subsolar point', () => {
  it('sits on the equator at the March equinox', () => {
    const { lat } = subsolarPoint(at('2025-03-20T09:01:00Z'));
    expect(Math.abs(lat)).toBeLessThan(0.3);
  });

  it('reaches the Tropic of Cancer at the June solstice', () => {
    // 23.44°N, the obliquity of the ecliptic. If this drifts the whole terminator is wrong
    // by the same amount for half the year.
    const { lat } = subsolarPoint(at('2025-06-21T02:42:00Z'));
    expect(lat).toBeGreaterThan(23.2);
    expect(lat).toBeLessThan(23.6);
  });

  it('reaches the Tropic of Capricorn at the December solstice', () => {
    const { lat } = subsolarPoint(at('2025-12-21T15:03:00Z'));
    expect(lat).toBeLessThan(-23.2);
    expect(lat).toBeGreaterThan(-23.6);
  });

  it('is near the antimeridian at midnight UTC and near Greenwich at noon', () => {
    // The equation of time shifts this by up to ~4°, so the tolerance is deliberately loose —
    // but the hemisphere must be right, and an implementation ignoring the sign convention
    // lands 180° out.
    const midnight = subsolarPoint(at('2025-09-21T00:00:00Z'));
    expect(Math.abs(Math.abs(midnight.lon) - 180)).toBeLessThan(6);

    const noon = subsolarPoint(at('2025-09-21T12:00:00Z'));
    expect(Math.abs(noon.lon)).toBeLessThan(6);
  });

  it('sweeps westward at roughly 15° per hour', () => {
    const a = subsolarPoint(at('2025-09-21T06:00:00Z')).lon;
    const b = subsolarPoint(at('2025-09-21T07:00:00Z')).lon;
    let d = a - b;
    if (d < -180) d += 360;
    if (d > 180) d -= 360;
    expect(d).toBeGreaterThan(14);
    expect(d).toBeLessThan(16);
  });

  it('puts the sun over the Pacific for the Guam demo acquisition', () => {
    // 2025-09-21 20:07 UTC. Guam is UTC+10, so this is ~06:07 local — shortly after local
    // sunrise, which the globe should show as the terminator having just passed.
    const { lon } = subsolarPoint(at('2025-09-21T20:07:48Z'));
    expect(lon).toBeGreaterThan(-140);
    expect(lon).toBeLessThan(-110);
  });
});

describe('terminator polygon', () => {
  it('closes over the SOUTH pole in northern summer', () => {
    // Northern summer means the Antarctic is dark. Closing over the wrong pole shades the lit
    // hemisphere instead — a total inversion, and it flips at every equinox.
    const f = solarTerminator(at('2025-06-21T02:42:00Z'));
    const lats = f.geometry.coordinates[0]!.map((c) => c[1]!);
    expect(Math.min(...lats)).toBe(-90);
    expect(Math.max(...lats)).toBeLessThan(90);
  });

  it('closes over the NORTH pole in northern winter', () => {
    const f = solarTerminator(at('2025-12-21T15:03:00Z'));
    const lats = f.geometry.coordinates[0]!.map((c) => c[1]!);
    expect(Math.max(...lats)).toBe(90);
  });

  it('is a closed ring spanning the full longitude range', () => {
    const ring = solarTerminator(at('2025-09-21T20:07:48Z')).geometry.coordinates[0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const lons = ring.map((c) => c[0]!);
    expect(Math.min(...lons)).toBe(-180);
    expect(Math.max(...lons)).toBe(180);
  });

  it('records the declination it was built from', () => {
    const f = solarTerminator(at('2025-06-21T02:42:00Z'));
    expect(f.properties!.declination as number).toBeGreaterThan(23);
  });
});
