/**
 * Vessel position at a moment in time — M9.
 *
 * AIS gives discrete observations, and the timeline asks "where was this vessel at 14:32:07",
 * which is almost never a moment anyone reported. So this interpolates — and marks every
 * result as either an OBSERVATION or an INTERPOLATION, because the difference is the whole
 * point (13_REAL_DATA_POLICY §13.3).
 *
 * Three rules that keep an animation from inventing evidence:
 *
 * 1. Never extrapolate. Before the first fix or after the last, the vessel is not drawn.
 *    Carrying it forward at its last heading would draw a vessel where nothing observed it,
 *    and it would look exactly like a real position.
 *
 * 2. Never interpolate across a long gap. A vessel dark for four hours could be anywhere;
 *    drawing a smooth line through that silence would erase the single most important
 *    signal in the data — an AIS dark period is itself evidence, and it is one of the twelve
 *    attribution features.
 *
 * 3. Report which one you got. `interpolated` travels with the position so the map can draw
 *    the two differently, rather than presenting a computed point as an observed one.
 */

/** Beyond this, a gap is treated as a dark period rather than something to draw across. */
export const MAX_INTERPOLATION_GAP_SEC = 15 * 60;

export interface TrackForAnimation {
  mmsi: number;
  line: { type: 'LineString'; coordinates: number[][] } | null;
  /** Observation time per vertex, same order and length as `line.coordinates`. */
  times?: string[];
}

export interface VesselAtTime {
  mmsi: number;
  lon: number;
  lat: number;
  cog: number | null;
  /** False only when the cursor lands exactly on a reported fix. */
  interpolated: boolean;
}

/** Index of the last fix at or before `t`, or -1. Binary search: this runs every frame. */
function lastIndexAtOrBefore(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      out = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return out;
}

/** Initial bearing in degrees, for orienting the marker. */
function bearing(from: number[], to: number[]): number {
  const [lon1, lat1] = [(from[0]! * Math.PI) / 180, (from[1]! * Math.PI) / 180];
  const [lon2, lat2] = [(to[0]! * Math.PI) / 180, (to[1]! * Math.PI) / 180];
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function vesselAt(track: TrackForAnimation, atMs: number): VesselAtTime | null {
  const coords = track.line?.coordinates;
  const times = track.times;
  if (!coords || !times || coords.length === 0 || times.length !== coords.length) return null;

  const ts = times.map((t) => Date.parse(t));

  // Rule 1: no extrapolation outside the observed window.
  if (atMs < ts[0]! || atMs > ts[ts.length - 1]!) return null;

  const i = lastIndexAtOrBefore(ts, atMs);
  if (i < 0) return null;

  const here = coords[i]!;

  // Exactly on a reported fix, or it is the final one.
  if (ts[i] === atMs || i === coords.length - 1) {
    const prev = i > 0 ? coords[i - 1]! : null;
    return {
      mmsi: track.mmsi,
      lon: here[0]!,
      lat: here[1]!,
      cog: prev ? bearing(prev, here) : null,
      interpolated: false,
    };
  }

  const next = coords[i + 1]!;
  const gapSec = (ts[i + 1]! - ts[i]!) / 1000;

  // Rule 2: a dark period is not something to draw a vessel across.
  if (gapSec > MAX_INTERPOLATION_GAP_SEC) return null;

  const frac = (atMs - ts[i]!) / (ts[i + 1]! - ts[i]!);
  return {
    mmsi: track.mmsi,
    // Linear in lon/lat. Over a sub-15-minute gap the great-circle difference is far below
    // one pixel at any zoom this map supports, so the extra machinery would buy nothing.
    lon: here[0]! + (next[0]! - here[0]!) * frac,
    lat: here[1]! + (next[1]! - here[1]!) * frac,
    cog: bearing(here, next),
    interpolated: true,
  };
}

/** Every vessel that can be honestly placed at `atMs`. Others are simply absent. */
export function vesselsAt(tracks: TrackForAnimation[], atMs: number): VesselAtTime[] {
  const out: VesselAtTime[] = [];
  for (const t of tracks) {
    const v = vesselAt(t, atMs);
    if (v) out.push(v);
  }
  return out;
}
