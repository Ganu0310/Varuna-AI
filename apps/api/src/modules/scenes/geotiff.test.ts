import { describe, it, expect } from 'vitest';
import { inspectGeoTiff } from './geotiff.js';

/**
 * The failure being guarded against is not "the upload crashes". It is that a plain TIFF
 * loads perfectly well as pixels, detection runs, and the polygons are written out as if they
 * were positions on the Earth — a result indistinguishable from a real one, in the wrong
 * ocean. So the tests are all about what gets REFUSED.
 */

const GEO_KEY_DIRECTORY = 34735;
const MODEL_PIXEL_SCALE = 33550;
const MODEL_TIEPOINT = 33922;
const MODEL_TRANSFORMATION = 34264;

/** A minimal little-endian classic TIFF carrying exactly the tags asked for. */
function tiff(tags: number[], { order = 'II', magic = 42 } = {}): Buffer {
  const le = order === 'II';
  const ifdOffset = 8;
  const buf = Buffer.alloc(ifdOffset + 2 + tags.length * 12 + 4);
  buf.write(order, 0, 'ascii');
  if (le) {
    buf.writeUInt16LE(magic, 2);
    buf.writeUInt32LE(ifdOffset, 4);
    buf.writeUInt16LE(tags.length, ifdOffset);
    tags.forEach((t, i) => buf.writeUInt16LE(t, ifdOffset + 2 + i * 12));
  } else {
    buf.writeUInt16BE(magic, 2);
    buf.writeUInt32BE(ifdOffset, 4);
    buf.writeUInt16BE(tags.length, ifdOffset);
    tags.forEach((t, i) => buf.writeUInt16BE(t, ifdOffset + 2 + i * 12));
  }
  return buf;
}

const GEOREFERENCED = [GEO_KEY_DIRECTORY, MODEL_PIXEL_SCALE, MODEL_TIEPOINT, 256, 257];

describe('inspectGeoTiff', () => {
  it('accepts a georeferenced GeoTIFF', () => {
    expect(inspectGeoTiff(tiff(GEOREFERENCED)).ok).toBe(true);
  });

  it('accepts big-endian, because a TIFF written on a big-endian machine is still a TIFF', () => {
    expect(inspectGeoTiff(tiff(GEOREFERENCED, { order: 'MM' })).ok).toBe(true);
  });

  it('accepts BigTIFF — a Sentinel-1 GRD routinely exceeds 4 GB', () => {
    // Refusing BigTIFF outright would refuse real data, which is the wrong kind of strict.
    const buf = Buffer.alloc(8 + 8 + 3 * 20 + 8);
    buf.write('II', 0, 'ascii');
    buf.writeUInt16LE(43, 2);
    buf.writeUInt16LE(8, 4);
    buf.writeUInt16LE(0, 6);
    buf.writeBigUInt64LE(16n, 8);
    buf.writeBigUInt64LE(3n, 16);
    [GEO_KEY_DIRECTORY, MODEL_PIXEL_SCALE, MODEL_TIEPOINT].forEach((t, i) =>
      buf.writeUInt16LE(t, 24 + i * 20),
    );
    const out = inspectGeoTiff(buf);
    expect(out.ok).toBe(true);
    expect(out.bigTiff).toBe(true);
  });

  it('accepts a ModelTransformation instead of tiepoint plus scale', () => {
    expect(inspectGeoTiff(tiff([GEO_KEY_DIRECTORY, MODEL_TRANSFORMATION])).ok).toBe(true);
  });

  describe('refusals', () => {
    it('refuses a renamed PNG', () => {
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      const out = inspectGeoTiff(png);
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/not a TIFF/i);
    });

    it('refuses a plain TIFF with no CRS, and says why it matters', () => {
      // This is the dangerous one: it decodes perfectly as an image.
      const out = inspectGeoTiff(tiff([MODEL_PIXEL_SCALE, MODEL_TIEPOINT, 256, 257]));
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/plain TIFF/i);
      expect(out.reason).toMatch(/guesswork|coordinate reference system/i);
    });

    it('refuses a GeoTIFF that names a CRS but no position in it', () => {
      // A CRS says WHICH system; a tiepoint says WHERE in it. Both are needed.
      const out = inspectGeoTiff(tiff([GEO_KEY_DIRECTORY, 256, 257]));
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/where its pixels sit/i);
    });

    it('refuses a CRS with a scale but no tiepoint', () => {
      expect(inspectGeoTiff(tiff([GEO_KEY_DIRECTORY, MODEL_PIXEL_SCALE])).ok).toBe(false);
    });

    it('refuses a truncated upload rather than reading past the end', () => {
      const full = tiff(GEOREFERENCED);
      const out = inspectGeoTiff(full.subarray(0, 14));
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/truncated|too small/i);
    });

    it('refuses an empty file', () => {
      expect(inspectGeoTiff(Buffer.alloc(0)).ok).toBe(false);
    });

    it('refuses a TIFF whose directory claims more entries than the file holds', () => {
      const buf = tiff(GEOREFERENCED);
      buf.writeUInt16LE(4000, 8);
      expect(inspectGeoTiff(buf).ok).toBe(false);
    });
  });
});
