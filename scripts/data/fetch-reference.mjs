#!/usr/bin/env node
/**
 * Fetch the small, KEYLESS, incident-independent reference datasets and write a
 * `.provenance.json` sidecar for each (13_REAL_DATA_POLICY §13.5). These are vendored —
 * downloaded once, committed, never fetched at runtime (11_API_KEYS B6–B8).
 *
 *   node scripts/data/fetch-reference.mjs [mid-table]
 *
 * GSHHG coastlines, SRTM/Copernicus DEM and GEBCO bathymetry are region-specific and are
 * clipped to the demo-incident AOI once it is locked — added here then (Phase 1/2).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'data', 'reference');
mkdirSync(OUT, { recursive: true });

const SOURCES = {
  'mid-table': {
    url: 'https://raw.githubusercontent.com/michaeljfazio/MIDs/master/mids.json',
    file: 'mid-table.json',
    provenance: (sha, url) => ({
      sourceType: 'VESSEL_REGISTRY',
      provider:
        'ITU Maritime Identification Digits (community machine-readable mirror: github.com/michaeljfazio/MIDs)',
      datasetId: 'ITU-MID-TABLE',
      externalId: 'michaeljfazio/MIDs@master mids.json',
      retrievedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      licence:
        'ITU MID assignments are public reference information. This JSON is a third-party mirror; its own licence is unconfirmed. RE-VERIFY against the authoritative ITU source before submission.',
      accessUrl: url,
      checksum: `sha256:${sha}`,
      derivedFrom: [],
      note:
        'Authoritative source: https://www.itu.int/en/ITU-R/terrestrial/fmd/Pages/mid.aspx (HTML). Used for MMSI country-prefix validation (01_PRD FR-4.3).',
      vendored: true,
      runtimeFetch: false,
    }),
  },
};

const which = process.argv[2] ?? 'mid-table';
const spec = SOURCES[which];
if (!spec) {
  console.error(`Unknown reference dataset "${which}". Known: ${Object.keys(SOURCES).join(', ')}`);
  process.exit(2);
}

const res = await fetch(spec.url);
if (!res.ok) {
  console.error(`fetch failed: HTTP ${res.status} for ${spec.url}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const sha = createHash('sha256').update(buf).digest('hex');

writeFileSync(join(OUT, spec.file), buf);
writeFileSync(
  join(OUT, `${spec.file.replace(/\.[^.]+$/, '')}.provenance.json`),
  JSON.stringify(spec.provenance(sha, spec.url), null, 2) + '\n',
);

console.log(`✓ ${spec.file}  ${buf.length} bytes  sha256:${sha}`);
console.log(`✓ ${spec.file.replace(/\.[^.]+$/, '')}.provenance.json written`);
