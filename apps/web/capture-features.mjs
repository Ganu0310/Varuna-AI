/**
 * Capture one screenshot per feature, from the running app, for the feature report.
 *
 * Real screens against the real stack — the same rule the rest of the project follows. A
 * mocked-up screenshot in a document describing a system that exists would be the exact
 * failure 13_REAL_DATA_POLICY is written to prevent.
 *
 *   node capture-features.mjs <outDir>
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:5173';
const OUT = process.argv[2] ?? './shots';
const INV = process.env.CAPTURE_INVESTIGATION_ID;
const EMAIL = process.env.CAPTURE_EMAIL;
const PASSWORD = process.env.CAPTURE_PASSWORD;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const shot = async (name, { full = false, wait = 1200 } = {}) => {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });
  console.log(`  ${name}`);
};

// ── unauthenticated ──────────────────────────────────────────────────────
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await shot('01-login');

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await shot('02-landing', { full: true });

// ── sign in ──────────────────────────────────────────────────────────────
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', EMAIL);
await page.fill('#password', PASSWORD);
await page.click('button[type=submit]');

// Wait for the app to ACTUALLY sign in, not merely for the network to settle. `networkidle`
// resolves before the SPA finishes its route change, so every later `goto` was hitting the
// auth gate and bouncing back to /login — producing a run of byte-identical screenshots of
// the login page, which is the sort of failure a report would carry silently.
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
await page.locator('.rail').waitFor({ state: 'visible', timeout: 20000 });
console.log(`  signed in -> ${new URL(page.url()).pathname}`);

await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await shot('03-dashboard', { full: true });

await page.goto(`${BASE}/system`, { waitUntil: 'networkidle' });
await shot('04-system-status', { full: true });

await page.goto(`${BASE}/investigations`, { waitUntil: 'networkidle' });
await shot('05-investigations');

await page.goto(`${BASE}/investigations/new`, { waitUntil: 'networkidle' });
await shot('06-new-investigation', { full: true });

await page.goto(`${BASE}/catalogue`, { waitUntil: 'networkidle' });
await shot('07-catalogue');

// ── the workspace, and the tabs that carry the chain ─────────────────────
if (INV) {
  await page.goto(`${BASE}/investigations/${INV}`, { waitUntil: 'networkidle' });
  await shot('08-workspace', { wait: 4000 });

  for (const [tab, name] of [
    ['Scenes & detections', '09-scenes-detections'],
    ['Origin', '10-origin'],
    ['AIS', '11-ais'],
    ['Candidates', '12-candidates'],
    ['Activity', '13-activity'],
    ['Team & trail', '14-team'],
  ]) {
    // The workspace tabs carry role="tab", not role="button".
    const btn = page.getByRole('tab', { name: new RegExp(tab, 'i') }).first();
    if (await btn.count()) {
      await btn.click().catch(() => {});
      await shot(name, { wait: 1800 });
    }
  }

  // The review dialog — the reason the modal work happened.
  await page
    .getByRole('tab', { name: /Scenes & detections/i })
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(1200);
  const review = page.getByRole('button', { name: /^Review$/i }).first();
  if (await review.count()) {
    await review.click().catch(() => {});
    await shot('15-detection-review', { wait: 1800 });
    await page.keyboard.press('Escape').catch(() => {});
  }
}

await page.goto(`${BASE}/globe`, { waitUntil: 'networkidle' });
await shot('16-globe', { wait: 3500 });

await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await shot('17-admin', { full: true });

await page.goto(`${BASE}/guide`, { waitUntil: 'networkidle' });
await shot('18-guide');

// Light theme, to show the palette actually works rather than asserting it.
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  try {
    localStorage.setItem('varuna.theme', 'light');
  } catch {
    /* storage blocked; the attribute above is what the screenshot needs */
  }
});
await shot('19-dashboard-light');

await browser.close();
console.log('done');
