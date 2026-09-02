import type { Polygon } from 'geojson';
import { readAscii, readGeoKeys, readNumber, readNumbers, readTiffDirectory } from './tiffTags.js';

/**
 * What an uploaded scene can say about itself — 06_BACKEND §6.4.4.
 *
 * An analyst arriving with a GeoTIFF had to retype what the file already contains: its
 * coordinate system, its size, its pixel spacing, and — the one that matters — when the radar
 * observed it. Retyping is where the errors are, and one of those errors is silent: a wrong
 * acquisition instant returns real AIS positions of real ships that were simply somewhere
 * else, and ranks them confidently.
 *
 * So this module reads the file and reports what IT says, with one rule running through the
 * whole thing: **a value is only ever adopted when the file states it unambiguously, and the
 * record always names where it came from.** Nothing is guessed, nothing is averaged, and a
 * weak signal is offered as a suggestion the analyst must accept rather than a default they
 * must notice and undo (13_REAL_DATA_POLICY §13.2).
 *
 * The authoritative geodetic read still happens in the ML service, where pyproj can construct
 * a CRS properly. Everything derived here is a preview, and is labelled as one.
 */

// ── TIFF tags read here ───────────────────────────────────────────────
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_IMAGE_DESCRIPTION = 270;
const TAG_SOFTWARE = 305;
const TAG_DATETIME = 306;
const TAG_TILE_WIDTH = 322;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_SAMPLE_FORMAT = 339;
const TAG_MODEL_PIXEL_SCALE = 33550;
const TAG_MODEL_TIEPOINT = 33922;
const TAG_MODEL_TRANSFORMATION = 34264;
const TAG_GDAL_METADATA = 42112;
const TAG_GDAL_NODATA = 42113;

// ── GeoTIFF keys ──────────────────────────────────────────────────────
const KEY_GEOGRAPHIC_TYPE = 2048;
const KEY_GEOG_CITATION = 2049;
const KEY_PROJECTED_TYPE = 3072;
const KEY_PCS_CITATION = 3073;

/** How far a stated instant may be trusted, and why. */
export type AcquisitionConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface AcquisitionCandidate {
  /** ISO 8601 UTC. */
  value: string;
  /** Where in the file (or its name) this came from — shown to the analyst verbatim. */
  source: string;
  confidence: AcquisitionConfidence;
  /** Why it carries that confidence. This is the sentence the analyst decides on. */
  note: string;
}

export interface ExtractedSceneMetadata {
  /** False when the buffer is not a readable TIFF header at all. */
  readable: boolean;
  /** True when some values live past the end of the buffer we were given (a header slice). */
  truncated: boolean;
  bigTiff: boolean;

  width: number | null;
  height: number | null;
  bandCount: number | null;
  /** e.g. "float32", "uint16" — the ML service refuses dB-scaled products, this is the hint. */
  sampleType: string | null;
  tiled: boolean;
  compression: number | null;
  noData: string | null;

  /** "EPSG:32643" when the file names one, else the citation string, else null. */
  crs: string | null;
  crsSource: string | null;
  /** Ground sample distance in the CRS's own units (metres for a projected CRS). */
  pixelSize: { x: number; y: number } | null;
  /** Metres, only when the CRS is metric. Degrees do not convert without a latitude. */
  gsdMeters: number | null;

  /** Preview footprint in WGS84, when the CRS is one this reader can invert. */
  footprint: Polygon | null;
  /** Why there is no footprint, when there is none. */
  footprintNote: string | null;
  centre: { lon: number; lat: number } | null;

  /** Everything the file or its name says about when this was observed, ranked. */
  acquisitionCandidates: AcquisitionCandidate[];
  /**
   * The one value safe to adopt without asking, or null. Only ever set from a HIGH-confidence
   * source, and never when two HIGH sources disagree.
   */
  acquiredAt: string | null;
  acquiredAtSource: string | null;
  /** Present when HIGH sources disagree — the analyst is told, not silently given one. */
  acquisitionConflict: string | null;

  /** Read off a mission product identifier in the filename, when it follows one. */
  platform: string | null;
  mode: string | null;
  polarisations: string[];

  /** Raw key/value pairs GDAL wrote into tag 42112, kept for display. */
  gdalMetadata: Record<string, string>;
  software: string | null;
  imageDescription: string | null;
}

// ── time parsing ──────────────────────────────────────────────────────

/**
 * Everything is UTC. A timestamp in a GeoTIFF carries no zone, and the whole system works in
 * UTC and labels every instant it shows with Z — so a naive value is read as UTC rather than
 * as the server's local time, which would shift the AIS search window by hours.
 */
function toIsoUtc(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  let ms: number | null = null;

  // Compact mission form: 20230115T012345
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (compact) {
    const [, y, mo, d, h, mi, sec] = compact;
    ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}Z`);
  }

  // TIFF 6.0 DateTime: "2023:01:15 01:23:45"
  if (ms === null) {
    const tiff = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (tiff) {
      const [, y, mo, d, h, mi, sec] = tiff;
      ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}Z`);
    }
  }

  // ISO 8601, with or without a zone. Without one it is read as UTC.
  if (ms === null) {
    const iso =
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
        s,
      );
    if (iso) {
      const zone = iso[7] ?? 'Z';
      ms = Date.parse(
        `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6]}${zone === 'Z' ? 'Z' : zone}`,
      );
    }
  }

  if (ms === null || Number.isNaN(ms)) return null;

  // Plausibility. Spaceborne SAR starts with ERS-1 in 1991; a future instant is a parse error
  // or a broken clock, and either way it must not become an AIS search window.
  const year = new Date(ms).getUTCFullYear();
  if (year < 1991 || ms > Date.now() + 24 * 3600_000) return null;

  return new Date(ms).toISOString();
}

// ── mission product identifiers ───────────────────────────────────────

const S1_POLARISATIONS: Record<string, string[]> = {
  SDV: ['VV', 'VH'],
  SSV: ['VV'],
  SDH: ['HH', 'HV'],
  SSH: ['HH'],
};

interface MissionRead {
  platform: string | null;
  mode: string | null;
  polarisations: string[];
  candidate: AcquisitionCandidate | null;
}

/**
 * Mission naming conventions are specifications, not conventions — the sensing start time is
 * part of the product identifier, and a file still carrying that name is stating when it was
 * observed. That is the strongest signal available outside the provider's own catalogue,
 * which is why it is the only one adopted without asking.
 */
function readMissionName(name: string | undefined): MissionRead {
  const empty: MissionRead = { platform: null, mode: null, polarisations: [], candidate: null };
  if (!name) return empty;
  const base = name.replace(/\.[A-Za-z0-9]+$/, '');

  // Sentinel-1: S1A_IW_GRDH_1SDV_20230115T012345_20230115T012410_...
  const s1 = /(S1[ABCD])_(IW|EW|SM|WV)_([A-Z]{3}[FHM_])_1([SA][DS][VH])_(\d{8}T\d{6})_/i.exec(base);
  if (s1) {
    const value = toIsoUtc(s1[5]!.toUpperCase());
    return {
      platform: s1[1]!.toUpperCase(),
      mode: s1[2]!.toUpperCase(),
      polarisations: S1_POLARISATIONS[s1[4]!.toUpperCase()] ?? [],
      candidate: value
        ? {
            value,
            source: `Sentinel-1 product identifier in the filename (${s1[0]!.slice(0, -1)})`,
            confidence: 'HIGH',
            note:
              'The sensing start time is part of the Sentinel-1 product name, written by the ' +
              'ground segment. It is what the provider catalogue would report for this product.',
          }
        : null,
    };
  }

  // Sentinel-2: S2A_MSIL1C_20230115T012345_N0509_R002_T43QCV_...
  const s2 = /(S2[ABCD])_MSIL[12][ABC]_(\d{8}T\d{6})/i.exec(base);
  if (s2) {
    const value = toIsoUtc(s2[2]!.toUpperCase());
    return {
      platform: s2[1]!.toUpperCase(),
      mode: null,
      polarisations: [],
      candidate: value
        ? {
            value,
            source: 'Sentinel-2 product identifier in the filename',
            confidence: 'HIGH',
            note: 'The datatake sensing time is part of the Sentinel-2 product name.',
          }
        : null,
    };
  }

  // Sentinel-3: S3A_SL_1_RBT____20230115T012345_...
  const s3 = /(S3[AB])_[A-Z]{2}_[0-9]_[A-Z_]{6}_(\d{8}T\d{6})/i.exec(base);
  if (s3) {
    const value = toIsoUtc(s3[2]!.toUpperCase());
    return {
      platform: s3[1]!.toUpperCase(),
      mode: null,
      polarisations: [],
      candidate: value
        ? {
            value,
            source: 'Sentinel-3 product identifier in the filename',
            confidence: 'HIGH',
            note: 'The sensing start time is part of the Sentinel-3 product name.',
          }
        : null,
    };
  }

  // Landsat Collection 2: LC08_L1TP_144046_20230115_20230123_02_T1 — a DATE, with no time.
  const ls = /(L[COTEM]\d{2})_[A-Z0-9]{4}_\d{6}_(\d{8})_\d{8}_/i.exec(base);
  if (ls) {
    const d = ls[2]!;
    const value = toIsoUtc(`${d}T000000`);
    return {
      platform: ls[1]!.toUpperCase(),
      mode: null,
      polarisations: [],
      candidate: value
        ? {
            value,
            source: 'Landsat scene identifier in the filename (date only)',
            confidence: 'LOW',
            note:
              'The Landsat scene id carries the acquisition DATE but not the time of day, so ' +
              'this reads as midnight UTC and can be wrong by up to twelve hours. AIS is ' +
              'searched around this instant — supply the overpass time from the metadata file.',
          }
        : null,
    };
  }

  // Anything else that carries a full compact timestamp. Real, but the writer is unknown, so
  // it is offered rather than adopted.
  const generic = /(?:^|[^0-9])(\d{8}T\d{6})(?:[^0-9]|$)/.exec(base);
  if (generic) {
    const value = toIsoUtc(generic[1]!);
    if (value) {
      return {
        platform: null,
        mode: null,
        polarisations: [],
        candidate: {
          value,
          source: 'Timestamp in the filename',
          confidence: 'MEDIUM',
          note:
            'The filename contains a full timestamp but follows no mission naming convention ' +
            'this reader knows, so it cannot be confirmed as the sensing time rather than, ' +
            'say, the time the file was exported. Check it before accepting.',
        },
      };
    }
  }

  return empty;
}

// ── GDAL metadata (tag 42112) ─────────────────────────────────────────

function parseGdalMetadata(xml: string | undefined): Record<string, string> {
  if (!xml) return {};
  const out: Record<string, string> = {};
  const re = /<Item\b([^>]*)>([\s\S]*?)<\/Item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && Object.keys(out).length < 200) {
    const name = /name\s*=\s*"([^"]*)"/.exec(m[1]!)?.[1];
    if (!name) continue;
    out[name] = m[2]!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .trim();
  }
  return out;
}

/** Keys that mean "when the sensor observed this". */
const ACQUISITION_KEY =
  /(acquisition|sensing[_ ]?start|start[_ ]?datetime|first[_ ]?line[_ ]?time|zero[_ ]?doppler|imaging[_ ]?(date|time)|observation[_ ]?(date|time)|product[_ ]?start[_ ]?time)/i;
/** Keys that mean "when the FILE was made". Never the same thing, and never adopted. */
const PRODUCTION_KEY =
  /(process|product(ion)?[_ ]?date|generat|creat|writ|export|ingest|download)/i;

function gdalCandidates(meta: Record<string, string>): AcquisitionCandidate[] {
  const out: AcquisitionCandidate[] = [];
  for (const [key, raw] of Object.entries(meta)) {
    const value = toIsoUtc(raw);
    if (!value) continue;

    if (ACQUISITION_KEY.test(key) && !PRODUCTION_KEY.test(key)) {
      out.push({
        value,
        source: `GDAL metadata: ${key}`,
        confidence: 'HIGH',
        note: 'The writer recorded this as the acquisition time in the file itself.',
      });
    } else if (PRODUCTION_KEY.test(key)) {
      out.push({
        value,
        source: `GDAL metadata: ${key}`,
        confidence: 'LOW',
        note:
          'This key names when the FILE was produced, not when the radar observed the scene. ' +
          'For a re-exported product it is the day someone opened it in a GIS.',
      });
    } else if (/date|time/i.test(key)) {
      out.push({
        value,
        source: `GDAL metadata: ${key}`,
        confidence: 'MEDIUM',
        note: 'A timestamp under a key whose meaning this reader cannot determine.',
      });
    }
  }
  return out;
}

// ── coordinate transforms ─────────────────────────────────────────────

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const UTM_K0 = 0.9996;

/**
 * Inverse UTM, on the WGS84 ellipsoid (Snyder 1987, §8).
 *
 * Enough for a preview footprint — sub-metre against pyproj, and the map is showing a box
 * a hundred kilometres across. The authoritative reprojection still happens in the ML
 * service; nothing here is written to a scene record.
 */
function utmToWgs84(
  easting: number,
  northing: number,
  zone: number,
  north: boolean,
): [number, number] {
  const e2 = WGS84_F * (2 - WGS84_F);
  const ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const x = easting - 500000;
  const y = north ? northing : northing - 10000000;

  const m = y / UTM_K0;
  const mu = m / (WGS84_A * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);

  const c1 = ep2 * cos1 * cos1;
  const t1 = tan1 * tan1;
  const n1 = WGS84_A / Math.sqrt(1 - e2 * sin1 * sin1);
  const r1 = (WGS84_A * (1 - e2)) / (1 - e2 * sin1 * sin1) ** 1.5;
  const d = x / (n1 * UTM_K0);

  const lat =
    phi1 -
    ((n1 * tan1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6) / 720);

  const lon =
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5) / 120) /
    cos1;

  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);
  return [(lon0 + lon) * (180 / Math.PI), lat * (180 / Math.PI)];
}

/** Inverse spherical Mercator (EPSG:3857). */
function webMercatorToWgs84(x: number, y: number): [number, number] {
  const lon = (x / 20037508.34) * 180;
  const lat = (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360) / Math.PI - 90;
  return [lon, lat];
}

interface Reprojector {
  fn: (x: number, y: number) => [number, number];
  note: string | null;
}

/**
 * A reprojection for the CRSs an operator upload realistically arrives in, and an honest
 * refusal for the rest. Returning a footprint for a CRS this reader cannot actually invert
 * would put the scene in the wrong ocean on the preview map — exactly the failure the whole
 * upload path exists to prevent.
 */
function reprojectorFor(epsg: number | null): Reprojector | null {
  if (epsg === null) return null;
  if (epsg === 4326 || epsg === 4979) return { fn: (x, y) => [x, y], note: null };
  if (epsg === 3857 || epsg === 900913) return { fn: webMercatorToWgs84, note: null };
  if (epsg >= 32601 && epsg <= 32660) {
    const zone = epsg - 32600;
    return { fn: (x, y) => utmToWgs84(x, y, zone, true), note: null };
  }
  if (epsg >= 32701 && epsg <= 32760) {
    const zone = epsg - 32700;
    return { fn: (x, y) => utmToWgs84(x, y, zone, false), note: null };
  }
  return null;
}

// ── the extractor ─────────────────────────────────────────────────────

const SAMPLE_FORMAT_NAME: Record<number, string> = { 1: 'uint', 2: 'int', 3: 'float' };

export function extractSceneMetadata(buf: Buffer, originalName?: string): ExtractedSceneMetadata {
  const mission = readMissionName(originalName);

  const base: ExtractedSceneMetadata = {
    readable: false,
    truncated: false,
    bigTiff: false,
    width: null,
    height: null,
    bandCount: null,
    sampleType: null,
    tiled: false,
    compression: null,
    noData: null,
    crs: null,
    crsSource: null,
    pixelSize: null,
    gsdMeters: null,
    footprint: null,
    footprintNote: null,
    centre: null,
    acquisitionCandidates: [],
    acquiredAt: null,
    acquiredAtSource: null,
    acquisitionConflict: null,
    platform: mission.platform,
    mode: mission.mode,
    polarisations: mission.polarisations,
    gdalMetadata: {},
    software: null,
    imageDescription: null,
  };

  const dir = readTiffDirectory(buf);
  if (!dir) {
    // Still report what the NAME said. It is the one thing readable without the header, and
    // a truncated slice of a real GeoTIFF is a normal case for the inspect route.
    if (mission.candidate) base.acquisitionCandidates = [mission.candidate];
    return base;
  }

  base.readable = true;
  base.truncated = dir.truncated;
  base.bigTiff = dir.bigTiff;

  base.width = readNumber(buf, dir, TAG_IMAGE_WIDTH) ?? null;
  base.height = readNumber(buf, dir, TAG_IMAGE_LENGTH) ?? null;
  base.bandCount = readNumber(buf, dir, TAG_SAMPLES_PER_PIXEL) ?? null;
  base.compression = readNumber(buf, dir, TAG_COMPRESSION) ?? null;
  base.tiled = dir.entries.has(TAG_TILE_WIDTH);
  base.noData = readAscii(buf, dir, TAG_GDAL_NODATA) ?? null;
  base.software = readAscii(buf, dir, TAG_SOFTWARE) ?? null;
  base.imageDescription = readAscii(buf, dir, TAG_IMAGE_DESCRIPTION, 4096) ?? null;

  const bits = readNumber(buf, dir, TAG_BITS_PER_SAMPLE);
  const format = readNumber(buf, dir, TAG_SAMPLE_FORMAT) ?? 1;
  if (bits) base.sampleType = `${SAMPLE_FORMAT_NAME[format] ?? 'uint'}${bits}`;

  base.gdalMetadata = parseGdalMetadata(readAscii(buf, dir, TAG_GDAL_METADATA));

  // ── coordinate system ───────────────────────────────────────────────
  const keys = readGeoKeys(buf, dir);
  const projected = keys.get(KEY_PROJECTED_TYPE);
  const geographic = keys.get(KEY_GEOGRAPHIC_TYPE);
  const citation =
    (typeof keys.get(KEY_PCS_CITATION) === 'string'
      ? (keys.get(KEY_PCS_CITATION) as string)
      : null) ??
    (typeof keys.get(KEY_GEOG_CITATION) === 'string'
      ? (keys.get(KEY_GEOG_CITATION) as string)
      : null);

  let epsg: number | null = null;
  // 32767 is GeoTIFF's "user-defined" sentinel — a real code, meaning "not one of ours".
  if (typeof projected === 'number' && projected > 0 && projected !== 32767) epsg = projected;
  else if (typeof geographic === 'number' && geographic > 0 && geographic !== 32767)
    epsg = geographic;
  else if (citation) {
    const fromCitation = /EPSG[:\s]*(\d{4,5})/i.exec(citation);
    if (fromCitation) epsg = Number(fromCitation[1]);
  }

  if (epsg !== null) {
    base.crs = `EPSG:${epsg}`;
    base.crsSource =
      typeof projected === 'number' && projected === epsg
        ? 'ProjectedCSTypeGeoKey'
        : typeof geographic === 'number' && geographic === epsg
          ? 'GeographicTypeGeoKey'
          : 'CRS citation';
  } else if (citation) {
    base.crs = citation;
    base.crsSource = 'CRS citation (no EPSG code)';
  }

  // ── the transform ───────────────────────────────────────────────────
  const scale = readNumbers(buf, dir, TAG_MODEL_PIXEL_SCALE, 3);
  const tiepoint = readNumbers(buf, dir, TAG_MODEL_TIEPOINT, 6);
  const matrix = readNumbers(buf, dir, TAG_MODEL_TRANSFORMATION, 16);

  let originX: number | null = null;
  let originY: number | null = null;
  let stepX: number | null = null;
  let stepY: number | null = null;

  if (scale && scale.length >= 2 && tiepoint && tiepoint.length >= 6 && scale[0] !== 0) {
    // Tiepoint maps raster (i,j) to model (x,y); scale is positive with y increasing downwards.
    originX = tiepoint[3]! - tiepoint[0]! * scale[0]!;
    originY = tiepoint[4]! + tiepoint[1]! * scale[1]!;
    stepX = scale[0]!;
    stepY = -scale[1]!;
  } else if (matrix && matrix.length >= 16 && (matrix[0] !== 0 || matrix[1] !== 0)) {
    // Row-major 4x4; the rotation terms are ignored because a rotated preview box would
    // misstate the extent, and a north-up product is what the pipeline accepts anyway.
    originX = matrix[3]!;
    originY = matrix[7]!;
    stepX = matrix[0]!;
    stepY = matrix[5]!;
  }

  if (stepX !== null && stepY !== null && (stepX !== 0 || stepY !== 0)) {
    base.pixelSize = { x: Math.abs(stepX), y: Math.abs(stepY) };
    // Degrees do not convert to metres without a latitude, and stating a wrong GSD would
    // propagate into every area figure downstream. Left null instead.
    const metric = epsg !== null && epsg !== 4326 && epsg !== 4979;
    if (metric) base.gsdMeters = Math.abs(stepX);
  }

  // ── preview footprint ───────────────────────────────────────────────
  const reprojector = reprojectorFor(epsg);
  if (base.width && base.height && originX !== null && originY !== null && stepX && stepY) {
    if (!reprojector) {
      base.footprintNote = base.crs
        ? `The scene is in ${base.crs}, which this preview cannot invert. The real footprint is ` +
          'computed by the ingest, which resolves the CRS properly.'
        : 'The file names no coordinate system, so its pixels cannot be placed on the Earth.';
    } else {
      // Sampled along each edge rather than corners only: a UTM box is not a lat/lon box, and
      // a four-point ring would understate the extent at the edges.
      const ring: number[][] = [];
      const steps = 8;
      const px = (i: number, j: number): [number, number] =>
        reprojector.fn(originX! + i * stepX, originY! + j * stepY);

      for (let k = 0; k < steps; k++) ring.push(px((base.width * k) / steps, 0));
      for (let k = 0; k < steps; k++) ring.push(px(base.width, (base.height * k) / steps));
      for (let k = steps; k > 0; k--) ring.push(px((base.width * k) / steps, base.height));
      for (let k = steps; k > 0; k--) ring.push(px(0, (base.height * k) / steps));
      ring.push(ring[0]!);

      const finite = ring.every(
        ([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat!) <= 90,
      );
      if (finite) {
        base.footprint = { type: 'Polygon', coordinates: [ring] };
        const lons = ring.map((c) => c[0]!);
        const lats = ring.map((c) => c[1]!);
        base.centre = {
          lon: (Math.min(...lons) + Math.max(...lons)) / 2,
          lat: (Math.min(...lats) + Math.max(...lats)) / 2,
        };
      } else {
        base.footprintNote =
          'The georeferencing in this file does not invert to valid coordinates. The ingest ' +
          'will resolve it properly, or refuse it.';
      }
    }
  } else if (base.readable) {
    base.footprintNote =
      'The file does not carry both a size and a transform in its first directory, so no ' +
      'preview extent could be computed.';
  }

  // ── when was it observed ────────────────────────────────────────────
  const candidates: AcquisitionCandidate[] = [];
  if (mission.candidate) candidates.push(mission.candidate);
  candidates.push(...gdalCandidates(base.gdalMetadata));

  const description = base.imageDescription ? toIsoUtc(base.imageDescription) : null;
  if (description) {
    candidates.push({
      value: description,
      source: 'ImageDescription tag',
      confidence: 'MEDIUM',
      note: 'A timestamp written into the free-text description field. Its meaning is up to whoever wrote it.',
    });
  }

  const tiffDateTime = toIsoUtc(readAscii(buf, dir, TAG_DATETIME) ?? '');
  if (tiffDateTime) {
    candidates.push({
      value: tiffDateTime,
      source: 'TIFFTAG_DATETIME',
      confidence: 'LOW',
      note:
        'TIFFTAG_DATETIME records when the FILE was written — for a re-exported product, the ' +
        'day someone opened it in a GIS. It is shown because it is often close, and never ' +
        'adopted because it is often not.',
    });
  }

  // De-duplicate on instant + source, keeping the strongest statement of each.
  const rank: Record<AcquisitionConfidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const seen = new Set<string>();
  base.acquisitionCandidates = candidates
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.value.localeCompare(b.value))
    .filter((c) => {
      const k = `${c.value}|${c.source}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  const high = base.acquisitionCandidates.filter((c) => c.confidence === 'HIGH');
  if (high.length > 0) {
    const times = high.map((c) => Date.parse(c.value));
    const spreadSec = (Math.max(...times) - Math.min(...times)) / 1000;
    if (spreadSec <= 300) {
      // Within one acquisition. The earliest is the sensing start, which is the instant the
      // provider catalogues and the instant the AIS window should be centred on.
      const earliest = high.reduce((a, b) => (Date.parse(a.value) <= Date.parse(b.value) ? a : b));
      base.acquiredAt = earliest.value;
      base.acquiredAtSource = earliest.source;
    } else {
      base.acquisitionConflict =
        `The file states more than one acquisition time, ${Math.round(spreadSec / 60)} minutes ` +
        'apart: ' +
        high.map((c) => `${c.value} (${c.source})`).join(', ') +
        '. They cannot both be right, so none was adopted — pick the one that matches the ' +
        'overpass.';
    }
  }

  if (!base.platform) {
    const fromMeta =
      base.gdalMetadata.PLATFORM ?? base.gdalMetadata.platform ?? base.gdalMetadata.MISSION;
    if (fromMeta) base.platform = fromMeta.slice(0, 40);
  }

  return base;
}
