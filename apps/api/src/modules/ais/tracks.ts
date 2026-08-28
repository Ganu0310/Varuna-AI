import mongoose from 'mongoose';
import type { LineString } from 'geojson';
import { TRACK_RECONSTRUCTION } from '@varuna/shared';
import { geodesicDistanceKm } from '../../geo/geodesy.js';
import type { AisFix, TrackGap } from '../attribution/features.js';

/**
 * Track reconstruction from raw AIS fixes — 06_BACKEND §6.6.3.
 *
 * Two things here are load-bearing for attribution honesty:
 *
 *  • GAPS ARE EVIDENCE, not noise. A vessel that stops transmitting over the origin zone is
 *    the classic deliberate-discharge signature, so gaps are detected, measured and kept —
 *    they feed feature F5 rather than being smoothed away.
 *  • OUTLIERS ARE COUNTED, NEVER SILENTLY DROPPED. A fix implying an impossible speed is
 *    excluded from the geometry but recorded in `removedOutlierCount`, so an analyst can
 *    see that the track was edited and by how much.
 */

export interface ReconstructedTrack {
  mmsi: number;
  fixes: AisFix[];
  gaps: TrackGap[];
  line: LineString | null;
  shipType: number | null;
  removedOutlierCount: number;
  medianIntervalSec: number;
}

interface RawFix {
  t: Date;
  meta: { mmsi: number };
  position: { coordinates: [number, number] };
  sog: number | null;
  cog: number | null;
  heading: number | null;
  navStatus: number | null;
  draught: number | null;
}

/** Load every AIS position in the window/box and group into per-vessel tracks. */
export async function reconstructTracks(
  from: string,
  to: string,
  bbox: [number, number, number, number],
): Promise<ReconstructedTrack[]> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('reconstructTracks requires a mongo connection');

  const [west, south, east, north] = bbox;
  const rows = (await db
    .collection('ais_positions')
    .find({
      t: { $gte: new Date(from), $lte: new Date(to) },
      position: {
        $geoWithin: {
          $geometry: {
            type: 'Polygon',
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
    })
    .sort({ 'meta.mmsi': 1, t: 1 })
    .toArray()) as unknown as RawFix[];

  const byMmsi = new Map<number, RawFix[]>();
  for (const r of rows) {
    const list = byMmsi.get(r.meta.mmsi) ?? [];
    list.push(r);
    byMmsi.set(r.meta.mmsi, list);
  }

  const tracks: ReconstructedTrack[] = [];

  for (const [mmsi, raw] of byMmsi) {
    if (raw.length < TRACK_RECONSTRUCTION.minPoints) continue;

    const kept: RawFix[] = [];
    let removed = 0;

    for (const fix of raw) {
      const prev = kept[kept.length - 1];
      if (prev) {
        const dtHours = (fix.t.getTime() - prev.t.getTime()) / 3_600_000;
        if (dtHours > 0) {
          const km = geodesicDistanceKm(
            prev.position.coordinates,
            fix.position.coordinates,
          ) as number;
          const impliedKn = km / 1.852 / dtHours;
          // A fix implying an impossible speed is a bad position report, not a fast ship.
          if (impliedKn > TRACK_RECONSTRUCTION.maxImpliedSpeedKn) {
            removed += 1;
            continue;
          }
        }
      }
      kept.push(fix);
    }

    if (kept.length < TRACK_RECONSTRUCTION.minPoints) continue;

    const gaps: TrackGap[] = [];
    const intervals: number[] = [];
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i - 1]!;
      const b = kept[i]!;
      const minutes = (b.t.getTime() - a.t.getTime()) / 60_000;
      intervals.push(minutes * 60);
      if (minutes > TRACK_RECONSTRUCTION.maxGapMinutes) {
        gaps.push({
          startAt: a.t.toISOString(),
          endAt: b.t.toISOString(),
          durationMin: Math.round(minutes),
          fromLonLat: a.position.coordinates,
          toLonLat: b.position.coordinates,
        });
      }
    }
    intervals.sort((x, y) => x - y);

    const fixes: AisFix[] = kept.map((r) => ({
      t: r.t.toISOString(),
      lon: r.position.coordinates[0],
      lat: r.position.coordinates[1],
      sog: r.sog,
      cog: r.cog,
      heading: r.heading,
      navStatus: r.navStatus,
      draught: r.draught,
    }));

    tracks.push({
      mmsi,
      fixes,
      gaps,
      line:
        fixes.length >= 2
          ? { type: 'LineString', coordinates: fixes.map((f) => [f.lon, f.lat]) }
          : null,
      shipType: null, // static AIS messages are not in this export; F7 reports MISSING
      removedOutlierCount: removed,
      medianIntervalSec: intervals.length ? intervals[Math.floor(intervals.length / 2)]! : 0,
    });
  }

  return tracks.sort((a, b) => b.fixes.length - a.fixes.length);
}
