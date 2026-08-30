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
 * It also gates COVERAGE, because drift detection alone would happily hold a spec that
 * documents three endpoints steady forever. "We publish an OpenAPI spec" and "our OpenAPI spec
 * covers the API" are very different claims to make to an evaluator, and only one of them is
 * checkable.
 *
 * Coverage is a RATCHET, not a threshold: `doc/openapi-coverage.json` records how many mounted
 * operations are currently undocumented, and the build fails if that number GOES UP. A
 * percentage target would have to be argued about and would fail the build for work nobody
 * had started; a ratchet only ever fails the person who added the undocumented route, while
 * they still have it in their head. Documenting anything lowers the floor, and the lower
 * number is committed — so the gate tightens on its own and never loosens by accident.
 *
 *   node scripts/check-openapi.mjs           # verify (CI)
 *   node scripts/check-openapi.mjs --write    # accept the current API + coverage as baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'doc/openapi.json');
const COVERAGE = resolve(ROOT, 'doc/openapi-coverage.json');
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
// TITILER_URL is required with no default, and env.ts reports a bad configuration by
// calling process.exit(1) rather than throwing -- which no try/catch here can intercept.
// Omitting it killed the script the moment it imported the app to enumerate routes, so
// coverage was never actually measured anywhere without a .env file, CI included.
process.env.TITILER_URL ??= 'http://localhost:8080';

const { openApiDocument } = await import('../apps/api/src/openapi.ts');
const current = JSON.stringify(openApiDocument(), null, 2) + '\n';

if (!write && !existsSync(BASELINE)) {
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

/**
 * Measure coverage, or return null if the app cannot be mounted.
 *
 * Null is a distinct answer from zero and is treated as one: a coverage number that could
 * not be taken must never read as "nothing is documented", and must never fail the build
 * on its own.
 */
async function measureCoverage() {
  try {
    const mounted = await mountedOperations();
    const documented = new Set(specOperations(JSON.parse(current)).map(normalise));
    const undocumented = [...mounted]
      .map(normalise)
      .filter((o) => !documented.has(o))
      .sort();
    return { mounted: mounted.size, undocumented };
  } catch (e) {
    console.log(`\n  (coverage not measured: ${e instanceof Error ? e.message : e})`);
    return null;
  }
}

if (write) {
  writeFileSync(BASELINE, current);
  console.log('✓ openapi baseline written to doc/openapi.json');

  const cov = await measureCoverage();
  if (cov) {
    writeFileSync(
      COVERAGE,
      JSON.stringify(
        {
          note:
            'A ratchet, not a target. `undocumented` may go DOWN freely; the build fails ' +
            'when it goes up. Lower it by documenting a route in apps/api/src/openapi.ts, ' +
            'then re-run with --write and commit this file.',
          mounted: cov.mounted,
          undocumented: cov.undocumented.length,
          operations: cov.undocumented,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `✓ coverage floor written: ${cov.mounted - cov.undocumented.length}/${cov.mounted} ` +
        `documented, ${cov.undocumented.length} undocumented`,
    );
  }
  process.exit(0);
}

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

// Coverage is measured either way — a drifted spec is still worth knowing the size of.
let coverageRegressed = false;
const cov = await measureCoverage();

if (cov) {
  const covered = cov.mounted - cov.undocumented.length;
  const pct = cov.mounted ? Math.round((covered / cov.mounted) * 100) : 0;
  console.log(`\n  spec coverage: ${covered}/${cov.mounted} mounted operations (${pct}%)`);

  if (!existsSync(COVERAGE)) {
    console.log('  no coverage floor recorded yet — run with --write to set one and commit it.');
  } else {
    const floor = JSON.parse(readFileSync(COVERAGE, 'utf8'));
    const previouslyUndocumented = new Set(floor.operations ?? []);
    const newlyUndocumented = cov.undocumented.filter((o) => !previouslyUndocumented.has(o));

    if (cov.undocumented.length > floor.undocumented) {
      coverageRegressed = true;
      console.error(
        `\n✗ spec coverage went backwards: ${cov.undocumented.length} operations are ` +
          `undocumented, against a floor of ${floor.undocumented}.`,
      );
      // Name the specific routes, not only the count. The count says a rule was broken; the
      // list says which line to go and fix.
      if (newlyUndocumented.length) {
        console.error('\n  mounted, and described nowhere in the spec:');
        for (const o of newlyUndocumented) console.error(`    ${o}`);
      }
      console.error(
        '\n  Document these in apps/api/src/openapi.ts — a route an evaluator cannot find ' +
          'in the spec is a route they cannot call.\n' +
          '  If a route is genuinely not part of the public contract, run ' +
          'node scripts/check-openapi.mjs --write and say so in the commit.',
      );
    } else if (cov.undocumented.length < floor.undocumented) {
      console.log(
        `  ✓ coverage improved: ${floor.undocumented - cov.undocumented.length} fewer ` +
          'undocumented operation(s) than the floor. Run --write to ratchet it down and ' +
          'commit doc/openapi-coverage.json.',
      );
    } else {
      console.log(`  ✓ coverage holding at the floor (${floor.undocumented} undocumented)`);
    }
  }

  if (cov.undocumented.length && !coverageRegressed) {
    console.log('  undocumented:');
    for (const o of cov.undocumented.slice(0, 30)) console.log(`    ${o}`);
    if (cov.undocumented.length > 30) {
      console.log(`    …and ${cov.undocumented.length - 30} more`);
    }
  }
}

process.exit(drifted || coverageRegressed ? 1 : 0);
