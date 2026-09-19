#!/usr/bin/env node
/**
 * `pnpm demo` — drive the full VARUNA pipeline against the verified real Sentinel-1C RTC
 * scene over Apra Harbour, Guam (2025-09-21T20:07:48Z), end to end:
 *
 *   register → investigation → ingest (real MPC RTC → COG → MinIO) → detect →
 *   back-track origin (DEGRADED / FOOTPRINT_PROXIMITY without ocean forcing) →
 *   import the SYNTHETIC demo AIS slice → correlate → rank candidates → build the dossier
 *
 * Nothing is pre-computed: every stage runs live. The satellite data is REAL; the AIS slice
 * is deterministic SYNTHETIC data, imported with `--demo` so its provenance never claims a
 * real source (see data/demo/ais/README.md).
 *
 * Requires the stack to be up (`docker compose up -d`). Talks to the API on
 * http://localhost:4000 and runs the AIS import CLI inside the `api` container.
 */
import { execFileSync } from 'node:child_process';

const API = process.env.VARUNA_API_URL ?? 'http://localhost:4000';
const SCENE = 'S1C_IW_GRDH_1SDV_20250921T200737_20250921T200800_004227_008638_rtc';
const AOI = [144.55, 13.3, 144.95, 13.6];

const log = (m) => console.log(`  ${m}`);
const step = (m) => console.log(`\n▸ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const h = await (await fetch(`${API}/health`)).json();
      if (h.status === 'ok') return;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  throw new Error(`API never became healthy at ${API}. Is the stack up? (docker compose up -d)`);
}

async function waitForWorker(pattern, label, timeoutMs = 240_000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    await sleep(4000);
    let out = '';
    try {
      out = execFileSync('docker', ['compose', 'logs', '--since', '10m', 'worker'], {
        encoding: 'utf8',
      });
    } catch {
      /* ignore transient docker errors */
    }
    if (new RegExp(pattern).test(out)) {
      log(`${label}: done`);
      return;
    }
    const now = out.split('\n').filter(Boolean).slice(-1)[0] ?? '';
    if (now !== last) last = now;
  }
  throw new Error(`Timed out waiting for worker: ${label}`);
}

async function main() {
  step(`Checking the API at ${API}`);
  await waitForHealth();
  log('API healthy');

  step('Registering a demo analyst');
  const email = `demo+${Date.now()}@varuna.local`;
  await api('/api/v1/auth/register', {
    method: 'POST',
    body: { email, password: 'demo-password-123', name: 'Demo Analyst' },
  });
  log(email);

  step('Creating the investigation (Apra Harbour, Guam)');
  const inv = await api('/api/v1/investigations', {
    method: 'POST',
    body: {
      name: 'Guam — Apra Harbour 2025-09-21',
      incidentReference: 'VARUNA-DEMO-01',
      aoi: {
        type: 'Polygon',
        coordinates: [
          [
            [AOI[0], AOI[1]],
            [AOI[2], AOI[1]],
            [AOI[2], AOI[3]],
            [AOI[0], AOI[3]],
            [AOI[0], AOI[1]],
          ],
        ],
      },
      windowStart: '2025-09-20T00:00:00Z',
      windowEnd: '2025-09-23T00:00:00Z',
      reportedIncidentAt: '2025-09-21T20:07:48Z',
    },
  });
  const id = inv._id ?? inv.id;
  log(`investigation ${id}`);

  step('Ingesting the real Sentinel-1C RTC scene (MPC → COG → MinIO) and detecting');
  await api(`/api/v1/investigations/${id}/scenes/ingest`, {
    method: 'POST',
    body: { productId: SCENE, collection: 'sentinel-1-rtc' },
  });
  await waitForWorker(
    `"queue":"ingest"[^\\n]*${id}[^\\n]*"job (completed|failed)"`,
    'ingest + detect',
  );
  const dets = await api(`/api/v1/investigations/${id}/detections`);
  const top = dets.items?.[0];
  if (!top) throw new Error('no detections were produced');
  log(
    `${dets.items.length} detections · top ${top.areaKm2?.toFixed?.(4)} km² · confidence ${(
      top.confidence?.overall ?? 0
    ).toFixed(2)}`,
  );

  step('Back-tracking the origin');
  await api(`/api/v1/investigations/${id}/origin/run`, {
    method: 'POST',
    body: { detectionId: top._id, horizonHours: 24, particleCount: 4000 },
  });
  await waitForWorker(
    `"queue":"drift"[^\\n]*${id}[^\\n]*"job (completed|failed)"`,
    'origin back-track',
  );
  const origin = await api(`/api/v1/investigations/${id}/origin`);
  log(`origin: ${origin.origin?.method ?? origin.reason} / ${origin.origin?.status ?? '—'}`);

  step('Importing the SYNTHETIC demo AIS slice (--demo)');
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'api',
      'node',
      'apps/api/dist/modules/ais/import-cli.js',
      '--file',
      'data/demo/ais/guam-2025-09-21.demo.csv',
      '--from',
      '2025-09-21T00:00:00Z',
      '--to',
      '2025-09-22T12:00:00Z',
      '--bbox',
      '144.40,13.20,145.10,13.80',
      '--demo',
    ],
    { stdio: 'inherit' },
  );

  step('Correlating AIS and ranking candidate vessels');
  await api(`/api/v1/investigations/${id}/candidates/correlate`, {
    method: 'POST',
    body: { detectionId: top._id },
  });
  await waitForWorker(
    `"queue":"scoring"[^\\n]*${id}[^\\n]*"job (completed|failed)"`,
    'correlate + rank',
  );
  const cands = await api(`/api/v1/investigations/${id}/candidates`);
  for (const c of cands.items ?? []) {
    log(`#${c.rank}  MMSI ${c.mmsi}  score ${c.score}  ${c.tier}`);
  }

  step('Building the dossier');
  const report = await api(`/api/v1/investigations/${id}/report/data`);
  log(`dossier sections: ${Object.keys(report).length} · generated ${report.generatedAt ?? 'now'}`);

  console.log(`\n✓ Demo complete.\n`);
  console.log(`  Workspace : http://localhost:5173/investigations/${id}`);
  console.log(`  Dossier   : http://localhost:5173/investigations/${id}/report`);
  console.log(`  Login     : ${email}  /  demo-password-123\n`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
