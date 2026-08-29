import { test, expect } from '@playwright/test';

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

const EMPTY_INVESTIGATION_ID = process.env.E2E_EMPTY_INVESTIGATION_ID ?? '';

test.describe('Journey 2 — the system declines to overstate', () => {
  test('an investigation with no work done says so, and offers no ranking', async ({ page }) => {
    test.skip(
      !EMPTY_INVESTIGATION_ID,
      'Set E2E_EMPTY_INVESTIGATION_ID to a real investigation with no scenes ingested.',
    );
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
    // No explicit login: the `request` fixture inherits the shared storageState. Signing in
    // here as well would be redundant traffic against a 10-per-minute auth limiter.
    //
    // `detectionId` is required by the request schema, so an empty body never reaches the
    // origin check — it is rejected as a 400 first. To exercise the 409 the investigation
    // must have a detection but no origin estimate, which is what
    // E2E_NO_ORIGIN_DETECTION_ID names.
    const detectionId = process.env.E2E_NO_ORIGIN_DETECTION_ID;

    const res = await request.post(
      `/api/v1/investigations/${EMPTY_INVESTIGATION_ID}/candidates/correlate`,
      { data: detectionId ? { detectionId } : {} },
    );

    // Either refusal is correct and both are the point: correlation never proceeds on
    // incomplete preconditions. Which code fires depends on WHICH precondition is missing.
    expect([400, 409]).toContain(res.status());

    const problem = JSON.stringify(await res.json());
    // A bare status is not enough. The response must name what is missing, because the
    // analyst's next question is always "so what do I do instead".
    expect(problem).toMatch(detectionId ? /origin/i : /detectionId|validation/i);
  });

  test('a report cannot be produced without its uncertainty and provenance sections', async ({
    request,
  }) => {
    const target = EMPTY_INVESTIGATION_ID || process.env.E2E_INVESTIGATION_ID;
    test.skip(!target, 'Set E2E_INVESTIGATION_ID or E2E_EMPTY_INVESTIGATION_ID.');

    // Deliberately request a dossier WITHOUT the mandatory sections. The server must refuse
    // rather than quietly omit them — a report that names a vessel with the caveats stripped
    // out is the single most dangerous artefact this system could emit.
    //
    // Two independent guards reject this and the OUTER one answers: the route schema's
    // `.refine` fails first and surfaces as a 400 ZodError, so the service's own 422 from
    // `assertMandatorySections` is never reached through HTTP. Both codes are accepted here
    // because which one fires is an implementation detail of where the check sits; that the
    // request is refused, and that the response names the missing sections, is not.
    const res = await request.post(`/api/v1/investigations/${target}/report/generate`, {
      data: { sections: ['SUMMARY', 'CANDIDATES'] },
    });
    expect([400, 422]).toContain(res.status());
    const problem = await res.json();
    expect(JSON.stringify(problem)).toMatch(/UNCERTAINTY|PROVENANCE/i);
  });
});
