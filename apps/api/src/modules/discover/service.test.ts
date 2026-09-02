import { describe, it, expect } from 'vitest';
import { MAX_AOI_KM2, DRIFT_DEFAULTS } from '@varuna/shared';
import { bboxOfFootprint, shrinkToCap, deriveScopeFromScene } from './service.js';
import { geodesicPolygonAreaKm2 } from '../../geo/geodesy.js';
import type { Polygon } from 'geojson';

/**
 * Adopting a Discover scene has the same failure mode the web upload path already guards
 * against (`apps/web/src/features/investigations/fromScene.ts`): a full Sentinel-1 swath is
 * bigger than the 50,000 km² investigation cap, so the honest thing to do is crop around the
 * scene's own centre — never silently analyse a different area than the one the response
 * claims, and never let `createInvestigation` reject the adoption outright.
 */

function bbox(w: number, s: number, e: number, n: number): [number, number, number, number] {
  return [w, s, e, n];
}

describe('bboxOfFootprint', () => {
  it('reads the real extent from a footprint ring', () => {
    const footprint: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [34.6, 35.1],
          [35.1, 35.1],
          [35.1, 35.8],
          [34.6, 35.8],
          [34.6, 35.1],
        ],
      ],
    };
    expect(bboxOfFootprint(footprint)).toEqual([34.6, 35.1, 35.1, 35.8]);
  });
});

describe('shrinkToCap', () => {
  it('leaves a box already within the cap untouched', () => {
    const small = bbox(34.6, 35.1, 34.7, 35.2);
    expect(shrinkToCap(small)).toEqual(small);
  });

  it('crops a full Sentinel-1-sized swath to just inside the cap, centred the same place', () => {
    // ~3 degrees square at this latitude — well over 250x170 km, comfortably over the cap.
    const swath = bbox(33.0, 34.0, 36.5, 37.5);
    const before = geodesicPolygonAreaKm2({
      type: 'Polygon',
      coordinates: [
        [
          [swath[0], swath[1]],
          [swath[2], swath[1]],
          [swath[2], swath[3]],
          [swath[0], swath[3]],
          [swath[0], swath[1]],
        ],
      ],
    } as never) as number;
    expect(before).toBeGreaterThan(MAX_AOI_KM2);

    const cropped = shrinkToCap(swath);
    const after = geodesicPolygonAreaKm2({
      type: 'Polygon',
      coordinates: [
        [
          [cropped[0], cropped[1]],
          [cropped[2], cropped[1]],
          [cropped[2], cropped[3]],
          [cropped[0], cropped[3]],
          [cropped[0], cropped[1]],
        ],
      ],
    } as never) as number;

    expect(after).toBeLessThanOrEqual(MAX_AOI_KM2);
    expect(after).toBeGreaterThan(MAX_AOI_KM2 * 0.99); // cropped close to the limit, not overshrunk
    expect((cropped[0] + cropped[2]) / 2).toBeCloseTo((swath[0] + swath[2]) / 2, 6);
    expect((cropped[1] + cropped[3]) / 2).toBeCloseTo((swath[1] + swath[3]) / 2, 6);
  });
});

describe('deriveScopeFromScene', () => {
  const footprint: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [34.6, 35.1],
        [35.1, 35.1],
        [35.1, 35.8],
        [34.6, 35.8],
        [34.6, 35.1],
      ],
    ],
  };

  it('spans the drift back-track horizon before acquisition and 6 hours after', () => {
    const scope = deriveScopeFromScene({
      footprint,
      acquiredAt: new Date('2023-01-15T12:00:00Z'),
      productId: 'S1A_IW_GRDH_1SDV_20230115T120000_x',
    });
    expect(scope.windowStart.toISOString()).toBe(
      new Date(
        Date.parse('2023-01-15T12:00:00Z') - DRIFT_DEFAULTS.horizonHours * 3_600_000,
      ).toISOString(),
    );
    expect(scope.windowEnd.toISOString()).toBe('2023-01-15T18:00:00.000Z');
  });

  it('names the investigation from the real product id and acquisition time', () => {
    const scope = deriveScopeFromScene({
      footprint,
      acquiredAt: new Date('2023-01-15T12:00:00Z'),
      productId: 'S1A_IW_GRDH_1SDV_20230115T120000_x',
    });
    expect(scope.name).toBe('S1A_IW_GRDH_1SDV_20230115T120000_x — 2023-01-15 12:00 UTC');
  });

  it('always returns an AOI within the investigation area cap', () => {
    const scope = deriveScopeFromScene({
      footprint,
      acquiredAt: new Date('2023-01-15T12:00:00Z'),
      productId: 'p',
    });
    expect(geodesicPolygonAreaKm2(scope.aoi as never) as number).toBeLessThanOrEqual(MAX_AOI_KM2);
  });
});
