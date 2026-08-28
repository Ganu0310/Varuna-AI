import mongoose, { Types } from 'mongoose';
import type { Polygon } from 'geojson';
import { TRACK_RECONSTRUCTION } from '@varuna/shared';
import { logger } from '../../lib/logger.js';
import { geodesicDistanceKm } from '../../geo/geodesy.js';
import { VesselTrackModel } from './model.js';
import { reconstructTracks, type ReconstructedTrack } from './tracks.js';

/**
 * AIS query and track services — 06_BACKEND §6.4.7, §6.6.
 *
 * The theme of this module is that the AIS evidence base must describe its own limits. An
 * attribution built on AIS is only as good as the AIS coverage underneath it, and a sparse
 * or gappy archive can make an innocent vessel look like the only candidate simply because
 * it was the only one transmitting. `coverage()` therefore exists to be shown BEFORE any
 * ranking (05_FRONTEND §5.5.5).
 */

export interface AisCoverage {
  source: string;
  recordCount: number;
  distinctVessels: number;
  firstAt: string | null;
  lastAt: string | null;
  bbox: [number, number, number, number] | null;
  medianIntervalSec: number | null;
  requestedWindow: { from: string; to: string };
  /** Fraction of the requested window that actually contains fixes. */
  temporalCompleteness: number;
  qualityFlagCounts: Record<string, number>;
  /** Plain statement of what this evidence base can and cannot support. */
  assessment: string;
}

/**
 * Truthful summary of what AIS we actually hold for a window and box.
 *
 * Every number here is measured, never estimated. When there is nothing, it says so rather
 * than returning an empty-but-cheerful shape.
 */
export async function coverage(
  from: string,
  to: string,
  bbox: [number, number, number, number],
): Promise<AisCoverage> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('coverage() requires a mongo connection');

  const [west, south, east, north] = bbox;
  const match = {
    t: { $gte: new Date(from), $lte: new Date(to) },
    position: {
      $geoWithin: {
        $geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      },
    },
  };

  const rows = (await db
    .collection('ais_positions')
    .find(match)
    .project({ t: 1, 'meta.mmsi': 1, 'meta.source': 1, position: 1, quality: 1 })
    .sort({ t: 1 })
    .toArray()) as unknown as Array<{
    t: Date;
    meta: { mmsi: number; source: string };
    position: { coordinates: [number, number] };
    quality?: { flags?: string[] };
  }>;

  const windowMs = Date.parse(to) - Date.parse(from);

  if (rows.length === 0) {
    return {
      source: 'NONE',
      recordCount: 0,
      distinctVessels: 0,
      firstAt: null,
      lastAt: null,
      bbox: null,
      medianIntervalSec: null,
      requestedWindow: { from, to },
      temporalCompleteness: 0,
      qualityFlagCounts: {},
      assessment:
        'No AIS positions are held for this area and window. Vessel attribution cannot be ' +
        'attempted: an empty evidence base is not the same as an absence of vessels.',
    };
  }

  const mmsis = new Set<number>();
  const sources = new Set<string>();
  const flagCounts: Record<string, number> = {};
  let minLon = 180;
  let minLat = 90;
  let maxLon = -180;
  let maxLat = -90;

  for (const r of rows) {
    mmsis.add(r.meta.mmsi);
    sources.add(r.meta.source);
    const [lon, lat] = r.position.coordinates;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    for (const f of r.quality?.flags ?? []) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  }

  // Median interval between consecutive fixes of the SAME vessel — the interval between
  // fixes of different vessels says nothing about sampling rate.
  const perVessel = new Map<number, number[]>();
  for (const r of rows) {
    const list = perVessel.get(r.meta.mmsi) ?? [];
    list.push(r.t.getTime());
    perVessel.set(r.meta.mmsi, list);
  }
  const intervals: number[] = [];
  for (const times of perVessel.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) intervals.push((times[i]! - times[i - 1]!) / 1000);
  }
  intervals.sort((a, b) => a - b);
  const medianIntervalSec = intervals.length ? intervals[Math.floor(intervals.length / 2)]! : null;

  const firstMs = rows[0]!.t.getTime();
  const lastMs = rows[rows.length - 1]!.t.getTime();
  const temporalCompleteness = windowMs > 0 ? Math.min(1, (lastMs - firstMs) / windowMs) : 0;

  return {
    source: [...sources].join(', '),
    recordCount: rows.length,
    distinctVessels: mmsis.size,
    firstAt: new Date(firstMs).toISOString(),
    lastAt: new Date(lastMs).toISOString(),
    bbox: [minLon, minLat, maxLon, maxLat],
    medianIntervalSec,
    requestedWindow: { from, to },
    temporalCompleteness: Math.round(temporalCompleteness * 1000) / 1000,
    qualityFlagCounts: flagCounts,
    assessment: assess(rows.length, mmsis.size, medianIntervalSec, temporalCompleteness),
  };
}

function assess(
  records: number,
  vessels: number,
  medianIntervalSec: number | null,
  temporalCompleteness: number,
): string {
  const parts: string[] = [
    `${records.toLocaleString()} positions from ${vessels} vessel${vessels === 1 ? '' : 's'}.`,
  ];

  if (medianIntervalSec != null) {
    parts.push(
      medianIntervalSec <= 120
        ? `Median reporting interval ${Math.round(medianIntervalSec)} s — dense enough to reconstruct detailed tracks.`
        : medianIntervalSec <= TRACK_RECONSTRUCTION.lowSamplingSec
          ? `Median reporting interval ${Math.round(medianIntervalSec)} s — usable, but short manoeuvres between fixes are not observed.`
          : `Median reporting interval ${Math.round(medianIntervalSec)} s — sparse. Tracks are interpolated over long gaps and positional evidence is correspondingly weak.`,
    );
  }

  if (temporalCompleteness < 0.5) {
    parts.push(
      `Fixes span only ${(temporalCompleteness * 100).toFixed(0)}% of the requested window, so part of it is unobserved.`,
    );
  }

  if (vessels < 5) {
    // Saying this matters: with few vessels, "the only candidate" may simply mean "the only
    // one transmitting", which is a statement about coverage rather than about guilt.
    parts.push(
      'Few vessels are present. A high-ranked candidate here may reflect sparse coverage ' +
        'rather than strong evidence, since vessels not transmitting cannot be considered at all.',
    );
  }

  return parts.join(' ');
}

/**
 * Choose the index hint from the shape of the query — 06_BACKEND §6.4.7.
 *
 * A small box over a long window is best served by `{meta.mmsi, t}`; a large box over a
 * short window by the `2dsphere`. The choice is logged so it can be checked against real
 * `explain()` plans rather than assumed.
 */
export function chooseHint(
  bbox: [number, number, number, number],
  from: string,
  to: string,
): { hint: string; reason: string } {
  const [w, s, e, n] = bbox;
  const areaDeg2 = Math.max(1e-9, (e - w) * (n - s));
  const hours = Math.max(1e-9, (Date.parse(to) - Date.parse(from)) / 3_600_000);
  const ratio = areaDeg2 / hours;

  const choice =
    ratio < 0.01
      ? {
          hint: 'meta.mmsi_1_t_1',
          reason: 'small area over a long window — time-ordered scan is cheaper',
        }
      : {
          hint: 'position_2dsphere',
          reason: 'large area over a short window — spatial index is selective',
        };

  logger.debug({ areaDeg2, hours, ratio, ...choice }, 'ais envelope index hint');
  return choice;
}

export interface DarkPeriod {
  mmsi: number;
  startAt: string;
  endAt: string;
  durationMin: number;
  fromLonLat: [number, number];
  toLonLat: [number, number];
  straightLineKm: number;
  impliedSpeedKn: number;
  overlapsOriginZone: boolean;
}

/**
 * Dark periods, with whether each overlaps the origin zone — 01_PRD FR-4.6.
 *
 * A transmission gap over the origin zone is a documented signature of deliberate
 * discharge. It is also what happens when a vessel passes out of receiver range, so this
 * reports the fact and its geometry and leaves the weighing to the scoring model.
 */
export function darkPeriods(
  tracks: ReconstructedTrack[],
  originZone: Polygon | null,
  releaseFrom?: string,
  releaseTo?: string,
): DarkPeriod[] {
  const out: DarkPeriod[] = [];
  const fromMs = releaseFrom ? Date.parse(releaseFrom) : null;
  const toMs = releaseTo ? Date.parse(releaseTo) : null;

  for (const track of tracks) {
    for (const gap of track.gaps) {
      const startMs = Date.parse(gap.startAt);
      const endMs = Date.parse(gap.endAt);

      if (fromMs !== null && toMs !== null && (endMs < fromMs || startMs > toMs)) continue;

      const straightLineKm = geodesicDistanceKm(gap.fromLonLat, gap.toLonLat) as number;
      const hours = gap.durationMin / 60;
      const impliedSpeedKn = hours > 0 ? straightLineKm / 1.852 / hours : 0;

      out.push({
        mmsi: track.mmsi,
        startAt: gap.startAt,
        endAt: gap.endAt,
        durationMin: gap.durationMin,
        fromLonLat: gap.fromLonLat,
        toLonLat: gap.toLonLat,
        straightLineKm: Math.round(straightLineKm * 1000) / 1000,
        impliedSpeedKn: Math.round(impliedSpeedKn * 100) / 100,
        overlapsOriginZone: originZone
          ? gapCrossesZone(gap.fromLonLat, gap.toLonLat, originZone)
          : false,
      });
    }
  }

  return out.sort((a, b) => b.durationMin - a.durationMin);
}

/**
 * Whether the straight line across a gap enters the origin zone.
 *
 * The vessel's actual path during a gap is unknown by definition, so this tests the
 * straight line between the last and first known fixes — the most conservative
 * interpretation, and one that does not pretend to know the route.
 */
function gapCrossesZone(from: [number, number], to: [number, number], zone: Polygon): boolean {
  const ring = zone.coordinates[0];
  if (!ring) return false;

  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const lon = from[0] + (to[0] - from[0]) * f;
    const lat = from[1] + (to[1] - from[1]) * f;
    if (pointInRing(lon, lat, ring)) return true;
  }
  return false;
}

function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Persist reconstructed tracks as `VesselTrack` documents with provenance. */
export async function persistTracks(
  investigationId: string,
  tracks: ReconstructedTrack[],
  windowStart: string,
  windowEnd: string,
  provenanceId: string,
): Promise<string[]> {
  const ids: string[] = [];

  for (const t of tracks) {
    const segments = t.line
      ? [
          {
            startAt: new Date(t.fixes[0]!.t),
            endAt: new Date(t.fixes[t.fixes.length - 1]!.t),
            pointCount: t.fixes.length,
            geometry: t.line,
            lengthKm: trackLengthKm(t),
            meanSogKn: mean(t.fixes.map((f) => f.sog).filter((s): s is number => s != null)),
            maxSogKn: Math.max(0, ...t.fixes.map((f) => f.sog ?? 0)),
          },
        ]
      : [];

    const flags: string[] = [];
    if (t.removedOutlierCount > 0) flags.push('POSITION_JUMP');
    if (t.gaps.length > 0) flags.push('AIS_GAP');
    if (t.medianIntervalSec > TRACK_RECONSTRUCTION.lowSamplingSec) flags.push('LOW_SAMPLING');

    const doc = await VesselTrackModel.findOneAndUpdate(
      { investigationId: new Types.ObjectId(investigationId), mmsi: t.mmsi },
      {
        $set: {
          investigationId: new Types.ObjectId(investigationId),
          mmsi: t.mmsi,
          shipType: t.shipType,
          windowStart: new Date(windowStart),
          windowEnd: new Date(windowEnd),
          segments,
          gaps: t.gaps.map((g) => ({
            startAt: new Date(g.startAt),
            endAt: new Date(g.endAt),
            durationMin: g.durationMin,
            fromPoint: { type: 'Point', coordinates: g.fromLonLat },
            toPoint: { type: 'Point', coordinates: g.toLonLat },
            straightLineKm: geodesicDistanceKm(g.fromLonLat, g.toLonLat) as number,
            impliedSpeedKn:
              g.durationMin > 0
                ? (geodesicDistanceKm(g.fromLonLat, g.toLonLat) as number) /
                  1.852 /
                  (g.durationMin / 60)
                : 0,
          })),
          quality: {
            flags,
            completeness: completeness(t),
            medianSamplingIntervalSec: t.medianIntervalSec,
            // Removed outliers are counted and surfaced, never silently dropped
            // (06_BACKEND §6.6.3).
            removedOutlierCount: t.removedOutlierCount,
          },
          provenance: {
            sourceType: 'DERIVED',
            provider: 'VARUNA',
            datasetId: 'track-reconstruction-v1',
            externalId: `track:${investigationId}:${t.mmsi}`,
            retrievedAt: new Date(),
            licence: 'internal',
            derivedFrom: [new Types.ObjectId(provenanceId)],
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    ids.push(String(doc._id));
  }

  return ids;
}

function trackLengthKm(t: ReconstructedTrack): number {
  let km = 0;
  for (let i = 1; i < t.fixes.length; i++) {
    km += geodesicDistanceKm(
      [t.fixes[i - 1]!.lon, t.fixes[i - 1]!.lat],
      [t.fixes[i]!.lon, t.fixes[i]!.lat],
    ) as number;
  }
  return Math.round(km * 1000) / 1000;
}

/** Observed span divided by expected span at the median interval, capped at 1. */
function completeness(t: ReconstructedTrack): number {
  if (t.fixes.length < 2 || t.medianIntervalSec <= 0) return 0;
  const spanSec = (Date.parse(t.fixes[t.fixes.length - 1]!.t) - Date.parse(t.fixes[0]!.t)) / 1000;
  const expected = spanSec / t.medianIntervalSec;
  return expected > 0 ? Math.min(1, Math.round((t.fixes.length / expected) * 1000) / 1000) : 0;
}

function mean(xs: number[]): number {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0;
}

export { reconstructTracks };
