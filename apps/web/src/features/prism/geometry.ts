/**
 * Space-time geometry for the prism — 04_UIUX §4.6.3.
 *
 * The prism plots vessel tracks with TIME as the vertical axis, so a track becomes a helix
 * through a volume and the origin estimate becomes a slab occupying the release window. Where
 * a helix passes through that slab, the vessel was in the plausible release area during the
 * plausible release period — which is the space-time coincidence the whole attribution rests
 * on, and the one thing a flat map cannot show. On a 2D map two vessels crossing the same
 * water twelve hours apart draw the same picture.
 *
 * Coordinates are projected to LOCAL METRES about the AOI centre, because deck.gl's OrbitView
 * is Cartesian and mixing degrees with a time axis would make the vertical scale meaningless.
 * Over an AOI capped at 50,000 km² the equirectangular error is far below the width of a
 * rendered track.
 */

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Projector {
  /** Longitude/latitude to metres east/north of the AOI centre. */
  toLocal: (lon: number, lat: number) => [number, number];
  /** Epoch ms to metres on the vertical axis. */
  toZ: (t: number) => number;
  centre: [number, number];
  windowStart: number;
  windowEnd: number;
  /** Metres of Z per hour — the vertical scale, which must be stated wherever it is drawn. */
  metresPerHour: number;
}

const R = 6_378_137;

export function makeProjector(
  bounds: Bounds,
  windowStart: number,
  windowEnd: number,
  /** Height of the whole prism in metres. Chosen so the volume reads at a sensible pitch. */
  prismHeightM = 30_000,
): Projector {
  const lon0 = (bounds.west + bounds.east) / 2;
  const lat0 = (bounds.south + bounds.north) / 2;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const spanMs = Math.max(1, windowEnd - windowStart);

  return {
    centre: [lon0, lat0],
    windowStart,
    windowEnd,
    metresPerHour: (prismHeightM / spanMs) * 3_600_000,
    toLocal: (lon, lat) => [
      ((lon - lon0) * Math.PI * R * cosLat) / 180,
      ((lat - lat0) * Math.PI * R) / 180,
    ],
    toZ: (t) => ((t - windowStart) / spanMs) * prismHeightM,
  };
}

/** Ray-casting point-in-polygon on an outer ring in lon/lat. */
export function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = [ring[i]![0]!, ring[i]![1]!];
    const [xj, yj] = [ring[j]![0]!, ring[j]![1]!];
    const straddles = yi > lat !== yj > lat;
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface TrackInput {
  mmsi: number;
  line: { type: 'LineString'; coordinates: number[][] } | null;
  times?: number[];
}

export interface Intersection {
  mmsi: number;
  lon: number;
  lat: number;
  t: number;
  /** Where in the release window this fell, 0 at the earliest and 1 at the latest. */
  windowFraction: number;
}

/**
 * Fixes that fall inside the origin support AND inside the release window.
 *
 * BOTH conditions, always. A vessel inside the release area at the wrong time is ordinary
 * traffic, and a vessel at the right time somewhere else is irrelevant — reporting either as
 * an intersection would manufacture a coincidence out of half a match.
 *
 * Only REPORTED fixes are tested, never interpolated ones. An intersection is a claim that a
 * vessel was somewhere, and interpolation is a computation about where it probably was; a
 * computed point is not grounds for asserting presence.
 */
export function findIntersections(
  tracks: TrackInput[],
  supportRing: number[][] | null,
  releaseEarliest: number,
  releaseLatest: number,
): Intersection[] {
  if (!supportRing || supportRing.length < 4) return [];
  const span = Math.max(1, releaseLatest - releaseEarliest);

  const out: Intersection[] = [];
  for (const track of tracks) {
    const coords = track.line?.coordinates;
    const times = track.times;
    if (!coords || !times || times.length !== coords.length) continue;

    for (let i = 0; i < coords.length; i++) {
      const t = times[i]!;
      if (t < releaseEarliest || t > releaseLatest) continue;
      const [lon, lat] = [coords[i]![0]!, coords[i]![1]!];
      if (!pointInRing(lon, lat, supportRing)) continue;
      out.push({ mmsi: track.mmsi, lon, lat, t, windowFraction: (t - releaseEarliest) / span });
    }
  }
  return out;
}

/** One entry per vessel, so a stationary vessel does not dominate the count. */
export function intersectionsByVessel(list: Intersection[]): Map<number, Intersection[]> {
  const m = new Map<number, Intersection[]>();
  for (const x of list) {
    const arr = m.get(x.mmsi);
    if (arr) arr.push(x);
    else m.set(x.mmsi, [x]);
  }
  return m;
}
