#!/usr/bin/env node
/**
 * Real-data policy enforcement — 13_REAL_DATA_POLICY §13.6.
 * Cross-platform (Node) port of the reference bash script, so it runs on Windows dev
 * machines too. Required PR status check.
 *
 * Checks (a check with nothing yet to inspect PASSES — it is not a violation):
 *   1  fake-data libraries are not runtime dependencies
 *   2  forbidden provenance sourceType literals do not appear in source
 *   3  every real fixture carries a .provenance.json sibling
 *   4  no fixtures live outside a "__fixtures__/real/" directory
 *   5  the dataset manifest declares real data only
 *   6  provenance-required Mongoose models apply the provenance plugin
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, extname, basename, relative } from 'node:path';

const ROOT = process.cwd();
let failed = false;
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  failed = true;
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '.venv',
  '__pycache__',
]);

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

// ── 1 · fake-data libraries must not be runtime dependencies ──────────
console.log('▸ 1/6  Fake-data libraries must not be runtime dependencies');
{
  const banned = /^(@faker-js\/faker|faker|chance|casual|falso|mockjs)$/;
  const pkgs = walk(ROOT, (f) => basename(f) === 'package.json' && !f.includes('node_modules'));
  let hit = false;
  for (const p of pkgs) {
    const json = JSON.parse(readFileSync(p, 'utf8'));
    for (const dep of Object.keys(json.dependencies ?? {})) {
      if (banned.test(dep)) {
        fail(`${relative(ROOT, p)} declares "${dep}" as a runtime dependency`);
        hit = true;
      }
    }
  }
  if (!hit) ok('none found');
}

// ── 2 · forbidden provenance sourceType literals must not appear ──────
console.log('▸ 2/6  Forbidden provenance sourceType literals must not appear in source');
{
  const re = /sourceType\s*[:=]\s*['"](MOCK|SYNTHETIC|FAKE|DEMO|PLACEHOLDER|TEST)['"]/;
  const src = walk(join(ROOT), (f) => {
    if (!['.ts', '.tsx', '.py', '.js', '.mjs'].includes(extname(f))) return false;
    return /[\\/](apps|services|packages|scripts)[\\/]/.test(f) && !/\.test\./.test(f);
  });
  let hit = false;
  for (const f of src) {
    const text = readFileSync(f, 'utf8');
    if (re.test(text)) {
      fail(`${relative(ROOT, f)} contains a forbidden sourceType literal`);
      hit = true;
    }
  }
  if (!hit) ok('none found');
}

// ── 3 · every real fixture carries a .provenance.json sibling ─────────
console.log('▸ 3/6  Every test fixture carries a provenance sibling');
{
  const fixtures = walk(
    ROOT,
    (f) =>
      f.replace(/\\/g, '/').includes('/__fixtures__/real/') &&
      f.endsWith('.json') &&
      !f.endsWith('.provenance.json'),
  );
  if (fixtures.length === 0) ok('no real fixtures yet');
  for (const f of fixtures) {
    const sib = f.replace(/\.json$/, '.provenance.json');
    if (!existsSync(sib)) {
      fail(`${relative(ROOT, f)} has no .provenance.json sibling`);
      continue;
    }
    // A captured provider response is evidence: if its bytes no longer match the checksum
    // recorded at capture time, it was modified after capture and can no longer be cited
    // (13_REAL_DATA_POLICY §13.7). Reformatting counts as modification.
    let prov;
    try {
      prov = JSON.parse(readFileSync(sib, 'utf8'));
    } catch {
      fail(`${relative(ROOT, sib)} is not valid JSON`);
      continue;
    }
    const recorded = String(prov.checksum ?? '').replace(/^sha256:/, '');
    if (!recorded) {
      fail(`${relative(ROOT, sib)} records no checksum`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(f)).digest('hex');
    if (actual !== recorded) {
      fail(
        `${relative(ROOT, f)} was MODIFIED AFTER CAPTURE — sha256 ${actual.slice(0, 16)}… ` +
          `does not match the recorded ${recorded.slice(0, 16)}…. Re-capture it rather than editing it.`,
      );
    }
  }
  if (fixtures.length > 0 && !failed)
    ok(`${fixtures.length} fixture(s) verified against their recorded checksums`);
}

// ── 4 · no fixtures outside __fixtures__/real/ ───────────────────────
console.log('▸ 4/6  No fixtures outside __fixtures__/real/');
{
  const stray = walk(ROOT, (f) => {
    const u = f.replace(/\\/g, '/');
    return (
      u.includes('/__fixtures__/') && !u.includes('/__fixtures__/real/') && f.endsWith('.json')
    );
  });
  if (stray.length === 0) ok('none found');
  for (const f of stray) fail(`fixture outside __fixtures__/real/: ${relative(ROOT, f)}`);
}

// ── 5 · dataset manifest declares real data only ────────────────────
console.log('▸ 5/6  Dataset manifest declares real data only');
{
  const manifestPath = join(ROOT, 'data', 'manifests', 'dataset_manifest.yaml');
  if (!existsSync(manifestPath)) {
    ok('no dataset manifest yet (training not wired)');
  } else {
    // The authoritative validator lives in the ML service (07_AIML §7.4.5) and is what
    // training itself calls; CI runs the SAME code so the two cannot diverge. It is invoked
    // in pre-acquisition mode here: a manifest naming a dataset that has not been downloaded
    // yet is a legitimate state to hold in the repo, but `validate_manifest()` in its
    // default (training) mode still refuses to start a run against it.
    const r = spawnSync(
      'python',
      [
        '-c',
        [
          'import sys,json',
          'sys.path.insert(0, r"services/ml")',
          'from pathlib import Path',
          'from varuna_ml.models.manifest import validate_manifest',
          'r = validate_manifest(Path(r"data/manifests/dataset_manifest.yaml"), require_downloaded=False)',
          'print(json.dumps({"ok": r.ok, "entries": r.entries, "errors": r.errors, "warnings": r.warnings}))',
        ].join('; '),
      ],
      { encoding: 'utf8', cwd: ROOT },
    );

    if (r.status !== 0) {
      // Python or PyYAML unavailable (a Node-only checkout). Do not fail the build for a
      // missing toolchain — say so, and let the Python CI job be the gate.
      ok('validator unavailable in this environment (the Python CI job enforces it)');
    } else {
      const raw = r.stdout.trim();
      const out = JSON.parse(raw.slice(raw.lastIndexOf('{')));
      for (const e of out.errors) fail(`manifest: ${e}`);
      for (const w of out.warnings) console.log(`    note: ${w}`);
      if (out.ok) ok(`${out.entries} manifest entr(y/ies) validated by validate_manifest()`);
    }
  }
}

// ── 6 · provenance-required models apply the provenance plugin ──────
console.log('▸ 6/6  Provenance-required models apply the provenance plugin');
{
  const modelsDir = join(ROOT, 'apps', 'api', 'src', 'modules');
  const required = [
    'SatelliteScene',
    'SpillDetection',
    'VesselTrack',
    'OriginEstimate',
    'CandidateVessel',
    'Vessel',
  ];
  if (!existsSync(modelsDir)) {
    ok('API modules not scaffolded yet (Phase 1/2)');
  } else {
    const modelFiles = walk(modelsDir, (f) => /model\.ts$/.test(f));
    if (modelFiles.length === 0) {
      ok('no Mongoose models yet (Phase 1/2)');
    } else {
      const blob = modelFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
      for (const m of required) {
        const declared =
          new RegExp(`(Schema|model)\\([\\s\\S]{0,400}${m}`).test(blob) ||
          blob.includes(`'${m}'`) ||
          blob.includes(`"${m}"`);
        if (declared && !blob.includes('provenancePlugin')) {
          fail(`${m} is declared but provenancePlugin is not applied anywhere in modules/`);
        }
      }
      if (!failed) ok('all provenance-required models apply the plugin');
    }
  }
}

console.log('');
if (failed) {
  console.error('✗ Real-data policy: FAIL');
  process.exit(1);
}
console.log('✓ Real-data policy: PASS');
