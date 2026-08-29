import { test, expect, type Page } from '@playwright/test';

/**
 * Journey 1 — the demo path, M1–M10 (08_APP_FLOW §8.2).
 *
 * Login → open the real Guam incident → detections → origin → AIS → candidates → dossier.
 *
 * This drives the REAL stack. The scene is a real Sentinel-1 RTC product, the AIS is the real
 * Marine Cadastre archive, and the scores come from the real attribution model. Nothing here
 * is stubbed, so a pass means the pipeline genuinely produced these artefacts.
 *
 * The assertions are mostly about HONESTY rather than presence: that a degraded origin says
 * so, that scores are labelled uncalibrated, that unmeasured evidence is shown rather than
 * hidden. A UI that displays a ranked list is easy; one that refuses to overstate it is the
 * product.
 */

const EMAIL = process.env.E2E_EMAIL ?? '';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const INVESTIGATION_ID = process.env.E2E_INVESTIGATION_ID ?? '';

test.beforeAll(() => {
  if (!EMAIL || !PASSWORD || !INVESTIGATION_ID) {
    throw new Error(
      'Set E2E_EMAIL, E2E_PASSWORD and E2E_INVESTIGATION_ID to a real account and a real ' +
        'investigation. These tests deliberately have no fixture fallback: a suite that ' +
        'passes against invented data would certify the one behaviour the product forbids.',
    );
  }
});

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/investigations/, { timeout: 30_000 });
}

test.describe('Journey 1 — attribution on the real Guam incident', () => {
  test('an analyst reaches a ranked, caveated candidate list and a complete dossier', async ({
    page,
  }) => {
    await login(page);

    // ── M1: the investigation exists and is listed ──────────────────────────
    await expect(page.getByRole('heading', { name: 'Investigations' })).toBeVisible();

    await page.goto(`/investigations/${INVESTIGATION_ID}`);
    await expect(page.getByRole('tablist')).toBeVisible({ timeout: 60_000 });

    // ── M4/M5: detections from the real scene ───────────────────────────────
    await page.getByRole('tab', { name: /Scenes & detections/ }).click();
    const detectionPanel = page.getByRole('tabpanel');
    await expect(detectionPanel).toBeVisible();

    // Every rendered detection must carry provenance. The API strips unsourced objects and
    // the UI paints a loud panel in their place, so the absence of that panel is the
    // assertion that matters.
    await expect(page.getByTestId('provenance-missing')).toHaveCount(0);

    // ── M8: AIS coverage is stated honestly, not implied ────────────────────
    await page.getByRole('tab', { name: /^AIS/ }).click();
    await expect(page.getByRole('heading', { name: 'AIS coverage' })).toBeVisible();
    // Coverage must name what it could NOT see. A count alone would let sparse coverage read
    // as thorough coverage.
    await expect(page.getByRole('tabpanel')).toContainText(/vessel|transmit|coverage|interval/i);

    // ── M9/M10: candidates, ranked and caveated ─────────────────────────────
    await page.getByRole('tab', { name: /Candidates/ }).click();
    const candidates = page.getByRole('tabpanel');
    await expect(candidates).toBeVisible();

    // The origin estimate for this incident is DEGRADED (HYCOM has no coverage for
    // 2025-09-21), which caps every candidate at MODERATE. If a STRONG tier ever appears
    // here without the forcing gap being closed, the cap has regressed — and that is the
    // single most consequential silent failure this system can have.
    await expect(candidates).not.toContainText('STRONG');

    // Scores must be labelled as uncalibrated evidence, never as probabilities.
    await expect(candidates).toContainText(/uncalibrated/i);

    // ── The dossier ─────────────────────────────────────────────────────────
    await page.goto(`/investigations/${INVESTIGATION_ID}/report`);
    await expect(page.getByRole('heading', { name: 'Uncertainty & Limitations' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('heading', { name: 'Data Provenance' })).toBeVisible();

    // The two mandatory sections must have CONTENT, not just headings. An empty
    // "Uncertainty" heading satisfies a structural check while telling the reader nothing.
    const uncertainty = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Uncertainty & Limitations' }) });
    await expect(uncertainty).toContainText(/DEGRADED|proximity|uncalibrated/i);

    await expect(page.getByTestId('provenance-missing')).toHaveCount(0);
  });

  test('the dossier states it is not a determination of responsibility', async ({ page }) => {
    // This sentence is the difference between an investigative lead and an accusation. It is
    // asserted separately so that removing it fails a test whose name says exactly what was
    // lost.
    await login(page);
    await page.goto(`/investigations/${INVESTIGATION_ID}/report`);

    // Asserted on the containing element, not with `getByText`. The disclaimer emphasises the
    // word "not" in its own <strong>, which splits the sentence across text nodes — a regex
    // over a single node never matches it. The first version of this test failed for exactly
    // that reason while the dossier was word-for-word correct.
    const disclaimer = page.locator('.rp-disclaimer');
    await expect(disclaimer).toBeVisible({ timeout: 60_000 });
    await expect(disclaimer).toContainText(/not\s+a determination of responsibility/i);
  });
});
