#!/usr/bin/env node
/**
 * Cold-start gate — 14 §14.6 Phase 13, 01_PRD §12.7, 03_ARCHITECTURE §3.9.
 *
 * "Fresh clone + `.env` from `.env.example` + `docker compose up` reaches a working system
 * using only documented variables."
 *
 * The expensive half of that claim (containers actually booting) is verified by running it.
 * The half that silently rots is the CONTRACT between `.env.example`, the Zod schema, the
 * Pydantic settings and `docker-compose.yml` — a key renamed in one place and not the others
 * breaks a cold start weeks later, on someone else's machine, usually during a demo.
 *
 * So this validates `.env.example` against the REAL exported schema rather than a duplicated
 * list, which would drift from it and let the gate pass while the system failed to boot.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const quoted = (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"));
    out[m[1]] = quoted ? v.slice(1, -1) : v;
  }
  return out;
}

function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = resolve(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const apiEnvPath = resolve(ROOT, 'apps/api/src/env.ts');
const example = parseDotenv(readFileSync(resolve(ROOT, '.env.example'), 'utf8'));

// ── 1. Booting the API against `.env.example` must not exit ────────────────
// `env.ts` validates `process.env` at import time and calls `process.exit(1)` when it is
// short a required key. That is precisely the behaviour under test — but running it in THIS
// process would kill the checker mid-way and report one problem instead of all of them, with
// a message that never mentions cold starts. So the boot happens in a child, with only the
// documented values in its environment, which also means CI needs no `.env` of its own.
//
// Only the OS variables node itself needs are carried over — PATH and friends, never an
// application key. If `process.env` were spread in, a variable set on the developer's machine
// would satisfy a requirement `.env.example` forgot to document, and the gate would pass
// here and fail on the clean machine it exists to protect.
//
// Known limitation, and the reason the per-key checks below are NOT redundant with this one:
// `env.ts` also reads the git-ignored repo-root `.env`, which this child cannot be steered
// away from. On a developer machine that file silently supplies any key `.env.example` omits
// (dotenv runs with `override: false`, so the example still wins where both define a key).
// So the boot probe reliably catches an INVALID documented value, and the pure parse below
// catches a MISSING one. Neither check alone covers both.
const OS_PASSTHROUGH = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
];
const childEnv = { ...example };
for (const k of OS_PASSTHROUGH) if (process.env[k]) childEnv[k] = process.env[k];

const boot = spawnSync(
  process.execPath,
  ['--import', 'tsx', '-e', 'await import(process.argv[1])', pathToFileURL(apiEnvPath).href],
  { env: childEnv, encoding: 'utf8' },
);
if (boot.status === 0) {
  notes.push('apps/api boots against .env.example alone (child process, exit 0)');
} else {
  const detail = `${boot.stderr ?? ''}${boot.stdout ?? ''}`
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('    at '))
    .slice(0, 6)
    .join('; ');
  problems.push(`apps/api exits ${boot.status} when booted from .env.example — ${detail}`);
}

// ── 2/3. `.env.example` must satisfy the real API schema, key by key ───────
// The schema is imported from the API rather than restated here, so the gate cannot drift
// from what the service actually boots with.
//
// Guarded on the boot probe: importing `env.ts` in THIS process runs the same
// `process.exit(1)`, so when the boot has already failed we skip these two checks rather
// than die holding an unprinted report. The later checks need no schema and still run.
if (boot.status === 0) {
  for (const [k, v] of Object.entries(example)) process.env[k] = v;
  const { EnvSchema } = await import(pathToFileURL(apiEnvPath).href);

  const parsed = EnvSchema.safeParse(example);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(
        `.env.example fails the API schema — ${issue.path.join('.')}: ${issue.message}`,
      );
    }
  } else {
    notes.push(`.env.example satisfies the API env schema (${Object.keys(example).length} keys)`);
  }

  // A required key that is only *documented* — commented out, or left blank — fails a cold
  // start even though the file mentions it. Reported in the language of the fix.
  for (const [key, def] of Object.entries(EnvSchema.shape)) {
    if (def.safeParse(undefined).success) continue; // optional or defaulted
    if (!(key in example)) {
      problems.push(`${key} is REQUIRED by the API schema but absent from .env.example`);
    } else if (example[key] === '') {
      problems.push(`${key} is REQUIRED but blank in .env.example — boot would exit non-zero`);
    }
  }
} else {
  notes.push('per-key schema checks skipped: fix the boot failure above first');
}

// ── 4. Required values must point at the compose topology ──────────────────
const compose = readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf8');
const composeServices = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
for (const [key, service] of Object.entries({
  MONGODB_URI: 'mongo',
  REDIS_URL: 'redis',
  S3_ENDPOINT: 'minio',
  ML_SERVICE_URL: 'ml',
  TITILER_URL: 'titiler',
})) {
  if (!composeServices.includes(service)) {
    problems.push(`${key} needs a "${service}" service that docker-compose.yml does not define`);
  }
}
notes.push(`docker-compose.yml defines ${composeServices.length} services`);

// ── 5. Compose must not smuggle in undocumented variables ──────────────────
// Anything compose reads as ${VAR} has to be documented, or a cold start substitutes an
// empty string where a credential belongs and fails somewhere far from the cause.
const composeVars = new Set(
  [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::?-[^}]*)?\}/g)].map((m) => m[1]),
);
for (const v of composeVars) {
  if (!(v in example)) {
    problems.push(`docker-compose.yml interpolates \${${v}}, undocumented in .env.example`);
  }
}
notes.push(`compose interpolates ${composeVars.size} variables, all documented`);

// ── 6. The Python service's required settings must be documented too ───────
// Pydantic defaults mean the ML service boots regardless; the risk is that it boots pointing
// at the wrong bucket. A setting WITHOUT a default is genuinely required.
const pyConfig = readFileSync(resolve(ROOT, 'services/ml/varuna_ml/config.py'), 'utf8');
const pySettings = [
  ...pyConfig.matchAll(/^ {4}([a-z][a-z0-9_]*)\s*:\s*([^=\n]+?)(?:\s*=\s*(.+))?$/gm),
].filter(([, name]) => name !== 'model_config');
for (const [, name, , dflt] of pySettings) {
  const upper = name.toUpperCase();
  if (dflt === undefined && !(upper in example)) {
    problems.push(`ML settings require ${upper} (no default), undocumented in .env.example`);
  }
}
notes.push(`ML service exposes ${pySettings.length} settings, all defaulted or documented`);

// ── 7. Front-end build-time variables ──────────────────────────────────────
// Vite inlines these at BUILD time. A missing one does not fail the build — it compiles
// `undefined` into the bundle and the app calls `undefined/api/v1/...` at runtime.
const viteVars = new Set();
for (const f of sourceFiles(resolve(ROOT, 'apps/web/src'))) {
  for (const m of readFileSync(f, 'utf8').matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) {
    viteVars.add(m[1]);
  }
}
for (const v of viteVars) {
  if (!(v in example)) {
    problems.push(`apps/web reads import.meta.env.${v}, undocumented — Vite inlines "undefined"`);
  }
}
notes.push(`web reads ${viteVars.size} VITE_* variables, all documented`);

// ── report ─────────────────────────────────────────────────────────────────
console.log('\ncold-start contract\n');
for (const n of notes) console.log(`  ok   ${n}`);
for (const p of problems) console.log(`  FAIL ${p}`);
console.log('');

if (problems.length) {
  console.error(
    `${problems.length} problem(s). A fresh clone would NOT reach a working system from ` +
      '.env.example alone.\n',
  );
  process.exit(1);
}
console.log('A fresh clone can reach a working system from .env.example alone.\n');
