import { reconstructTracks } from './tracks.js';

/**
 * A short-lived cache for reconstructed tracks on the READ path.
 *
 * Measured with k6: the envelope endpoint's p95 was 427 ms against a 400 ms budget, and
 * `reconstructTracks` accounted for 290–420 ms of it — the per-fix geodesic outlier gate over
 * 8,074 fixes. The MongoDB query itself is 84 ms and the payload ~8 ms; neither was the cost.
 * With this cache the p95 is 29 ms.
 *
 * The result is a pure function of (window, bbox) over an append-only collection, and an
 * analyst scrubbing a timeline re-requests exactly the same one repeatedly.
 *
 * ONLY the read path uses it. `correlate` calls `reconstructTracks` directly and is
 * deliberately left uncached: attribution must run against the data as it is now, and saving
 * 300 ms on an analysis that takes minutes is a poor trade for any chance of scoring a vessel
 * against a stale track.
 *
 * This lives in its own module rather than in the router because the AIS importer has to
 * invalidate it, and the importer runs in the WORKER — importing the router there would drag
 * Express and its middleware into a process that has no HTTP surface at all.
 */

const TTL_MS = 60_000;
const MAX_ENTRIES = 32;

type Tracks = Awaited<ReturnType<typeof reconstructTracks>>;

const cache = new Map<string, { at: number; value: Tracks }>();

export async function cachedTracks(
  from: string,
  to: string,
  bbox: [number, number, number, number],
): Promise<Tracks> {
  const key = `${from}|${to}|${bbox.join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const value = await reconstructTracks(from, to, bbox);
  cache.set(key, { at: Date.now(), value });

  // Bounded: one entry per distinct window+box, which a long-lived process would otherwise
  // accumulate indefinitely.
  if (cache.size > MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return value;
}

/**
 * Dropped when new AIS lands.
 *
 * Without this an import would be invisible for up to a minute, and the coverage figures the
 * report derives from these tracks would describe the archive as it was before it.
 */
export function clearTrackCache(): void {
  cache.clear();
}
