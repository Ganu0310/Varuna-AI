import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { AIS_SENTINELS } from '@varuna/shared';
import { logger } from '../../lib/logger.js';
import { recordProvenance } from '../provenance/service.js';

/**
 * Bulk AIS import from a NOAA Marine Cadastre CSV export — 06_BACKEND §6.6, 10_DATASETS §10.4.
 *
 * The transforms here are not cosmetic; each one prevents a specific, documented way of
 * corrupting an attribution result:
 *
 *  • SENTINELS. AIS encodes "unknown" as in-band numbers: SOG 102.3, COG 360.0, HDG 511.
 *    Stored as numbers they become a vessel doing 102 knots on a course of 360°, which
 *    poisons speed-consistency and heading-alignment scoring. They MUST be null.
 *  • COORDINATE ORDER. The CSV carries WKT `POINT (lon lat)`. GeoJSON is also [lon, lat],
 *    so this is a straight copy — but it is asserted rather than assumed.
 *  • MMSI VALIDITY. A 9-digit MMSI whose leading MID is not an assigned country prefix is
 *    malformed or spoofed; it is flagged, not silently trusted.
 *  • DEDUPLICATION. Exports overlap at file boundaries. `ais_positions` is a time-series
 *    collection and cannot carry a unique index, so duplicates are filtered in-process on a
 *    (mmsi, second, rounded position) key.
 */

export interface AisImportOptions {
  filePath: string;
  /** ISO bounds; rows outside are skipped without being parsed further. */
  from: string;
  to: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  batchSize?: number;
  source?: string;
}

export interface AisImportResult {
  read: number;
  imported: number;
  skippedOutOfWindow: number;
  skippedOutOfBbox: number;
  skippedUnparseable: number;
  duplicates: number;
  flagged: {
    mmsiInvalid: number;
    sentinelSog: number;
    sentinelCog: number;
    sentinelHeading: number;
  };
  distinctMmsi: number;
  provenanceId: string;
  batchId: string;
}

const POINT_RE = /^POINT \((-?[\d.]+) (-?[\d.]+)\)$/;

/** ITU MID table, vendored — data/reference/mid-table.json (10_DATASETS §10.7). */
let MIDS: Set<string> | null = null;
async function loadMids(): Promise<Set<string>> {
  if (MIDS) return MIDS;
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(
      resolve(here, '../../../../../data/reference/mid-table.json'),
      'utf8',
    );
    MIDS = new Set(Object.keys(JSON.parse(raw) as Record<string, unknown>));
  } catch {
    logger.warn('ITU MID table unavailable — MMSI country validation is disabled for this run');
    MIDS = new Set();
  }
  return MIDS;
}

/** Null unless the value is a real measurement (10_DATASETS §10.4.6). */
function num(raw: string | undefined, sentinel?: number): number | null {
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  if (sentinel !== undefined && Math.abs(v - sentinel) < 1e-6) return null;
  return v;
}

function splitCsvLine(line: string): string[] {
  // The geometry column contains no commas inside its parentheses in this export, but
  // vessel names can be quoted — handle quotes properly rather than a naive split.
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export async function importAisCsv(opts: AisImportOptions): Promise<AisImportResult> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('importAisCsv requires an established mongo connection');

  const mids = await loadMids();
  const batchSize = opts.batchSize ?? 5000;
  const source = opts.source ?? 'MARINE_CADASTRE';
  const fromMs = Date.parse(opts.from);
  const toMs = Date.parse(opts.to);
  const [west, south, east, north] = opts.bbox;

  const batchId = createHash('sha256')
    .update(`${opts.filePath}:${opts.from}:${opts.to}`)
    .digest('hex')
    .slice(0, 16);

  const provenanceId = await recordProvenance({
    sourceType: 'AIS_ARCHIVE',
    provider: 'NOAA Marine Cadastre',
    datasetId: 'AIS Vessel Traffic Data',
    externalId: `${opts.filePath.split(/[\\/]/).pop()} [${opts.from}..${opts.to}]`,
    licence: 'U.S. Government work — public domain',
    accessUrl: 'https://marinecadastre.gov/accessais/',
    derivedFrom: [],
  });

  const res: AisImportResult = {
    read: 0,
    imported: 0,
    skippedOutOfWindow: 0,
    skippedOutOfBbox: 0,
    skippedUnparseable: 0,
    duplicates: 0,
    flagged: { mmsiInvalid: 0, sentinelSog: 0, sentinelCog: 0, sentinelHeading: 0 },
    distinctMmsi: 0,
    provenanceId,
    batchId,
  };

  const collection = db.collection('ais_positions');
  const seen = new Set<string>();
  const mmsis = new Set<number>();
  let batch: Record<string, unknown>[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    await collection.insertMany(batch, { ordered: false });
    res.imported += batch.length;
    batch = [];
  };

  const rl = createInterface({
    input: createReadStream(opts.filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let header: string[] | null = null;
  let idx: Record<string, number> = {};

  for await (const line of rl) {
    if (!header) {
      header = splitCsvLine(line).map((h) => h.trim());
      idx = Object.fromEntries(header.map((h, i) => [h, i]));
      continue;
    }
    if (!line) continue;
    res.read += 1;

    const f = splitCsvLine(line);

    // Cheapest rejections first — the window filter avoids parsing most of the file.
    const tRaw = f[idx.base_date_time!];
    if (!tRaw) {
      res.skippedUnparseable += 1;
      continue;
    }
    const tMs = Date.parse(`${tRaw.replace(' ', 'T')}Z`);
    if (!Number.isFinite(tMs)) {
      res.skippedUnparseable += 1;
      continue;
    }
    if (tMs < fromMs || tMs > toMs) {
      res.skippedOutOfWindow += 1;
      continue;
    }

    const m = POINT_RE.exec((f[idx.geometry!] ?? '').trim());
    if (!m) {
      res.skippedUnparseable += 1;
      continue;
    }
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    if (lon < west || lon > east || lat < south || lat > north) {
      res.skippedOutOfBbox += 1;
      continue;
    }

    const mmsi = Number(f[idx.mmsi!]);
    if (!Number.isInteger(mmsi) || mmsi <= 0) {
      res.skippedUnparseable += 1;
      continue;
    }

    // Dedup key: same vessel, same second, same position to ~1 m.
    const key = `${mmsi}:${Math.floor(tMs / 1000)}:${lat.toFixed(5)}:${lon.toFixed(5)}`;
    if (seen.has(key)) {
      res.duplicates += 1;
      continue;
    }
    seen.add(key);

    const sogRaw = f[idx.sog!];
    const cogRaw = f[idx.cog!];
    const hdgRaw = f[idx.heading!];
    const sog = num(sogRaw, AIS_SENTINELS.sog);
    const cog = num(cogRaw, AIS_SENTINELS.cog);
    const heading = num(hdgRaw, AIS_SENTINELS.heading);

    if (sog === null && sogRaw) res.flagged.sentinelSog += 1;
    if (cog === null && cogRaw) res.flagged.sentinelCog += 1;
    if (heading === null && hdgRaw) res.flagged.sentinelHeading += 1;

    const flags: string[] = [];
    const mid = String(mmsi).slice(0, 3);
    if (String(mmsi).length !== 9 || (mids.size > 0 && !mids.has(mid))) {
      flags.push('MMSI_INVALID');
      res.flagged.mmsiInvalid += 1;
    }

    mmsis.add(mmsi);
    batch.push({
      t: new Date(tMs),
      meta: { mmsi, source, ingestBatchId: batchId },
      position: { type: 'Point', coordinates: [lon, lat] },
      sog,
      cog,
      heading,
      rot: null,
      navStatus: num(f[idx.status!]),
      draught: num(f[idx.draft!]),
      quality: { flags, impliedSpeedKn: null },
      provenanceId,
    });

    if (batch.length >= batchSize) await flush();
  }

  await flush();
  res.distinctMmsi = mmsis.size;
  return res;
}
