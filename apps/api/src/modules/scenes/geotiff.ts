/**
 * Is this actually a georeferenced GeoTIFF?
 *
 * An uploaded scene is the one input to this system that arrives with no provider behind it,
 * so it is the one input that must be checked hardest. 06_BACKEND §6.4.4 requires the upload
 * path to REJECT rather than coerce, and the failure being guarded against is specific: a
 * plain TIFF, a renamed PNG, or a GeoTIFF stripped of its georeferencing all load fine as
 * pixels. Detection would run happily and produce polygons in pixel space that are then
 * written out as if they were coordinates on the Earth. The result looks exactly like a real
 * detection and is somewhere in the Gulf of Guinea.
 *
 * This reads the TIFF directory itself rather than trusting the extension or the MIME type,
 * both of which are supplied by the client. It is a header check, not a full decode — the
 * authoritative read happens in the ML service where rasterio can resolve the CRS properly —
 * but it is enough to refuse the three failures above at the boundary, before anything is
 * stored or queued.
 */

/** GeoTIFF tags, from the OGC GeoTIFF 1.1 specification. */
const TAG_GEO_KEY_DIRECTORY = 34735;
const TAG_MODEL_PIXEL_SCALE = 33550;
const TAG_MODEL_TIEPOINT = 33922;
const TAG_MODEL_TRANSFORMATION = 34264;

export interface GeoTiffCheck {
  ok: boolean;
  /** Why it was refused — phrased for the analyst who uploaded it, not for a log. */
  reason?: string;
  bigTiff?: boolean;
  tagCount?: number;
}

export function inspectGeoTiff(buf: Buffer): GeoTiffCheck {
  if (buf.length < 16) {
    return { ok: false, reason: 'The file is too small to be a GeoTIFF.' };
  }

  // Byte order comes from the file, not from the host. A TIFF written on a big-endian machine
  // is still a valid TIFF, and assuming little-endian would reject it for the wrong reason.
  const order = buf.toString('ascii', 0, 2);
  if (order !== 'II' && order !== 'MM') {
    return {
      ok: false,
      reason:
        'This is not a TIFF file. The first two bytes are neither "II" nor "MM", so whatever ' +
        'the extension says, the contents are something else.',
    };
  }
  const le = order === 'II';
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o: number) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));

  const magic = u16(2);
  if (magic !== 42 && magic !== 43) {
    return { ok: false, reason: 'This is not a TIFF file: the version marker is missing.' };
  }

  // BigTIFF (magic 43) is a different directory layout. Sentinel-1 GRD products converted to
  // COG routinely exceed 4 GB, so refusing it outright would refuse real data.
  const bigTiff = magic === 43;
  let ifdOffset: number;
  let entryCount: number;
  let entrySize: number;
  let entriesStart: number;

  if (bigTiff) {
    if (u16(4) !== 8) return { ok: false, reason: 'Unsupported BigTIFF offset size.' };
    ifdOffset = u64(8);
    if (ifdOffset + 8 > buf.length) return { ok: false, reason: 'The file is truncated.' };
    entryCount = u64(ifdOffset);
    entriesStart = ifdOffset + 8;
    entrySize = 20;
  } else {
    ifdOffset = u32(4);
    if (ifdOffset + 2 > buf.length) return { ok: false, reason: 'The file is truncated.' };
    entryCount = u16(ifdOffset);
    entriesStart = ifdOffset + 2;
    entrySize = 12;
  }

  if (entryCount === 0 || entryCount > 4096) {
    return { ok: false, reason: 'The TIFF directory is empty or implausibly large.' };
  }
  if (entriesStart + entryCount * entrySize > buf.length) {
    return {
      ok: false,
      reason:
        'The file is truncated: its directory claims more entries than the file contains. ' +
        'This usually means the upload was interrupted.',
    };
  }

  const tags = new Set<number>();
  for (let i = 0; i < entryCount; i++) {
    tags.add(u16(entriesStart + i * entrySize));
  }

  if (!tags.has(TAG_GEO_KEY_DIRECTORY)) {
    return {
      ok: false,
      tagCount: tags.size,
      bigTiff,
      reason:
        'This is a plain TIFF, not a GeoTIFF: it carries no GeoKeyDirectory, so it does not ' +
        'state which coordinate reference system its pixels are in. Detections from it would ' +
        'be positioned by guesswork. Export it with georeferencing and upload again.',
    };
  }

  // A CRS says which system; a tiepoint or transformation says where in it. Both are needed:
  // a GeoTIFF with a CRS and no tiepoint pins the pixels to no location at all.
  const positioned =
    (tags.has(TAG_MODEL_TIEPOINT) && tags.has(TAG_MODEL_PIXEL_SCALE)) ||
    tags.has(TAG_MODEL_TRANSFORMATION);

  if (!positioned) {
    return {
      ok: false,
      tagCount: tags.size,
      bigTiff,
      reason:
        'This GeoTIFF names a coordinate system but does not say where its pixels sit in it ' +
        '(no ModelTiepoint with ModelPixelScale, and no ModelTransformation). It cannot be ' +
        'placed on the Earth.',
    };
  }

  return { ok: true, bigTiff, tagCount: tags.size };
}
