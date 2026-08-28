#!/usr/bin/env node
/**
 * Anonymous Sentinel-1 / Sentinel-2 catalogue search against the Microsoft Planetary
 * Computer STAC API. NO CREDENTIALS REQUIRED — this is for verifying that satellite
 * coverage exists for a candidate demo incident (CONTEXT.md §15.6, blocker B-004) BEFORE
 * committing to it. It does not download anything.
 *
 * Usage:
 *   node scripts/data/search-scenes.mjs --bbox <w,s,e,n> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--collection sentinel-1-grd]
 *   node scripts/data/search-scenes.mjs --aoi path/to/aoi.geojson --from ... --to ...
 *
 * Example (Ennore / Chennai, Jan 2017 — 10_DATASETS §10.6.2):
 *   node scripts/data/search-scenes.mjs --bbox 80.0,13.0,80.6,13.4 --from 2017-01-25 --to 2017-02-05
 *
 * Exit code 0 if >=1 scene found, 1 if none (so it can gate a shell check).
 */
import { readFileSync } from 'node:fs';

const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const collection = arg('collection', 'sentinel-1-grd');
const from = arg('from');
const to = arg('to');
const bboxArg = arg('bbox');
const aoiPath = arg('aoi');

if (!from || !to || (!bboxArg && !aoiPath)) {
  console.error('Missing required args. See the header of this file for usage.');
  process.exit(2);
}

let intersects;
let aoiBbox;
if (aoiPath) {
  const gj = JSON.parse(readFileSync(aoiPath, 'utf8'));
  intersects = gj.type === 'FeatureCollection' ? gj.features[0].geometry : gj.geometry ?? gj;
  aoiBbox = bboxOf(intersects);
} else {
  const [w, s, e, n] = bboxArg.split(',').map(Number);
  aoiBbox = [w, s, e, n];
  intersects = {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

function bboxOf(geom) {
  let minX = 180,
    minY = 90,
    maxX = -180,
    maxY = -90;
  const visit = (c) => {
    if (typeof c[0] === 'number') {
      minX = Math.min(minX, c[0]);
      maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]);
      maxY = Math.max(maxY, c[1]);
    } else c.forEach(visit);
  };
  visit(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

function overlapPct(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const aoiArea = (a[2] - a[0]) * (a[3] - a[1]);
  return aoiArea > 0 ? (100 * inter) / aoiArea : 0;
}

const body = {
  collections: [collection],
  intersects,
  datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
  limit: 100,
};

console.log(`▸ ${collection}  ${from} → ${to}  bbox ${aoiBbox.join(',')}\n`);

const res = await fetch(STAC, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error(`STAC search failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(3);
}
const fc = await res.json();
const feats = fc.features ?? [];

if (feats.length === 0) {
  console.log('  ✗ 0 scenes — this incident/window has no coverage in this collection.');
  console.log('    Try: widen the window, a different collection, CDSE, or ASF.');
  process.exit(1);
}

feats.sort((f1, f2) => (f1.properties.datetime < f2.properties.datetime ? -1 : 1));
for (const f of feats) {
  const p = f.properties;
  const ov = f.bbox ? overlapPct(aoiBbox, f.bbox).toFixed(0) : '??';
  const pol = (p['sar:polarizations'] ?? p['s2:product_type'] ?? []).toString();
  const orbit = p['sat:orbit_state'] ?? '';
  const mode = p['sar:instrument_mode'] ?? '';
  console.log(
    `  ${p.datetime}  overlap≈${ov.padStart(3)}%  ${mode.padEnd(3)} ${orbit.padEnd(10)} [${pol}]  ${f.id}`,
  );
}
console.log(`\n  ✓ ${feats.length} scene(s). Product IDs above are verifiable in any Sentinel-1 catalogue.`);
