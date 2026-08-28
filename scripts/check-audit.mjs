#!/usr/bin/env node
/**
 * Dependency audit gate — 14 §14.6 Phase 13.
 *
 * "gitleaks + `npm audit` + `pip-audit` blocking on high severity."
 *
 * `pnpm check:audit`
 *
 * Two ecosystems, one exit code. The Python half is the part worth explaining: running
 * `pip-audit` bare audits the whole interpreter, which on a developer machine means auditing
 * every unrelated package they have ever installed. That produces a wall of findings VARUNA
 * cannot act on, and a gate nobody can keep green is a gate that gets skipped. So the Python
 * side resolves the dependency closure declared in `pyproject.toml` and audits only that.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKING = new Set(['high', 'critical']);
const problems = [];
const notes = [];

// ── JavaScript ─────────────────────────────────────────────────────────────
const npm = spawnSync('pnpm', ['audit', '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

let jsAdvisories = [];
try {
  const parsed = JSON.parse(npm.stdout);
  jsAdvisories = Object.values(parsed.advisories ?? {});
} catch {
  problems.push('could not parse `pnpm audit --json` output');
}

const jsBlocking = jsAdvisories.filter((a) => BLOCKING.has(a.severity));
for (const a of jsBlocking) {
  problems.push(
    `[js/${a.severity}] ${a.module_name} ${a.vulnerable_versions} — ${a.title} ` +
      `(fixed in ${a.patched_versions})`,
  );
}
const jsLower = jsAdvisories.length - jsBlocking.length;
notes.push(
  `pnpm audit: ${jsBlocking.length} high/critical, ${jsLower} moderate or below ` +
    '(moderate does not block)',
);

// ── Python ─────────────────────────────────────────────────────────────────
// Resolve the closure of what `pyproject.toml` actually declares, then audit that list.
const RESOLVE_CLOSURE = `
import tomllib, pathlib, importlib.metadata as md, re, sys
data = tomllib.loads(pathlib.Path('pyproject.toml').read_text(encoding='utf-8'))
names = set()
def add(spec):
    n = re.split(r'[<>=!\\[; ]', spec.strip())[0]
    if n: names.add(n.lower())
for s in data['project']['dependencies']: add(s)
for grp in data['project'].get('optional-dependencies', {}).values():
    for s in grp: add(s)
seen, out = set(), []
def walk(n):
    n = n.lower()
    if n in seen: return
    seen.add(n)
    try: dist = md.distribution(n)
    except Exception: return
    out.append(f"{dist.metadata['Name']}=={dist.version}")
    for r in (dist.requires or []):
        if '; extra' in r: continue
        walk(re.split(r'[<>=!\\[; ]', r.strip())[0])
for n in sorted(names): walk(n)
sys.stdout.write("\\n".join(sorted(set(out))))
`;

const ML = resolve(ROOT, 'services/ml');
const closure = spawnSync('python', ['-c', RESOLVE_CLOSURE], { cwd: ML, encoding: 'utf8' });

if (closure.status !== 0 || !closure.stdout.trim()) {
  problems.push(
    'could not resolve the Python dependency closure — is the ML service environment ' +
      `installed? (${(closure.stderr || '').split('\n')[0]})`,
  );
} else {
  const reqFile = join(tmpdir(), 'varuna-audit-requirements.txt');
  writeFileSync(reqFile, closure.stdout, 'utf8');
  const packages = closure.stdout.trim().split('\n').length;

  const pip = spawnSync(
    'python',
    ['-m', 'pip_audit', '-r', reqFile, '--progress-spinner', 'off', '--format', 'json'],
    { cwd: ML, encoding: 'utf8' },
  );

  if (/No module named/.test(pip.stderr ?? '')) {
    problems.push('pip-audit is not installed — run `python -m pip install pip-audit`');
  } else {
    try {
      const parsed = JSON.parse(pip.stdout);
      const vulnerable = (parsed.dependencies ?? []).filter((d) => (d.vulns ?? []).length > 0);
      for (const d of vulnerable) {
        for (const v of d.vulns) {
          // pip-audit reports no severity, so every finding in OUR closure blocks. The
          // closure is small and directly ours; there is no noise to filter out.
          problems.push(
            `[py] ${d.name} ${d.version} — ${v.id} (fixed in ${(v.fix_versions ?? []).join(', ') || 'no fix yet'})`,
          );
        }
      }
      notes.push(`pip-audit: ${packages} packages in VARUNA's declared closure`);
    } catch {
      problems.push('could not parse pip-audit JSON output');
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────
console.log('\ndependency audit\n');
for (const n of notes) console.log(`  ok   ${n}`);
for (const p of problems) console.log(`  FAIL ${p}`);
console.log('');

if (problems.length) {
  console.error(`${problems.length} blocking finding(s).\n`);
  process.exit(1);
}
console.log('No high or critical advisories in either ecosystem.\n');
