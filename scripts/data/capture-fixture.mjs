#!/usr/bin/env node
/**
 * Capture a REAL provider response as a test fixture — 13_REAL_DATA_POLICY §13.7.
 *
 * "Deterministic API responses: captured real responses. A real search is executed once,
 * saved to __fixtures__/real/, and replayed. Provenance is the original request's."
 *
 * Every fixture gets a sibling `.provenance.json`; CI check 3 fails the build without one.
 * We simulate transport failure in tests — never the CONTENT of an observation.
 *
 *   node scripts/data/capture-fixture.mjs mpc-sentinel1-ennore
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'apps', 'api', 'src', '__fixtures__', 'real');

const CAPTURES = {
  'mpc-sentinel1-ennore': {
    file: 'mpc-sentinel1-ennore.json',
    url: 'https://planetarycomputer.microsoft.com/api/stac/v1/search',
    method: 'POST',
    body: {
      collections: ['sentinel-1-grd'],
      intersects: {
        type: 'Polygon',
        coordinates: [
          [
            [80.0, 13.0],
            [80.6, 13.0],
            [80.6, 13.4],
            [80.0, 13.4],
            [80.0, 13.0],
          ],
        ],
      },
      datetime: '2017-01-25T00:00:00Z/2017-02-08T00:00:00Z',
      limit: 20,
    },
    provenance: (sha) => ({
      sourceType: 'SATELLITE_SCENE',
      provider: 'Microsoft Planetary Computer',
      datasetId: 'sentinel-1-grd',
      externalId: 'STAC search: Ennore/Chennai AOI, 2017-01-25/2017-02-08',
      retrievedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      licence: 'Copernicus Sentinel Data — free, full and open',
      accessUrl: 'https://planetarycomputer.microsoft.com/api/stac/v1/search',
      checksum: `sha256:${sha}`,
      derivedFrom: [],
      note:
        'Captured real STAC response, replayed in tests for determinism ' +
        '(13_REAL_DATA_POLICY §13.7). Not hand-authored; not modified after capture.',
    }),
  },
};

const which = process.argv[2] ?? 'mpc-sentinel1-ennore';
const spec = CAPTURES[which];
if (!spec) {
  console.error(`Unknown capture "${which}". Known: ${Object.keys(CAPTURES).join(', ')}`);
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const res = await fetch(spec.url, {
  method: spec.method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(spec.body),
});
if (!res.ok) {
  console.error(`capture failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}

const json = await res.json();
const text = `${JSON.stringify(json, null, 2)}\n`;
const sha = createHash('sha256').update(text).digest('hex');

writeFileSync(join(OUT, spec.file), text);
writeFileSync(
  join(OUT, `${spec.file.replace(/\.json$/, '')}.provenance.json`),
  `${JSON.stringify(spec.provenance(sha), null, 2)}\n`,
);

console.log(`✓ ${spec.file} — ${json.features?.length ?? 0} features, sha256:${sha.slice(0, 16)}…`);
console.log(`✓ ${spec.file.replace(/\.json$/, '')}.provenance.json written`);
