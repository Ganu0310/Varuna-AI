import { describe, it, expect } from 'vitest';
import type { Polygon } from 'geojson';
import { MAX_AOI_KM2 } from '@varuna/shared';
import { assertAoiWithinLimit } from './service.js';
import { HttpError } from '../../errors.js';

/** Rectangle in degrees, right-hand wound, centred near the equator. */
function box(lonSpan: number, latSpan: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [lonSpan, 0],
        [lonSpan, latSpan],
        [0, latSpan],
        [0, 0],
      ],
    ],
  };
}

describe('AOI guard — 01_PRD A1 / 06_BACKEND §6.4.2', () => {
  it('accepts an AOI comfortably under the limit and returns its geodesic area', () => {
    // ~0.5° × 0.5° at the equator ≈ 3,077 km²
    const area = assertAoiWithinLimit(box(0.5, 0.5));
    expect(area).toBeGreaterThan(3000);
    expect(area).toBeLessThan(3200);
  });

  it('rejects an AOI over 50,000 km² and states the ACTUAL area in the message', () => {
    // 3° × 3° at the equator ≈ 110,700 km²
    let thrown: unknown;
    try {
      assertAoiWithinLimit(box(3, 3));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    const err = thrown as HttpError;
    expect(err.status).toBe(422);
    // The analyst is told how much to shrink by, not merely "too big" (04_UIUX §4.11).
    expect(err.detail).toMatch(/km²/);
    expect(err.detail).toMatch(/Reduce it by at least/);
    const reported = Number(/covers ([\d.]+) km²/.exec(err.detail!)![1]);
    expect(reported).toBeGreaterThan(MAX_AOI_KM2);
  });

  it('rejects a degenerate (zero-area) AOI', () => {
    const line: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [0, 0],
          [0, 0],
        ],
      ],
    };
    let thrown: unknown;
    try {
      assertAoiWithinLimit(line);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(422);
    expect((thrown as HttpError).title).toMatch(/degenerate/i);
  });

  it('measures geodesically, not in degrees — the same span is smaller at high latitude', () => {
    const equator = assertAoiWithinLimit(box(1, 1));
    const arctic: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 70],
          [1, 70],
          [1, 71],
          [0, 71],
          [0, 70],
        ],
      ],
    };
    const polar = assertAoiWithinLimit(arctic);
    // 1°×1° in degree-space is identical; on the ellipsoid the polar cell is far smaller.
    expect(polar).toBeLessThan(equator * 0.45);
  });
});
