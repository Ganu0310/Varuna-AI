import { describe, it, expect } from 'vitest';
import { WATCH_REGIONS, watchRegionAoi, watchRegionById } from './watchRegions.js';

describe('WATCH_REGIONS', () => {
  it('has four real, uniquely-identified regions', () => {
    expect(WATCH_REGIONS).toHaveLength(4);
    expect(new Set(WATCH_REGIONS.map((r) => r.id)).size).toBe(4);
  });

  it('every bbox is well-formed: west < east, south < north, real coordinates', () => {
    for (const r of WATCH_REGIONS) {
      const [w, s, e, n] = r.bbox;
      expect(w).toBeLessThan(e);
      expect(s).toBeLessThan(n);
      expect(w).toBeGreaterThanOrEqual(-180);
      expect(e).toBeLessThanOrEqual(180);
      expect(s).toBeGreaterThanOrEqual(-90);
      expect(n).toBeLessThanOrEqual(90);
    }
  });

  it('includes the staged demo region with real AIS already loaded', () => {
    const guam = watchRegionById('guam-apra');
    expect(guam?.aisCoverage).toBe('STAGED');
  });

  it('watchRegionAoi produces a closed, counter-clockwise ring matching the bbox', () => {
    const r = watchRegionById('baniyas-syria')!;
    const aoi = watchRegionAoi(r);
    const ring = aoi.coordinates[0]!;

    expect(ring[0]).toEqual(ring[ring.length - 1]); // closed
    const [w, s, e, n] = r.bbox;
    expect(ring).toEqual([
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ]);
  });

  it('watchRegionById returns undefined for an unknown id rather than throwing', () => {
    expect(watchRegionById('not-a-real-region')).toBeUndefined();
  });
});
