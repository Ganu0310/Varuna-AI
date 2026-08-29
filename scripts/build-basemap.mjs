#!/usr/bin/env node
/**
 * Build the offline basemap from Natural Earth.
 *
 * The map had no land at all — AIS tracks floating on a flat colour with a graticule — while
 * the attribution already credited "Natural Earth (public domain)". We were citing a source
 * we did not ship. This produces it.
 *
 * Natural Earth is PUBLIC DOMAIN and vendored deliberately: 02_TRD TR-7 says the client holds
 * no provider credential, and a demo must not fail because a tile vendor is unreachable. A
 * token-gated basemap would break both.
 *
 * Two files, because one resolution cannot serve both jobs:
 *
 *  - `land-50m.json`  world coastlines for the globe and wide zoom. 0.35 MB gzipped.
 *  - `land-10m.json`  full-resolution coastlines clipped to the regions this deployment
 *                     actually works in. At AOI zoom the 50m outline is a crude blob beside
 *                     10 m SAR imagery, and a coastline that disagrees with the raster
 *                     underneath it is worse than no coastline. Clipping keeps it at ~0.02 MB
 *                     instead of the 10 MB the whole world would cost.
 *
 * Coordinates are rounded to 3 decimals (~110 m), finer than the 50m source resolves and far
 * finer than a pixel at any zoom where these are drawn.
 *
 *   node scripts/build-basemap.mjs
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'apps/web/public/basemap');
const SRC = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

/**
 * Where full-resolution coastline is worth its bytes: the staged demo, and the geographic
 * clusters of the confirmed-oil scenes in the evaluation dataset. Same list the AOI presets
 * are drawn from, with a few degrees of margin so panning does not run off the data.
 */
const REGIONS = [
  { id: 'marianas', bbox: [140, 5, 152, 25] },
  { id: 'gulf-of-mexico', bbox: [-95, 25, -85, 32] },
  { id: 'east-mediterranean', bbox: [31, 32, 39, 38] },
  { id: 'red-sea', bbox: [35, 15, 44, 25] },
  { id: 'persian-gulf', bbox: [50, 23, 58, 28] },
  { id: 'ligurian', bbox: [6, 41, 12, 45] },
  { id: 'makassar', bbox: [114, -7, 120, -1] },
];

const round = (o, nd) =>
  Array.isArray(o)
    ? typeof o[0] === 'number'
      ? o.map((v) => Number(v.toFixed(nd)))
      : o.map((x) => round(x, nd))
    : o;

const ringInBox = (ring, [w, s, e, n]) =>
  ring.some(([x, y]) => x >= w && x <= e && y >= s && y <= n);

/**
 * Sutherland–Hodgman clip of a ring against an axis-aligned box.
 *
 * Real clipping, not filtering. Keeping any polygon that merely TOUCHES a box pulls the whole
 * of Eurasia into the Red Sea region at 10 m resolution — the first version of this script
 * produced a 2.6 MB file that way. Clipping cuts the continent at the box edge instead.
 */
function clipRing(ring, [w, s, e, n]) {
  const edges = [
    { inside: ([x]) => x >= w, at: (a, b) => interp(a, b, (w - a[0]) / (b[0] - a[0])) },
    { inside: ([x]) => x <= e, at: (a, b) => interp(a, b, (e - a[0]) / (b[0] - a[0])) },
    { inside: ([, y]) => y >= s, at: (a, b) => interp(a, b, (s - a[1]) / (b[1] - a[1])) },
    { inside: ([, y]) => y <= n, at: (a, b) => interp(a, b, (n - a[1]) / (b[1] - a[1])) },
  ];

  let out = ring;
  for (const edge of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = edge.inside(cur);
      const prevIn = edge.inside(prev);
      if (curIn) {
        if (!prevIn) out.push(edge.at(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(edge.at(prev, cur));
      }
    }
    if (out.length === 0) return null;
  }

  // Close the ring; a clipped ring is still a polygon boundary.
  if (out.length < 4) return null;
  const [f] = out;
  const l = out[out.length - 1];
  if (f[0] !== l[0] || f[1] !== l[1]) out.push([f[0], f[1]]);
  return out;
}

function interp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

async function load(name) {
  const cached = resolve(OUT, `.cache-${name}.geojson`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  process.stdout.write(`  fetching ${name}…\n`);
  const res = await fetch(`${SRC}/${name}.geojson`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const text = await res.text();
  writeFileSync(cached, text);
  return JSON.parse(text);
}

function polygonsOf(geometry) {
  return geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
}

function build(fc, { clipTo = null, decimals = 3 } = {}) {
  const features = [];
  for (const f of fc.features) {
    const kept = [];
    for (const poly of polygonsOf(f.geometry)) {
      if (!clipTo) {
        kept.push(poly);
        continue;
      }
      for (const box of clipTo) {
        if (!poly.some((ring) => ringInBox(ring, box))) continue;
        // Only the OUTER ring is clipped. Holes that survive clipping would need re-pairing
        // to their parent, and at coastline scale a dropped inland lake is invisible where a
        // mismatched hole is a rendering artefact.
        const outer = clipRing(poly[0], box);
        if (outer) kept.push([outer]);
      }
    }
    if (kept.length === 0) continue;
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: round(kept, decimals) },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Centroid of the largest ring, which is good enough to hang a label on. */
function labelPoint(geometry) {
  let best = null;
  for (const poly of polygonsOf(geometry)) {
    const ring = poly[0];
    if (!ring || (best && ring.length <= best.length)) continue;
    best = ring;
  }
  if (!best) return null;
  const n = best.length;
  const [sx, sy] = best.reduce(([ax, ay], [x, y]) => [ax + x, ay + y], [0, 0]);
  return [Number((sx / n).toFixed(3)), Number((sy / n).toFixed(3))];
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const boxes = REGIONS.map((r) => r.bbox);
  const inRegion = (x, y) => boxes.some(([w, s, e, n]) => x >= w && x <= e && y >= s && y <= n);

  const world = build(await load('ne_50m_land'));
  writeFileSync(resolve(OUT, 'land-50m.json'), JSON.stringify(world));

  const detail = build(await load('ne_10m_land'), { clipTo: boxes });
  writeFileSync(resolve(OUT, 'land-10m.json'), JSON.stringify(detail));

  // Inland water, clipped like the land. Without it a large lake reads as sea, which on a
  // maritime map is exactly the wrong inference.
  const lakes = build(await load('ne_50m_lakes'), { clipTo: boxes });
  writeFileSync(resolve(OUT, 'lakes.json'), JSON.stringify(lakes));

  /**
   * Place and sea names, for orientation.
   *
   * Points and text only, no polygons — a label needs an anchor, not a shape. Restricted to
   * the working regions and to places of at least 50,000 people, because a coastline with
   * every hamlet on it is harder to read than one with none.
   *
   * These are rendered as HTML markers rather than a MapLibre `symbol` layer: symbols need a
   * glyph endpoint, and the only ones available are third-party, which the client is not
   * allowed to call (02_TRD TR-7).
   */
  const placesFc = await load('ne_10m_populated_places_simple');
  const places = placesFc.features
    .filter((f) => {
      const [x, y] = f.geometry.coordinates;
      if (!inRegion(x, y)) return false;
      // 5,000, not 50,000. The higher bar left Guam with a single label — island ports are
      // small, and it is the port that matters on a maritime map, not the metropolis. Clutter
      // is handled by the viewport cap rather than by the threshold.
      return (f.properties.pop_max ?? 0) >= 5_000 || f.properties.featurecla === 'Admin-0 capital';
    })
    .map((f) => ({
      name: f.properties.name,
      pop: f.properties.pop_max ?? 0,
      capital: f.properties.featurecla === 'Admin-0 capital',
      lon: Number(f.geometry.coordinates[0].toFixed(4)),
      lat: Number(f.geometry.coordinates[1].toFixed(4)),
    }))
    .sort((a, b) => b.pop - a.pop);

  const marineFc = await load('ne_50m_geography_marine_polys');
  const seas = marineFc.features
    .map((f) => {
      const at = labelPoint(f.geometry);
      return at ? { name: f.properties.name, lon: at[0], lat: at[1] } : null;
    })
    .filter((s) => s && s.name);

  writeFileSync(resolve(OUT, 'labels.json'), JSON.stringify({ places, seas }));

  // Provenance travels with the data, as it must for anything this project renders
  // (13_REAL_DATA_POLICY §13.2).
  writeFileSync(
    resolve(OUT, 'provenance.json'),
    JSON.stringify(
      {
        sourceType: 'REFERENCE_DATA',
        provider: 'Natural Earth',
        datasetId:
          'ne_50m_land, ne_10m_land, ne_50m_lakes, ne_10m_populated_places_simple, ne_50m_geography_marine_polys',
        externalId: 'naturalearthdata.com / nvkelso/natural-earth-vector',
        licence: 'Public domain (Natural Earth terms of use)',
        accessUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
        retrievedAt: new Date().toISOString(),
        note:
          'Vendored so the client needs no map-provider token and the map works offline. ' +
          '10 m coastline is clipped to the regions this deployment works in; the rest of ' +
          'the world is 50 m.',
        regions: REGIONS.map((r) => r.id),
      },
      null,
      2,
    ),
  );

  const kb = (p) => (readFileSync(resolve(OUT, p)).length / 1024).toFixed(0);
  console.log(`\n  land-50m.json  ${world.features.length} features  ${kb('land-50m.json')} kB`);
  console.log(`  land-10m.json  ${detail.features.length} features  ${kb('land-10m.json')} kB`);
  console.log(`  written to ${OUT}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
