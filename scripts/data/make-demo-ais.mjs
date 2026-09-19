#!/usr/bin/env node
/**
 * Generate a DETERMINISTIC SYNTHETIC AIS slice for the Guam / Apra Harbour demo.
 *
 * ⚠ THIS IS NOT REAL AIS DATA. It exists so the ingestion → correlation → candidate-ranking
 * pipeline can be exercised end-to-end on a machine with no Marine Cadastre bulk download
 * and no live-AIS credential. The correlation and ranking still run LIVE against this input;
 * nothing about the result is pre-computed. The import records its provenance as
 * "VARUNA synthetic demo AIS", never as NOAA (see apps/api/src/modules/ais/import-cli.ts --demo).
 *
 * Output columns match the NOAA Marine Cadastre "AccessAIS" CSV-with-geometry export that
 * apps/api/src/modules/ais/import.ts parses:
 *   mmsi, base_date_time, geometry (WKT POINT lon lat), sog, cog, heading, status, draft,
 *   vessel_name, vessel_type
 *
 * Scene acquisition (the observed_at the back-track runs from): 2025-09-21T20:07:48Z
 * Largest slick centroid (known-answer reference only): 13.448941 N, 144.669277 E
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../data/demo/ais/guam-2025-09-21.demo.csv');

/** linear interpolate a leg and emit a fix every `stepMin` minutes, skipping any gap window */
function leg({ mmsi, name, type, status, draft, from, to, a, b, sogKn, stepMin, gap }) {
  const t0 = Date.parse(from);
  const t1 = Date.parse(to);
  const rows = [];
  const bearing = Math.atan2(b[0] - a[0], b[1] - a[1]) * (180 / Math.PI);
  const cog = ((bearing % 360) + 360) % 360;
  for (let t = t0; t <= t1; t += stepMin * 60_000) {
    if (gap && t >= Date.parse(gap[0]) && t <= Date.parse(gap[1])) continue;
    const f = (t - t0) / (t1 - t0 || 1);
    const lon = a[0] + (b[0] - a[0]) * f;
    const lat = a[1] + (b[1] - a[1]) * f;
    const dt = new Date(t).toISOString().replace('T', ' ').replace('.000Z', '');
    rows.push(
      [
        mmsi,
        dt,
        `POINT (${lon.toFixed(6)} ${lat.toFixed(6)})`,
        sogKn.toFixed(1),
        cog.toFixed(1),
        Math.round(cog),
        status,
        draft.toFixed(1),
        name,
        type,
      ].join(','),
    );
  }
  return rows;
}

const header =
  'mmsi,base_date_time,geometry,sog,cog,heading,status,draft,vessel_name,vessel_type';

const rows = [
  // A — "DEMO SUSPECT VESSEL A": slow SW→NE transit straight through the largest slick,
  //     with a 45-minute AIS silence while over it (a dark period the pipeline should flag).
  ...leg({
    mmsi: 538005123, name: 'DEMO SUSPECT VESSEL A', type: 70, status: 0, draft: 11.2,
    from: '2025-09-21T18:20:00Z', to: '2025-09-21T20:55:00Z',
    a: [144.5900, 13.3850], b: [144.7250, 13.5050], sogKn: 8.6, stepMin: 5,
    gap: ['2025-09-21T19:30:00Z', '2025-09-21T20:15:00Z'],
  }),
  // B — steady E→W transit ~10 km south of the slicks, lit the whole time.
  ...leg({
    mmsi: 431500456, name: 'DEMO TRANSIT VESSEL B', type: 80, status: 0, draft: 7.4,
    from: '2025-09-21T17:00:00Z', to: '2025-09-21T21:30:00Z',
    a: [144.9200, 13.3550], b: [144.5200, 13.3650], sogKn: 12.4, stepMin: 5,
  }),
  // C — near-stationary at the harbour approach, far enough from the slick centroids.
  ...leg({
    mmsi: 563112789, name: 'DEMO ANCHORED VESSEL C', type: 89, status: 1, draft: 9.1,
    from: '2025-09-21T16:00:00Z', to: '2025-09-21T22:00:00Z',
    a: [144.6360, 13.4360], b: [144.6375, 13.4348], sogKn: 0.1, stepMin: 10,
  }),
  // D — fast NW→SE transit across the north edge of the AOI.
  ...leg({
    mmsi: 477998001, name: 'DEMO TRANSIT VESSEL D', type: 71, status: 0, draft: 6.0,
    from: '2025-09-21T18:45:00Z', to: '2025-09-21T20:40:00Z',
    a: [144.5600, 13.5800], b: [144.8600, 13.4500], sogKn: 15.8, stepMin: 5,
  }),
];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, header + '\n' + rows.join('\n') + '\n', 'utf8');
console.log(`wrote ${rows.length} synthetic AIS rows -> ${OUT}`);
