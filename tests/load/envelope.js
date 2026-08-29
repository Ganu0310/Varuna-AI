import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

/**
 * Load profile — 14 §14.6 Phase 13, 01_PRD NFR-6 / NFR-7.
 *
 * Thresholds, from the PRD:
 *   - envelope (AIS spatio-temporal) query p95 < 400 ms against a real archive
 *   - non-job API p95 < 250 ms
 *   - 50 concurrent investigations without degradation
 *
 * `k6 run tests/load/envelope.js` (set BASE_URL, EMAIL, PASSWORD, INVESTIGATION_ID).
 *
 * Every request below hits the real API against the imported Marine Cadastre archive. There
 * is no synthetic fixture and no stubbed datastore: a load number measured against anything
 * other than the real index and the real document sizes is not a measurement of this system.
 *
 * Companion: `scripts/bench-envelope.ts` measures the SAME query at the datastore, across
 * randomised windows spanning the whole archive. That distinction matters — this file drives
 * one investigation's fixed AOI repeatedly, so it reports latency with a warm WiredTiger
 * cache, which is the demo-day condition but flatters a cold one. Quote both numbers.
 */

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const EMAIL = __ENV.EMAIL || '';
const PASSWORD = __ENV.PASSWORD || '';
const INVESTIGATION_ID = __ENV.INVESTIGATION_ID || '';

const envelopeLatency = new Trend('envelope_query_ms', true);
const readLatency = new Trend('non_job_read_ms', true);
const provenanceComplete = new Rate('responses_carrying_provenance');

// The archive backing these runs is the real Marine Cadastre Guam/Marianas extent
// (lon 141–150, lat 10.75–23.85), 2023–2025. `scripts/bench-envelope.ts` measures the raw
// query across randomised windows inside that extent; this file measures it through the API.

export const options = {
  scenarios: {
    // NFR-6: query latency under a steady analyst-like read load.
    envelope_queries: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      exec: 'envelopeQuery',
      tags: { nfr: 'NFR-6' },
    },
    // NFR-7: 50 concurrent investigations without degradation. Ramped rather than a step,
    // so a failure shows the load level it began at instead of only that it failed.
    concurrent_investigations: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 25 },
        { duration: '30s', target: 50 },
        { duration: '1m', target: 50 },
        { duration: '15s', target: 0 },
      ],
      exec: 'investigationRead',
      startTime: '2m',
      tags: { nfr: 'NFR-7' },
    },
  },
  thresholds: {
    'envelope_query_ms{nfr:NFR-6}': ['p(95)<400'],
    'non_job_read_ms{nfr:NFR-7}': ['p(95)<250'],
    http_req_failed: ['rate<0.01'],
    // A fast response that dropped its provenance is a failure, not a pass. The API strips
    // unsourced objects rather than erroring, so latency alone would look healthy while the
    // payload had been gutted.
    responses_carrying_provenance: ['rate>0.99'],
  },
};

export function setup() {
  if (!EMAIL || !PASSWORD || !INVESTIGATION_ID) {
    throw new Error(
      'Set EMAIL, PASSWORD and INVESTIGATION_ID. This suite runs against the real API with a ' +
        'real session over a real investigation; there is no anonymous or synthetic read path ' +
        'to load-test instead.',
    );
  }
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'login succeeded': (r) => r.status === 200 });
  if (res.status !== 200) {
    throw new Error(`login failed with ${res.status}: ${String(res.body).slice(0, 200)}`);
  }

  // Returned as a raw Cookie header rather than as a jar.
  //
  // `setup()` runs in its own context with its own cookie jar, and VUs do not inherit it —
  // the first version of this file returned `res.cookies` and every VU then ran
  // unauthenticated, producing 99.99% failures and a flattering 2.76ms p95 that was
  // measuring the cost of being rejected. Latency figures from an unauthenticated run are
  // worse than no figures, because they look like success.
  const header = Object.entries(res.cookies)
    .map(([name, vals]) => `${name}=${vals[0].value}`)
    .join('; ');
  if (!header) throw new Error('login returned no cookies — cannot authenticate the VUs');
  return { cookieHeader: header };
}

function authed(data) {
  return { headers: { 'Content-Type': 'application/json', Cookie: data.cookieHeader } };
}

export function envelopeQuery(data) {
  const params = authed(data);
  group('AIS envelope', () => {
    // The envelope query is reached through track reconstruction: the endpoint takes the
    // investigation's AOI and window and runs the `$geoWithin` + time-range scan over
    // `ais_positions`. There is deliberately no endpoint that accepts an arbitrary bbox —
    // AIS reads are scoped to an investigation the caller has access to (06 §6.4.7) — so the
    // load profile varies `limit` rather than geography.
    const limit = 50 + Math.floor(Math.random() * 450);
    const url = `${BASE}/api/v1/investigations/${INVESTIGATION_ID}/ais/tracks?limit=${limit}&persist=false`;

    const res = http.get(url, { ...params, tags: { nfr: 'NFR-6' } });

    // Only successful responses contribute to the latency metric. Timing failures and
    // reporting the result as p95 is how an unauthenticated run reads as a fast one.
    if (res.status === 200) envelopeLatency.add(res.timings.duration, { nfr: 'NFR-6' });

    check(res, {
      'envelope 200': (r) => r.status === 200,
      // An empty result is legitimate — much of this box is open ocean — but a MALFORMED
      // one is not, and the two are easy to confuse at load.
      'envelope well-formed': (r) => {
        try {
          const b = r.json();
          return b !== null && (Array.isArray(b) || typeof b === 'object');
        } catch {
          return false;
        }
      },
    });

    let ok = true;
    try {
      const body = res.json();
      const items = Array.isArray(body) ? body : (body && (body.items || body.tracks)) || [];
      ok = items.every((i) => i.provenance || i.provenanceId || i.__provenanceMissing !== true);
    } catch {
      ok = false;
    }
    provenanceComplete.add(ok);
  });

  // Think time. Without it a VU loops as fast as the network allows and 10 VUs generate
  // ~3,500 req/s, which is not "10 analysts" — it is a flood, and it measures the rate
  // limiter rather than the query. NFR-7 is about 50 concurrent INVESTIGATIONS, and an
  // analyst reading a result issues a request every few seconds.
  sleep(1 + Math.random());
}

export function investigationRead(data) {
  const params = authed(data);
  group('investigation reads', () => {
    for (const path of [
      '/api/v1/investigations',
      INVESTIGATION_ID ? `/api/v1/investigations/${INVESTIGATION_ID}` : null,
      INVESTIGATION_ID ? `/api/v1/investigations/${INVESTIGATION_ID}/detections` : null,
      INVESTIGATION_ID ? `/api/v1/investigations/${INVESTIGATION_ID}/candidates` : null,
    ]) {
      if (!path) continue;
      const res = http.get(`${BASE}${path}`, { ...params, tags: { nfr: 'NFR-7' } });
      if (res.status === 200) readLatency.add(res.timings.duration, { nfr: 'NFR-7' });
      check(res, { [`${path} ok`]: (r) => r.status === 200 });
    }
  });
  sleep(2 + Math.random() * 2);
}
