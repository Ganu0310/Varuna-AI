#!/usr/bin/env node
/**
 * Asserts apps/web/src/design/tokens.css and tokens.ts stay in sync so the DOM, deck.gl and
 * Three.js can never drift apart in colour (04_UIUX §4.13).
 *
 * Every hex colour named in tokens.ts must be defined (as a CSS custom property value) in
 * tokens.css. Structural check only — extend as the token set grows.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'apps', 'web', 'src', 'design');
const cssPath = join(dir, 'tokens.css');
const tsPath = join(dir, 'tokens.ts');

if (!existsSync(cssPath) || !existsSync(tsPath)) {
  console.log('✓ tokens sync: nothing to check yet');
  process.exit(0);
}

const css = readFileSync(cssPath, 'utf8').toLowerCase();
const ts = readFileSync(tsPath, 'utf8').toLowerCase();

const hexes = [...ts.matchAll(/#[0-9a-f]{6}/g)].map((m) => m[0]);
const missing = [...new Set(hexes)].filter((h) => !css.includes(h));

if (missing.length) {
  console.error('✗ tokens sync: colours in tokens.ts not present in tokens.css:');
  for (const h of missing) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`✓ tokens sync: ${new Set(hexes).size} colours consistent`);
