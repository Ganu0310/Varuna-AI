import { describe, it, expect } from 'vitest';
import { chooseStep, graticuleFor } from './graticule.ts';

/**
 * The first version of `chooseStep` tested for "at most N lines", which the coarsest step
 * satisfies immediately — 30° trivially yields fewer than 8 lines across half a degree. The
 * result was a graticule that rendered nothing at exactly the zoom an analyst works at, while
 * the layer, source and style were all provably fine. Nothing errored; the map just looked
 * like a failed render.
 *
 * So these assert the property that actually matters: at every realistic viewport span, the
 * grid must be VISIBLE and not absurdly dense.
 */
describe('graticule step selection', () => {
  const SPANS = [
    ['hemisphere', 120],
    ['ocean basin', 40],
    ['sea area', 12],
    ['regional', 3],
    ['investigation AOI', 0.52],
    ['single detection', 0.08],
    ['vessel scale', 0.01],
  ] as const;

  for (const [label, span] of SPANS) {
    it(`puts a usable number of lines across a ${label} view (${span}°)`, () => {
      const step = chooseStep(span);
      const lines = span / step;
      expect(lines, `${label}: ${lines.toFixed(1)} lines at ${step}° step`).toBeGreaterThanOrEqual(
        3,
      );
      expect(lines, `${label}: ${lines.toFixed(1)} lines at ${step}° step`).toBeLessThan(60);
    });
  }

  it('chooses a coarser step as the view widens, never a finer one', () => {
    const steps = SPANS.map(([, span]) => chooseStep(span));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!).toBeLessThanOrEqual(steps[i - 1]!);
    }
  });
});

describe('graticule geometry', () => {
  const BOUNDS = { west: 144.5, south: 13.19, east: 145.0, north: 13.71 };

  it('produces lines that actually fall inside the viewport', () => {
    // The original failure was an empty intersection with the viewport, so presence of
    // features is not enough — at least one must lie within the visible bounds.
    const fc = graticuleFor(BOUNDS, chooseStep(0.52));
    expect(fc.features.length).toBeGreaterThan(0);

    const inside = fc.features.filter((f) => {
      const coords = (f.geometry as { coordinates: number[][] }).coordinates;
      if (f.properties!.kind === 'meridian') {
        const lon = coords[0]![0]!;
        return lon >= BOUNDS.west && lon <= BOUNDS.east;
      }
      const lat = coords[0]![1]!;
      return lat >= BOUNDS.south && lat <= BOUNDS.north;
    });
    expect(inside.length, 'no gridline intersects the viewport').toBeGreaterThan(0);
  });

  it('extends one step beyond the viewport so lines do not pop in while panning', () => {
    const step = 0.1;
    const fc = graticuleFor(BOUNDS, step);
    const meridians = fc.features
      .filter((f) => f.properties!.kind === 'meridian')
      .map((f) => (f.geometry as { coordinates: number[][] }).coordinates[0]![0]!);
    expect(Math.min(...meridians)).toBeLessThan(BOUNDS.west);
    expect(Math.max(...meridians)).toBeGreaterThan(BOUNDS.east);
  });

  it('labels lines with round values, not floating-point accumulation', () => {
    const fc = graticuleFor(BOUNDS, 0.1);
    for (const f of fc.features) {
      const v = f.properties!.value as number;
      // 13.299999999999999 would render as a nonsense label if these were ever drawn.
      expect(String(v).length).toBeLessThan(12);
    }
  });

  it('clamps latitude to the Mercator-safe range', () => {
    const fc = graticuleFor({ west: -180, south: -89, east: 180, north: 89 }, 30);
    for (const f of fc.features) {
      for (const [, lat] of (f.geometry as { coordinates: number[][] }).coordinates) {
        expect(Math.abs(lat!)).toBeLessThanOrEqual(85);
      }
    }
  });

  it('cannot loop unboundedly on a degenerate camera', () => {
    const fc = graticuleFor({ west: -180, south: -85, east: 180, north: 85 }, 0.01);
    expect(fc.features.length).toBeLessThanOrEqual(800);
  });
});
