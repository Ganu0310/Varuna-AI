#!/usr/bin/env node
/**
 * OpenAPI drift gate — 06_BACKEND §6.11.
 *
 * The spec is generated from the route schemas, so it can never be *wrong*. What it can be is
 * changed without anyone noticing: a route renamed, a status code dropped, a required field
 * made optional. The spec is the contract the frontend and any evaluator's client read, and a
 * contract that changes silently is not a contract.
 *
 * So the generated document is committed as `doc/openapi.json` and this asserts the two still
 * agree. A deliberate API change is one line of `--write`; an accidental one fails the build
 * and shows exactly which operations moved.
 *
 * It also reports COVERAGE, because drift detection alone would happily hold a spec that
 * documents three endpoints steady forever. "We publish an OpenAPI spec" and "our OpenAPI spec
 * covers the API" are very different claims to make to an evaluator, and only one of them is
 * checkable. Coverage is printed, not enforced — the spec is filled in as phases land — but it
 * must not be invisible.
 *
 *   node scripts/check-openapi.mjs           # verify (CI)
 *   node scripts/check-openapi.mjs --write    # accept the current API as the new baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'doc/openapi.json');
const write = process.argv.includes('--write');

// The API's env schema requires real secrets. This script only reads route definitions, so
// give it placeholders rather than making a documentation check depend on a configured
// deployment — the alternative is a gate that only runs on a developer's machine.
process.env.NODE_ENV ??= 'test';
process.env.MONGODB_URI ??= 'mongodb://localhost:27017';
process.env.MONGODB_DB_NAME ??= 'VARUNA_SPEC';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_BUCKET ??= 'varuna';
process.env.S3_ACCESS_KEY_ID ??= 'spec-only';
process.env.S3_SECRET_ACCESS_KEY ??= 'spec-only';
process.env.JWT_ACCESS_SECRET ??= 'x'.repeat(48);
process.env.JWT_REFRESH_SECRET ??= 'y'.repeat(48);
process.env.ML_SERVICE_URL ??= 'http://localhost:8000';
process.env.ML_SERVICE_TOKEN ??= 'spec-only-token';
process.env.PUBLIC_APP_URL ??= 'http://localhost:5173';

const { openApiDocument } = await import('../apps/api/src/openapi.ts');
const current = JSON.stringify(openApiDocument(), null, 2) + '\n';

if (write) {
  writeFileSync(BASELINE, current);
  console.log('✓ openapi baseline written to doc/openapi.json');
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('✗ doc/openapi.json is missing. Run: node scripts/check-openapi.mjs --write');
  process.exit(1);
}

/** Every operation the spec describes, as `METHOD /path`. */
function specOperations(doc) {
  return Object.entries(doc.paths ?? {}).flatMap(([path, ops]) =>
    Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
  );
}

/**
 * Every operation actually mounted, asked of Express rather than inferred from the source.
 * Grepping for `router.get(` would count routes that are defined but never mounted, which is
 * exactly the sort of thing that makes a coverage number worse than none.
 */
async function mountedOperations() {
  const { ROUTE_MOUNTS } = await import('../apps/api/src/app.ts');
  const found = new Set();

  // Walk each router's own stack, where `layer.route.path` IS a string, and prefix it with the
  // mount path from the same table `createApp` mounts with — so this cannot disagree with what
  // is actually served.
  for (const [mount, router] of ROUTE_MOUNTS) {
    for (const layer of router.stack ?? []) {
      if (!layer.route) continue;
      const base = mount === '/' ? '' : mount;
      for (const m of Object.keys(layer.route.methods ?? {})) {
        if (m !== '_all') found.add(`${m.toUpperCase()} ${base}${layer.route.path}`);
      }
    }
  }

  // The two routes `createApp` declares inline rather than through a router.
  found.add('GET /api/v1');
  found.add('GET /api/v1/openapi.json');
  return found;
}

/** Express writes `:id`, the spec writes `{id}`. Compare them on the same footing. */
const normalise = (op) =>
  op
    .replace(/\{([^}]+)\}/g, ':$1')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');

const baseline = readFileSync(BASELINE, 'utf8');
const drifted = baseline !== current;

if (drifted) {
  const was = new Set(specOperations(JSON.parse(baseline)));
  const now = new Set(specOperations(JSON.parse(current)));
  const a = JSON.parse(baseline).paths ?? {};
  const b = JSON.parse(current).paths ?? {};

  const removed = [...was].filter((o) => !now.has(o)).sort();
  const added = [...now].filter((o) => !was.has(o)).sort();
  const changed = [...now]
    .filter((o) => was.has(o))
    .filter((o) => {
      const method = o.slice(0, o.indexOf(' ')).toLowerCase();
      const path = o.slice(o.indexOf(' ') + 1);
      return JSON.stringify(a[path]?.[method]) !== JSON.stringify(b[path]?.[method]);
    })
    .sort();

  console.error('✗ the API no longer matches doc/openapi.json\n');
  for (const [label, list] of [
    ['removed', removed],
    ['added', added],
    ['changed', changed],
  ]) {
    if (list.length) {
      console.error(`  ${list.length} ${label}:`);
      for (const o of list) console.error(`    ${o}`);
    }
  }
  if (!removed.length && !added.length && !changed.length) {
    console.error('  no operations differ — the change is in the components or metadata.');
  }
  console.error(
    '\n  If this change was intended:  node scripts/check-openapi.mjs --write\n' +
      '  and commit doc/openapi.json alongside the route change.',
  );
} else {
  console.log(
    `✓ openapi: ${specOperations(JSON.parse(current)).length} operations match the committed spec`,
  );
}

// Coverage is reported either way — a drifted spec is still worth knowing the size of.
try {
  const mounted = await mountedOperations();
  const documented = new Set(specOperations(JSON.parse(current)).map(normalise));
  const undocumented = [...mounted]
    .map(normalise)
    .filter((o) => !documented.has(o))
    .sort();
  const covered = mounted.size - undocumented.length;
  const pct = mounted.size ? Math.round((covered / mounted.size) * 100) : 0;

  console.log(`\n  spec coverage: ${covered}/${mounted.size} mounted operations (${pct}%)`);
  if (undocumented.length) {
    console.log(`  undocumented (not a failure — the spec is filled in as phases land):`);
    for (const o of undocumented.slice(0, 30)) console.log(`    ${o}`);
    if (undocumented.length > 30) console.log(`    …and ${undocumented.length - 30} more`);
  }
} catch (e) {
  // Coverage is a report, not the gate. If mounting the app fails here, say so and let the
  // drift result stand on its own rather than failing a documentation check for it.
  console.log(`\n  (coverage not measured: ${e instanceof Error ? e.message : e})`);
}

process.exit(drifted ? 1 : 0);
