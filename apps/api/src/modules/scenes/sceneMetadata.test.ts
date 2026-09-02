import { describe, it, expect } from 'vitest';
import { extractSceneMetadata } from './sceneMetadata.js';

/**
 * The thing under test is not "does it parse a TIFF". It is the judgement the parser makes
 * about WHEN THE SCENE WAS OBSERVED, because that value is not checkable downstream: a wrong
 * acquisition instant produces real AIS positions of real ships that were somewhere else, and
 * ranks them with full confidence. So most of these tests are about what is REFUSED — which
 * signals are strong enough to adopt without asking, and which are only ever offered.
 *
 * The fixtures are TIFF headers built byte by byte rather than real scenes: what is being
 * exercised is the reader, and a header with exactly the tags under test is a sharper input
 * than a 30 MB file that happens to contain them.
 */

// ── a little-endian classic TIFF writer ──────────────────────────────

type Field =
  | { tag: number; type: 3; values: number[] } // SHORT
  | { tag: number; type: 4; values: number[] } // LONG
  | { tag: number; type: 12; values: number[] } // DOUBLE
  | { tag: number; type: 2; text: string }; // ASCII

const TYPE_SIZE: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };

function encodeValues(f: Field): Buffer {
  if (f.type === 2) {
    const b = Buffer.alloc(f.text.length + 1);
    b.write(f.text, 0, 'latin1');
    return b;
  }
  const size = TYPE_SIZE[f.type]!;
  const b = Buffer.alloc(size * f.values.length);
  f.values.forEach((v, i) => {
    if (f.type === 3) b.writeUInt16LE(v, i * 2);
    else if (f.type === 4) b.writeUInt32LE(v, i * 4);
    else b.writeDoubleLE(v, i * 8);
  });
  return b;
}

/** A structurally valid TIFF carrying exactly these fields, values and all. */
function tiff(fields: Field[]): Buffer {
  const sorted = [...fields].sort((a, b) => a.tag - b.tag);
  const encoded = sorted.map((f) => ({ f, bytes: encodeValues(f) }));

  const ifdOffset = 8;
  const ifdSize = 2 + sorted.length * 12 + 4;
  let valueCursor = ifdOffset + ifdSize;

  const heap: Buffer[] = [];
  const entries = Buffer.alloc(sorted.length * 12);

  encoded.forEach(({ f, bytes }, i) => {
    const count = f.type === 2 ? bytes.length : f.values.length;
    entries.writeUInt16LE(f.tag, i * 12);
    entries.writeUInt16LE(f.type, i * 12 + 2);
    entries.writeUInt32LE(count, i * 12 + 4);

    if (bytes.length <= 4) {
      bytes.copy(entries, i * 12 + 8);
    } else {
      entries.writeUInt32LE(valueCursor, i * 12 + 8);
      heap.push(bytes);
      valueCursor += bytes.length;
    }
  });

  const head = Buffer.alloc(8);
  head.write('II', 0, 'ascii');
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(ifdOffset, 4);

  const count = Buffer.alloc(2);
  count.writeUInt16LE(sorted.length, 0);
  const nextIfd = Buffer.alloc(4);

  return Buffer.concat([head, count, entries, nextIfd, ...heap]);
}

/** GeoKeyDirectory holding one key inline — enough to name a CRS. */
function geoKeys(pairs: Array<[number, number]>): Field {
  const values = [1, 1, 0, pairs.length];
  for (const [key, value] of pairs) values.push(key, 0, 1, value);
  return { tag: 34735, type: 3, values };
}

const SIZE_2048: Field[] = [
  { tag: 256, type: 4, values: [2048] },
  { tag: 257, type: 4, values: [2048] },
];

/** North-up transform: tiepoint at (0,0) -> (originX, originY), then a pixel step. */
function transform(originX: number, originY: number, step: number): Field[] {
  return [
    { tag: 33550, type: 12, values: [step, step, 0] },
    { tag: 33922, type: 12, values: [0, 0, 0, originX, originY, 0] },
  ];
}

describe('extractSceneMetadata — what the file says about itself', () => {
  it('reads size, band count, sample type and coordinate system', () => {
    const buf = tiff([
      ...SIZE_2048,
      { tag: 258, type: 3, values: [32] },
      { tag: 277, type: 3, values: [2] },
      { tag: 339, type: 3, values: [3] },
      ...transform(34.69, 35.62, 0.00008983152841195218),
      geoKeys([[2048, 4326]]),
    ]);

    const meta = extractSceneMetadata(buf, 'scene.tif');
    expect(meta.readable).toBe(true);
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(2048);
    expect(meta.bandCount).toBe(2);
    expect(meta.sampleType).toBe('float32');
    expect(meta.crs).toBe('EPSG:4326');
    expect(meta.crsSource).toBe('GeographicTypeGeoKey');
  });

  it('places a WGS84 scene where its transform says, and computes the centre', () => {
    const step = 0.00008983152841195218;
    const buf = tiff([...SIZE_2048, ...transform(34.69, 35.62, step), geoKeys([[2048, 4326]])]);

    const meta = extractSceneMetadata(buf, 'scene.tif');
    expect(meta.footprint).not.toBeNull();
    expect(meta.centre!.lon).toBeCloseTo(34.69 + (2048 * step) / 2, 4);
    expect(meta.centre!.lat).toBeCloseTo(35.62 - (2048 * step) / 2, 4);
    // Degrees do not convert to metres without a latitude, and a wrong GSD would propagate
    // into every area figure downstream.
    expect(meta.gsdMeters).toBeNull();
  });

  it('inverts UTM to agree with pyproj (the reference the ML service uses)', () => {
    // EPSG:32643, easting 500000 / northing 3937000 -> 75.000000, 35.576700 per pyproj.
    const buf = tiff([
      { tag: 256, type: 4, values: [1] },
      { tag: 257, type: 4, values: [1] },
      ...transform(500000, 3937000, 10),
      geoKeys([[3072, 32643]]),
    ]);

    const meta = extractSceneMetadata(buf, 'scene.tif');
    const [lon, lat] = meta.footprint!.coordinates[0]![0]!;
    expect(lon).toBeCloseTo(75.0, 5);
    expect(lat).toBeCloseTo(35.57670042, 5);
    // A projected CRS is metric, so the pixel step IS a ground sample distance.
    expect(meta.gsdMeters).toBe(10);
  });

  it('inverts southern-hemisphere UTM, where the false northing applies', () => {
    const buf = tiff([
      { tag: 256, type: 4, values: [1] },
      { tag: 257, type: 4, values: [1] },
      ...transform(500000, 8000000, 10),
      geoKeys([[3072, 32743]]),
    ]);

    const [lon, lat] = extractSceneMetadata(buf, 'scene.tif').footprint!.coordinates[0]![0]!;
    expect(lon).toBeCloseTo(75.0, 5);
    expect(lat).toBeCloseTo(-18.08870894, 5);
  });

  it('refuses to place a scene in a CRS it cannot invert, and says so', () => {
    // A real projected CRS, just not one this preview reader knows how to undo. Drawing it
    // anyway would put the scene in the wrong ocean on a persuasive map.
    const buf = tiff([...SIZE_2048, ...transform(400000, 300000, 10), geoKeys([[3072, 27700]])]);

    const meta = extractSceneMetadata(buf, 'scene.tif');
    expect(meta.crs).toBe('EPSG:27700');
    expect(meta.footprint).toBeNull();
    expect(meta.footprintNote).toMatch(/cannot invert/i);
  });
});

describe('extractSceneMetadata — when was it observed', () => {
  const georeferenced = [...SIZE_2048, ...transform(34.69, 35.62, 0.0001), geoKeys([[2048, 4326]])];

  it('adopts the sensing start from a Sentinel-1 product identifier', () => {
    const meta = extractSceneMetadata(
      tiff(georeferenced),
      'S1A_IW_GRDH_1SDV_20230115T012345_20230115T012410_046905_05A0B2_1234.tif',
    );

    expect(meta.acquiredAt).toBe('2023-01-15T01:23:45.000Z');
    expect(meta.acquiredAtSource).toMatch(/Sentinel-1 product identifier/);
    // The same name states the platform, the mode and the polarisation pair.
    expect(meta.platform).toBe('S1A');
    expect(meta.mode).toBe('IW');
    expect(meta.polarisations).toEqual(['VV', 'VH']);
  });

  it('adopts a metadata key that means acquisition', () => {
    const meta = extractSceneMetadata(
      tiff([
        ...georeferenced,
        {
          tag: 42112,
          type: 2,
          text: '<GDALMetadata><Item name="ACQUISITION_TIME">2023-01-15T01:23:45Z</Item></GDALMetadata>',
        },
      ]),
      'scene.tif',
    );

    expect(meta.acquiredAt).toBe('2023-01-15T01:23:45.000Z');
    expect(meta.acquiredAtSource).toBe('GDAL metadata: ACQUISITION_TIME');
  });

  it('never adopts TIFFTAG_DATETIME, because that is when the FILE was written', () => {
    const meta = extractSceneMetadata(
      tiff([...georeferenced, { tag: 306, type: 2, text: '2024:06:02 09:14:00' }]),
      'scene.tif',
    );

    expect(meta.acquiredAt).toBeNull();
    const offered = meta.acquisitionCandidates.find((c) => c.source === 'TIFFTAG_DATETIME');
    // Offered, so the analyst can accept it in one click — but on the record as weak, with
    // the reason it is weak.
    expect(offered).toBeDefined();
    expect(offered!.confidence).toBe('LOW');
    expect(offered!.value).toBe('2024-06-02T09:14:00.000Z');
    expect(offered!.note).toMatch(/when the FILE was written/i);
  });

  it('never adopts a production timestamp, however precisely it is stated', () => {
    const meta = extractSceneMetadata(
      tiff([
        ...georeferenced,
        {
          tag: 42112,
          type: 2,
          text: '<GDALMetadata><Item name="PROCESSING_TIME">2023-02-01T00:00:00Z</Item></GDALMetadata>',
        },
      ]),
      'scene.tif',
    );

    expect(meta.acquiredAt).toBeNull();
    expect(meta.acquisitionCandidates[0]!.confidence).toBe('LOW');
  });

  it('adopts nothing when two strong sources disagree, and names both', () => {
    // The filename says one overpass, the embedded metadata says another eleven hours later.
    // They cannot both be right, and picking one silently is the worst available option.
    const meta = extractSceneMetadata(
      tiff([
        ...georeferenced,
        {
          tag: 42112,
          type: 2,
          text: '<GDALMetadata><Item name="ACQUISITION_TIME">2023-01-15T12:00:00Z</Item></GDALMetadata>',
        },
      ]),
      'S1A_IW_GRDH_1SDV_20230115T012345_20230115T012410_046905_05A0B2_1234.tif',
    );

    expect(meta.acquiredAt).toBeNull();
    expect(meta.acquisitionConflict).toMatch(/more than one acquisition time/i);
    expect(meta.acquisitionConflict).toContain('2023-01-15T01:23:45.000Z');
    expect(meta.acquisitionConflict).toContain('2023-01-15T12:00:00.000Z');
  });

  it('treats a Landsat scene id as a date without a time, and will not adopt it', () => {
    const meta = extractSceneMetadata(
      tiff(georeferenced),
      'LC08_L1TP_144046_20230115_20230123_02_T1.tif',
    );

    expect(meta.acquiredAt).toBeNull();
    expect(meta.acquisitionCandidates[0]!.confidence).toBe('LOW');
    expect(meta.acquisitionCandidates[0]!.note).toMatch(/twelve hours/);
  });

  it('offers, but does not adopt, a timestamp in a filename following no convention', () => {
    const meta = extractSceneMetadata(tiff(georeferenced), 'export_20230115T012345_final.tif');

    expect(meta.acquiredAt).toBeNull();
    expect(meta.acquisitionCandidates[0]!.confidence).toBe('MEDIUM');
    expect(meta.acquisitionCandidates[0]!.value).toBe('2023-01-15T01:23:45.000Z');
  });

  it('discards an instant that cannot be an observation', () => {
    // A 1970 epoch default and a clock set to next century are both parse successes and both
    // nonsense; neither may become an AIS search window.
    const past = extractSceneMetadata(tiff(georeferenced), 'S2A_MSIL1C_19700101T000000_x.tif');
    expect(past.acquisitionCandidates).toHaveLength(0);

    const future = extractSceneMetadata(tiff(georeferenced), 'S2A_MSIL1C_21000101T000000_x.tif');
    expect(future.acquisitionCandidates).toHaveLength(0);
  });
});

describe('extractSceneMetadata — partial and malformed input', () => {
  it('reads what it can from a header slice and flags the rest as absent', () => {
    // The browser sends the leading megabytes, so values living further into the file are
    // simply not there. That is an ordinary outcome, not an error.
    const full = tiff([
      ...SIZE_2048,
      ...transform(34.69, 35.62, 0.0001),
      geoKeys([[2048, 4326]]),
      { tag: 42112, type: 2, text: '<GDALMetadata><Item name="X">y</Item></GDALMetadata>' },
    ]);
    const sliced = full.subarray(0, 8 + 2 + 6 * 12 + 4);

    const meta = extractSceneMetadata(sliced, 'scene.tif');
    expect(meta.readable).toBe(true);
    expect(meta.truncated).toBe(true);
    expect(meta.width).toBe(2048);
    expect(meta.gdalMetadata).toEqual({});
  });

  it('reports a file it cannot read at all without throwing, keeping what the name said', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(16).fill(0)]);

    const meta = extractSceneMetadata(
      png,
      'S1A_IW_GRDH_1SDV_20230115T012345_20230115T012410_046905_05A0B2_1234.tif',
    );
    expect(meta.readable).toBe(false);
    expect(meta.crs).toBeNull();
    // The name is still evidence, and it is the only evidence a renamed file leaves. It is
    // reported as a candidate — the upload refuses the bytes on other grounds anyway.
    expect(meta.acquisitionCandidates).toHaveLength(1);
    expect(meta.acquiredAt).toBeNull();
  });

  it('survives a directory whose georeferencing tags are present but empty', () => {
    // Exactly the shape `inspectGeoTiff`'s own fixtures produce: the tags exist, the values
    // are zero. Nothing may be inferred from that, and nothing may crash on it either.
    const buf = tiff([
      { tag: 34735, type: 3, values: [0, 0, 0, 0] },
      { tag: 33550, type: 12, values: [0, 0, 0] },
      { tag: 33922, type: 12, values: [0, 0, 0, 0, 0, 0] },
    ]);

    const meta = extractSceneMetadata(buf, 'scene.tif');
    expect(meta.readable).toBe(true);
    expect(meta.crs).toBeNull();
    expect(meta.footprint).toBeNull();
    expect(meta.acquiredAt).toBeNull();
  });
});
