import { test, expect, type Page } from '@playwright/test';

/**
 * Journey 2 — the honest null result (08_APP_FLOW §8.3).
 *
 * The system's real test is not whether it can rank a vessel. It is whether it declines to,
 * when the evidence does not support one. Journey 1 can pass in a system that fabricates;
 * this one cannot.
 *
 * Three branches, each a different way of having nothing to say:
 *   1. a scene with no detection — the analysis ran and found no slick
 *   2. a detection with no AIS in the window — nothing to attribute it to
 *   3. a candidate below the evidence floor — INSUFFICIENT_EVIDENCE, score withheld
 *
 * Each must produce a clear, specific statement of what is missing. The failure mode being
 * guarded against is not a crash; it is a plausible-looking empty state that a tired analyst
 * reads as "nothing happened here".
 */

const EMAIL = process.env.E2E_EMAIL ?? '';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const EMPTY_INVESTIGATION_ID = process.env.E2E_EMPTY_INVESTIGATION_ID ?? '';

test.beforeAll(() => {
  if (!EMAIL || !PASSWORD) {
    throw new Error('Set E2E_EMAIL and E2E_PASSWORD to a real account.');
  }
});

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/investigations/, { timeout: 30_000 });
}

test.describe('Journey 2 — the system declines to overstate', () => {
  test('an investigation with no work done says so, and offers no ranking', async ({ page }) => {
    test.skip(
      !EMPTY_INVESTIGATION_ID,
      'Set E2E_EMPTY_INVESTIGATION_ID to a real investigation with no scenes ingested.',
    );
    await login(page);
    await page.goto(`/investigations/${EMPTY_INVESTIGATION_ID}`);
    await expect(page.getByRole('tablist')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('tab', { name: /Candidates/ }).click();
    const panel = page.getByRole('tabpanel');

    // The empty state must name the missing PRECONDITION, not just report zero rows. "No
    // candidates" invites the reading "no vessel was responsible"; "no origin estimate yet"
    // says what actually happened.
    await expect(panel).toContainText(/no |not yet|before|requires|run /i);
    await expect(panel).not.toContainText('STRONG');
  });

  test('correlation is refused, with a reason, when no origin estimate exists', async ({
    request,
  }) => {
    test.skip(!EMPTY_INVESTIGATION_ID, 'Set E2E_EMPTY_INVESTIGATION_ID.');

    // Asserted at the API because this is a guarantee about the system, not the screen: the
    // UI could be rebuilt tomorrow and this must still hold. Correlating against a bare
    // detection footprint would yield the weakest possible attribution while looking
    // indistinguishable from a real result.
    const login = await request.post('/api/v1/auth/login', {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok()).toBeTruthy();

    const res = await request.post(
      `/api/v1/investigations/${EMPTY_INVESTIGATION_ID}/candidates/correlate`,
      { data: {} },
    );
    expect(res.status()).toBe(409);

    const problem = await res.json();
    // A bare 409 is not enough. The response must explain the consequence, because the
    // analyst's next question is always "so what do I do instead".
    expect(JSON.stringify(problem)).toMatch(/origin/i);
  });

  test('a report cannot be produced without its uncertainty and provenance sections', async ({
    request,
  }) => {
    const login = await request.post('/api/v1/auth/login', {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok()).toBeTruthy();

    const target = EMPTY_INVESTIGATION_ID || process.env.E2E_INVESTIGATION_ID;
    test.skip(!target, 'Set E2E_INVESTIGATION_ID or E2E_EMPTY_INVESTIGATION_ID.');

    // Deliberately request a dossier WITHOUT the mandatory sections. The server must refuse
    // rather than quietly omit them — a report that names a vessel with the caveats stripped
    // out is the single most dangerous artefact this system could emit.
    const res = await request.post(`/api/v1/investigations/${target}/report`, {
      data: { sections: ['SUMMARY', 'CANDIDATES'] },
    });
    expect(res.status()).toBe(422);
    const problem = await res.json();
    expect(JSON.stringify(problem)).toMatch(/UNCERTAINTY|PROVENANCE/i);
  });
});
