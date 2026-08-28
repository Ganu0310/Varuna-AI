import { describe, it, expect } from 'vitest';
import { Schema, model } from 'mongoose';
import { PolygonSchema, isRightHandWound, isClosedRing, ringSignedArea } from './geojson.js';

const Holder = model('GeoJsonPolygonHolder', new Schema({ geom: { type: PolygonSchema } }));

const CCW_CLOSED = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ],
];
const CW_CLOSED = [
  [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
  ],
];
const OPEN = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
];

describe('PolygonSchema validators — 06_BACKEND §6.3.2 / 12 F-10', () => {
  it('accepts a closed, right-hand-wound (CCW exterior) polygon', () => {
    const err = new Holder({ geom: { type: 'Polygon', coordinates: CCW_CLOSED } }).validateSync();
    expect(err).toBeUndefined();
  });

  it('rejects a clockwise exterior ring (would match the whole globe in MongoDB)', () => {
    const err = new Holder({ geom: { type: 'Polygon', coordinates: CW_CLOSED } }).validateSync();
    expect(err).toBeDefined();
    expect(JSON.stringify(err)).toMatch(/right-hand rule/);
  });

  it('rejects an unclosed ring', () => {
    const err = new Holder({ geom: { type: 'Polygon', coordinates: OPEN } }).validateSync();
    expect(err).toBeDefined();
    expect(JSON.stringify(err)).toMatch(/closed/);
  });

  it('rejects out-of-range coordinates (an obvious [lat, lon] swap near the pole)', () => {
    const swapped = [
      [
        [0, 0],
        [1, 0],
        [1, 100],
        [0, 100],
        [0, 0],
      ],
    ];
    const err = new Holder({ geom: { type: 'Polygon', coordinates: swapped } }).validateSync();
    expect(err).toBeDefined();
  });
});

describe('winding helpers', () => {
  it('ringSignedArea is positive for CCW, negative for CW', () => {
    expect(ringSignedArea(CCW_CLOSED[0]!)).toBeGreaterThan(0);
    expect(ringSignedArea(CW_CLOSED[0]!)).toBeLessThan(0);
  });
  it('isRightHandWound: CCW exterior true, CW exterior false', () => {
    expect(isRightHandWound(CCW_CLOSED)).toBe(true);
    expect(isRightHandWound(CW_CLOSED)).toBe(false);
  });
  it('isClosedRing', () => {
    expect(isClosedRing(CCW_CLOSED[0]!)).toBe(true);
    expect(isClosedRing(OPEN[0]!)).toBe(false);
  });
});
