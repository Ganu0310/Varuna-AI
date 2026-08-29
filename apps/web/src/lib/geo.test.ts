import { describe, it, expect } from 'vitest';
import { parsePolygon, approxPolygonAreaKm2 } from './geo.ts';

const SQUARE =
  '{"type":"Polygon","coordinates":[[[80,13],[80.4,13],[80.4,13.4],[80,13.4],[80,13]]]}';

describe('parsePolygon', () => {
  it('accepts a bare Polygon', () => {
    const { polygon, error } = parsePolygon(SQUARE);
    expect(error).toBeNull();
    expect(polygon?.type).toBe('Polygon');
  });

  it('accepts a Feature and a FeatureCollection', () => {
    const feature = `{"type":"Feature","properties":{},"geometry":${SQUARE}}`;
    expect(parsePolygon(feature).polygon).toBeTruthy();
    expect(
      parsePolygon(`{"type":"FeatureCollection","features":[${feature}]}`).polygon,
    ).toBeTruthy();
  });

  it('returns no error for empty input (nothing typed yet)', () => {
    expect(parsePolygon('   ')).toEqual({ polygon: null, error: null });
  });

  it('reports invalid JSON', () => {
    expect(parsePolygon('{not json').error).toMatch(/valid JSON/);
  });

  it('rejects an unclosed ring, saying what is wrong', () => {
    const open = '{"type":"Polygon","coordinates":[[[80,13],[80.4,13],[80.4,13.4],[80,13.4]]]}';
    expect(parsePolygon(open).error).toMatch(/closed/);
  });

  it('catches a [lat, lon] swap by range and names the correct order', () => {
    const swapped =
      '{"type":"Polygon","coordinates":[[[13,200],[13,201],[14,201],[14,200],[13,200]]]}';
    const err = parsePolygon(swapped).error;
    expect(err).toMatch(/out of range/);
    expect(err).toMatch(/\[longitude, latitude\]/);
  });

  it('rejects a ring with too few positions', () => {
    expect(parsePolygon('{"type":"Polygon","coordinates":[[[0,0],[1,1],[0,0]]]}').error).toMatch(
      /four positions/,
    );
  });

  it('rejects a non-polygon geometry', () => {
    expect(parsePolygon('{"type":"Point","coordinates":[0,0]}').error).toMatch(/Polygon/);
  });
});

describe('approxPolygonAreaKm2 (readout only — server value is authoritative)', () => {
  it('is in the right ballpark for a 1°x1° equatorial cell (~12,308 km²)', () => {
    const cell = parsePolygon('{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}');
    const area = approxPolygonAreaKm2(cell.polygon!);
    expect(area).toBeGreaterThan(12_000);
    expect(area).toBeLessThan(12_600);
  });

  it('shrinks with latitude', () => {
    const eq = approxPolygonAreaKm2(
      parsePolygon('{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}').polygon!,
    );
    const polar = approxPolygonAreaKm2(
      parsePolygon('{"type":"Polygon","coordinates":[[[0,70],[1,70],[1,71],[0,71],[0,70]]]}')
        .polygon!,
    );
    expect(polar).toBeLessThan(eq * 0.45);
  });
});

describe('AOI as a bounding box', () => {
  it('accepts west,south,east,north and closes the ring', () => {
    const { polygon, error } = parsePolygon('144.55,13.3,144.95,13.6');
    expect(error).toBeNull();
    const ring = polygon!.coordinates[0]!;
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]); // closed
  });

  it('winds counter-clockwise', () => {
    // A clockwise ring is read by MongoDB as the polygon's COMPLEMENT — the rest of the
    // planet — and it does not error. The shoelace sum is positive for CCW.
    const { polygon } = parsePolygon('144.55,13.3,144.95,13.6');
    const ring = polygon!.coordinates[0]!;
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      area += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
    }
    expect(area).toBeGreaterThan(0);
  });

  it('rejects a reversed box rather than silently normalising it', () => {
    // Swapping the corners usually means the values were entered in the wrong order, and
    // quietly fixing it would hide that from someone who typed lat,lon by mistake.
    expect(parsePolygon('144.95,13.6,144.55,13.3').error).toMatch(/east must exceed west/i);
  });

  it('rejects out-of-range coordinates', () => {
    expect(parsePolygon('-200,13.3,144.95,13.6').error).toMatch(/-180/);
  });

  it('still parses GeoJSON, and does not mistake it for a bbox', () => {
    const gj =
      '{"type":"Polygon","coordinates":[[[80,13],[80.4,13],[80.4,13.4],[80,13.4],[80,13]]]}';
    expect(parsePolygon(gj).polygon).not.toBeNull();
  });

  it('reports invalid JSON as invalid JSON, not as a bad bbox', () => {
    expect(parsePolygon('{not json').error).toMatch(/JSON/i);
  });
});
