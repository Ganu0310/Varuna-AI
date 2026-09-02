import { describe, it, expect } from 'vitest';
import { MAX_AOI_KM2 } from '@varuna/shared';
import { bboxAreaKm2, deriveScopeFromScene, shrinkToLimit } from './fromScene.ts';
import type { ExtractedMetadata } from '../scenes/sceneFile.ts';

/**
 * What matters here is not the arithmetic — it is the REFUSALS. This function decides the
 * scope of an investigation from a file, and a scope that looks filled in but was guessed is
 * worse than an empty form: the analyst never gets the prompt to check it, and a window
 * around the wrong day returns real AIS positions of real ships that were somewhere else.
 *
 * So: a footprint the file did not state produces no area, a time the file did not state
 * produces no window, and an over-large scene is reported as over-large rather than quietly
 * trimmed to fit.
 */

function meta(over: Partial<ExtractedMetadata> = {}): ExtractedMetadata {
  return {
    readable: true,
    truncated: false,
    bigTiff: false,
    width: 2048,
    height: 2048,
    bandCount: 1,
    sampleType: 'float32',
    tiled: true,
    crs: 'EPSG:4326',
    crsSource: 'GeographicTypeGeoKey',
    pixelSize: { x: 0.0001, y: 0.0001 },
    gsdMeters: null,
    footprint: null,
    centre: null,
    footprintNote: null,
    acquisitionCandidates: [],
    acquiredAt: null,
    acquiredAtSource: null,
    acquisitionConflict: null,
    platform: null,
    mode: null,
    polarisations: [],
    software: null,
    ...over,
  };
}

function box(w: number, s: number, e: number, n: number): ExtractedMetadata['footprint'] {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

describe('deriveScopeFromScene — the area', () => {
  it("offers the scene's own bounding box", () => {
    const scope = deriveScopeFromScene(meta({ footprint: box(34.6, 35.5, 34.8, 35.7) }), 'x.tif');

    expect(scope.aoi?.text).toBe('34.6000,35.5000,34.8000,35.7000');
    expect(scope.aoi?.overLimit).toBe(false);
    expect(scope.aoiBlocker).toBeNull();
  });

  it('reports an over-large scene as over-large instead of trimming it', () => {
    // A full Sentinel-1 IW swath is around 250 km across — more than an investigation may
    // cover. Shrinking it silently would analyse a different area than the one shown.
    const scope = deriveScopeFromScene(meta({ footprint: box(70, 10, 73, 13) }), 'x.tif');

    expect(scope.aoi!.areaKm2).toBeGreaterThan(MAX_AOI_KM2);
    expect(scope.aoi!.overLimit).toBe(true);
    expect(scope.aoi!.note).toMatch(/more than the 50,000 km²/);
  });

  it('gives no area at all when the file does not say where its pixels are', () => {
    const scope = deriveScopeFromScene(
      meta({ footprint: null, footprintNote: 'named a CRS this reader cannot invert' }),
      'x.tif',
    );

    expect(scope.aoi).toBeNull();
    // The reader's own reason is passed through rather than replaced with a generic one.
    expect(scope.aoiBlocker).toMatch(/cannot invert/);
  });

  it('shrinks to just inside the limit, never past it, when asked', () => {
    const trimmed = shrinkToLimit([70, 10, 73, 13]);
    const area = bboxAreaKm2(trimmed);

    expect(area).toBeLessThanOrEqual(MAX_AOI_KM2);
    expect(area).toBeGreaterThan(MAX_AOI_KM2 * 0.999);
    // Centred on the same place: the trim takes the middle of the scene, not a corner.
    expect((trimmed[0] + trimmed[2]) / 2).toBeCloseTo(71.5, 6);
    expect((trimmed[1] + trimmed[3]) / 2).toBeCloseTo(11.5, 6);
  });

  it('leaves a box that already fits exactly as it was', () => {
    const bbox: [number, number, number, number] = [34.6, 35.5, 34.8, 35.7];
    expect(shrinkToLimit(bbox)).toEqual(bbox);
  });
});

describe('deriveScopeFromScene — the window', () => {
  const footprint = box(34.6, 35.5, 34.8, 35.7);

  it('spans the back-track horizon before the acquisition and a margin after', () => {
    const scope = deriveScopeFromScene(
      meta({
        footprint,
        acquiredAt: '2023-01-15T12:00:00.000Z',
        acquiredAtSource: 'Sentinel-1 product identifier in the filename',
      }),
      'x.tif',
    );

    // 24 h before, which is how far the drift model back-tracks by default, and 6 h after.
    expect(scope.window!.start).toBe('2023-01-14T12:00');
    expect(scope.window!.end).toBe('2023-01-15T18:00');
    expect(scope.window!.note).toMatch(/Sentinel-1 product identifier/);
    expect(scope.acquiredAt).toBe('2023-01-15T12:00:00.000Z');
  });

  it('gives no window when the file states no time, and says why', () => {
    const scope = deriveScopeFromScene(meta({ footprint }), 'x.tif');

    expect(scope.window).toBeNull();
    expect(scope.acquiredAt).toBeNull();
    expect(scope.windowBlocker).toMatch(/does not state, unambiguously/);
  });

  it('passes a conflict between two stated times through verbatim', () => {
    const scope = deriveScopeFromScene(
      meta({ footprint, acquisitionConflict: 'The file states more than one acquisition time.' }),
      'x.tif',
    );

    expect(scope.window).toBeNull();
    expect(scope.windowBlocker).toMatch(/more than one acquisition time/);
  });
});

describe('deriveScopeFromScene — the name', () => {
  it('reads as a case when the file names its platform and overpass', () => {
    const scope = deriveScopeFromScene(
      meta({ platform: 'S1A', acquiredAt: '2023-01-15T01:23:45.000Z' }),
      'S1A_IW_GRDH_1SDV_20230115T012345_20230115T012410_046905_05A0B2_1234.tif',
    );

    expect(scope.name).toBe('S1A 2023-01-15 01:23 UTC');
  });

  it('falls back to the filename, which is what the analyst will recognise', () => {
    const scope = deriveScopeFromScene(meta(), 'gulf-of-guinea-slick-03.tif');
    expect(scope.name).toBe('gulf-of-guinea-slick-03');
  });
});
