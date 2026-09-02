/**
 * Reading a TIFF directory, rather than only counting what is in it.
 *
 * `geotiff.ts` answers one question — may these bytes be accepted at all — and it answers it
 * by looking at which tags exist. This module reads the tag VALUES, which is what lets an
 * upload describe itself: its size, its pixel spacing, the coordinate system it names, where
 * on the Earth it sits, and whatever the writer recorded about when the sensor observed it.
 *
 * It is deliberately a header reader and nothing more. Pixels are never decoded, and any
 * offset pointing past the end of the supplied buffer yields `undefined` rather than a throw —
 * the caller may legitimately hold only the first megabyte of a 4 GB scene (see the
 * `/scenes/inspect` route), and a value that is simply not present in that slice is an
 * ordinary outcome, not an error.
 */

/** TIFF field types, from TIFF 6.0 §2 and the BigTIFF extension. Keyed by type code. */
const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  16: 8, // LONG8   (BigTIFF)
  17: 8, // SLONG8  (BigTIFF)
  18: 8, // IFD8    (BigTIFF)
};

export interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  /** Where the value lives, or the inline bytes when it fits inside the entry itself. */
  offset: number;
  inline: Buffer | null;
}

export interface TiffDirectory {
  bigTiff: boolean;
  littleEndian: boolean;
  entries: Map<number, TiffEntry>;
  /** True when at least one entry's value lies outside the buffer we were given. */
  truncated: boolean;
}

/**
 * Parse the first IFD. Returns `null` for anything that is not a readable TIFF header — the
 * refusal message for that case belongs to `inspectGeoTiff`, not here.
 */
export function readTiffDirectory(buf: Buffer): TiffDirectory | null {
  if (buf.length < 16) return null;
  const order = buf.toString('ascii', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;

  const le = order === 'II';
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o: number) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));

  const magic = u16(2);
  if (magic !== 42 && magic !== 43) return null;
  const bigTiff = magic === 43;

  let entriesStart: number;
  let entryCount: number;
  let entrySize: number;
  let inlineBytes: number;

  if (bigTiff) {
    if (u16(4) !== 8) return null;
    const ifd = u64(8);
    if (ifd + 8 > buf.length) return null;
    entryCount = u64(ifd);
    entriesStart = ifd + 8;
    entrySize = 20;
    inlineBytes = 8;
  } else {
    const ifd = u32(4);
    if (ifd + 2 > buf.length) return null;
    entryCount = u16(ifd);
    entriesStart = ifd + 2;
    entrySize = 12;
    inlineBytes = 4;
  }

  if (entryCount === 0 || entryCount > 4096) return null;
  if (entriesStart + entryCount * entrySize > buf.length) return null;

  const entries = new Map<number, TiffEntry>();
  let truncated = false;

  for (let i = 0; i < entryCount; i++) {
    const at = entriesStart + i * entrySize;
    const tag = u16(at);
    const type = u16(at + 2);
    const count = bigTiff ? u64(at + 4) : u32(at + 4);
    const valueAt = at + (bigTiff ? 12 : 8);

    const size = TYPE_SIZE[type];
    // An unknown type is not a reason to abandon the whole directory: TIFF 6.0 §2 tells
    // readers to skip fields they do not understand rather than refuse the file.
    if (size === undefined) continue;

    const bytes = size * count;
    if (bytes <= inlineBytes) {
      entries.set(tag, {
        tag,
        type,
        count,
        offset: valueAt,
        inline: buf.subarray(valueAt, valueAt + bytes),
      });
    } else {
      const offset = bigTiff ? u64(valueAt) : u32(valueAt);
      if (offset + bytes > buf.length) truncated = true;
      entries.set(tag, { tag, type, count, offset, inline: null });
    }
  }

  return { bigTiff, littleEndian: le, entries, truncated };
}

/** Numeric values of one field, or `undefined` when it is absent or outside the buffer. */
export function readNumbers(
  buf: Buffer,
  dir: TiffDirectory,
  tag: number,
  max = 64,
): number[] | undefined {
  const e = dir.entries.get(tag);
  if (!e) return undefined;
  const size = TYPE_SIZE[e.type];
  if (size === undefined) return undefined;

  const src = e.inline ?? buf.subarray(e.offset, e.offset + size * e.count);
  const le = dir.littleEndian;
  const n = Math.min(e.count, max);
  const out: number[] = [];

  for (let i = 0; i < n; i++) {
    const o = i * size;
    if (o + size > src.length) break;
    switch (e.type) {
      case 1:
      case 7:
        out.push(src.readUInt8(o));
        break;
      case 3:
        out.push(le ? src.readUInt16LE(o) : src.readUInt16BE(o));
        break;
      case 4:
      case 18:
        out.push(le ? src.readUInt32LE(o) : src.readUInt32BE(o));
        break;
      case 6:
        out.push(src.readInt8(o));
        break;
      case 8:
        out.push(le ? src.readInt16LE(o) : src.readInt16BE(o));
        break;
      case 9:
        out.push(le ? src.readInt32LE(o) : src.readInt32BE(o));
        break;
      case 5:
      case 10: {
        const num = le ? src.readUInt32LE(o) : src.readUInt32BE(o);
        const den = le ? src.readUInt32LE(o + 4) : src.readUInt32BE(o + 4);
        out.push(den === 0 ? 0 : num / den);
        break;
      }
      case 11:
        out.push(le ? src.readFloatLE(o) : src.readFloatBE(o));
        break;
      case 12:
        out.push(le ? src.readDoubleLE(o) : src.readDoubleBE(o));
        break;
      case 16:
      case 17:
        out.push(Number(le ? src.readBigUInt64LE(o) : src.readBigUInt64BE(o)));
        break;
      default:
        return undefined;
    }
  }
  return out.length > 0 ? out : undefined;
}

/** The first numeric value of a field — the common case for SHORT/LONG scalars. */
export function readNumber(buf: Buffer, dir: TiffDirectory, tag: number): number | undefined {
  return readNumbers(buf, dir, tag, 1)?.[0];
}

/** An ASCII field, NUL-trimmed. */
export function readAscii(
  buf: Buffer,
  dir: TiffDirectory,
  tag: number,
  maxBytes = 64 * 1024,
): string | undefined {
  const e = dir.entries.get(tag);
  if (!e || (e.type !== 1 && e.type !== 2 && e.type !== 7)) return undefined;
  const len = Math.min(e.count, maxBytes);
  const src = e.inline ?? buf.subarray(e.offset, e.offset + len);
  if (src.length === 0) return undefined;
  return src.toString('latin1').replace(/\0+$/g, '').trim() || undefined;
}

/**
 * The GeoKeyDirectory (34735), decoded into a key → value map.
 *
 * A geokey can hold its value inline, or point into the ASCII (34737) or DOUBLE (34736)
 * parameter arrays. All three are resolved here so callers see values, not indirection.
 */
export function readGeoKeys(buf: Buffer, dir: TiffDirectory): Map<number, number | string> {
  const out = new Map<number, number | string>();
  const raw = readNumbers(buf, dir, 34735, 4 + 4 * 256);
  if (!raw || raw.length < 4) return out;

  const keyCount = raw[3]!;
  const ascii = readAscii(buf, dir, 34737) ?? '';
  const doubles = readNumbers(buf, dir, 34736, 256) ?? [];

  for (let i = 0; i < keyCount; i++) {
    const at = 4 + i * 4;
    if (at + 3 >= raw.length) break;
    const keyId = raw[at]!;
    const location = raw[at + 1]!;
    const count = raw[at + 2]!;
    const value = raw[at + 3]!;

    if (location === 0) out.set(keyId, value);
    else if (location === 34737) {
      out.set(keyId, ascii.slice(value, value + count).replace(/\|$/, ''));
    } else if (location === 34736 && doubles[value] !== undefined) {
      out.set(keyId, doubles[value]!);
    }
  }
  return out;
}
