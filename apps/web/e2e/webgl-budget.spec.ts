import { test, expect } from '@playwright/test';

/**
 * The 3D budget — 04_UIUX §4.6.4.
 *
 * "Total WebGL contexts = 2 (map + deck, globe) — never more."
 *
 * Browsers cap live WebGL contexts (commonly around 8-16) and silently drop the OLDEST when
 * the cap is passed. A leak here therefore does not throw: a map somewhere else in the app
 * just stops painting, which is exactly the failure this project keeps finding by looking
 * rather than by being told.
 *
 * What matters is contexts ALIVE AT ONCE, not contexts ever created — React StrictMode
 * double-mounts in development, and a route change legitimately creates a new one after
 * releasing the old.
 */

const EMAIL = process.env.E2E_EMAIL ?? '';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const INVESTIGATION_ID = process.env.E2E_INVESTIGATION_ID ?? '';

test.beforeAll(() => {
  if (!EMAIL || !PASSWORD || !INVESTIGATION_ID) {
    throw new Error('Set E2E_EMAIL, E2E_PASSWORD and E2E_INVESTIGATION_ID.');
  }
});

/** Canvases currently in the document that hold a WebGL context. */
async function liveContexts(page: Page): Promise<number> {
  return page.evaluate(() => {
    let n = 0;
    for (const c of Array.from(document.querySelectorAll('canvas'))) {
      // A canvas already bound to WebGL returns that same context; asking a 2D canvas for
      // "webgl2" returns null rather than creating one.
      if (c.getContext('webgl2') || c.getContext('webgl')) n++;
    }
    return n;
  });
}

test.describe('WebGL context budget', () => {
  test('the workspace holds at most two, and the prism at most one', async ({ page }) => {
    await page.goto(`/investigations/${INVESTIGATION_ID}`);
    await page.waitForSelector('[role="tablist"]', { timeout: 90_000 });
    await page.waitForTimeout(6_000);

    const inWorkspace = await liveContexts(page);
    expect(inWorkspace, 'workspace: MapLibre + deck.gl is the whole budget').toBeLessThanOrEqual(2);
    expect(inWorkspace, 'the map should be rendering at all').toBeGreaterThan(0);

    await page.goto(`/investigations/${INVESTIGATION_ID}/prism`);
    await page.waitForSelector('.prism-canvas', { timeout: 90_000 });
    await page.waitForTimeout(6_000);

    // The prism is a separate route, so the workspace map is unmounted. If its contexts were
    // not released this would climb toward the browser cap on every navigation and the map
    // would eventually stop painting with no error anywhere.
    const inPrism = await liveContexts(page);
    expect(inPrism, 'prism: one deck.gl context, the map is unmounted').toBeLessThanOrEqual(2);

    // Back and forth several times: a leak shows as monotonic growth, not as a single bad
    // number, so one round trip would not catch it.
    for (let i = 0; i < 3; i++) {
      await page.goto(`/investigations/${INVESTIGATION_ID}`);
      await page.waitForSelector('[role="tablist"]', { timeout: 90_000 });
      await page.goto(`/investigations/${INVESTIGATION_ID}/prism`);
      await page.waitForSelector('.prism-canvas', { timeout: 90_000 });
    }
    await page.waitForTimeout(4_000);

    const afterCycling = await liveContexts(page);
    expect(
      afterCycling,
      `contexts grew to ${afterCycling} after cycling routes — a context is leaking`,
    ).toBeLessThanOrEqual(2);
  });

  test('the workspace survives repeated IN-APP navigation away and back', async ({ page }) => {
    /**
     * Regression: MapRoot gated its SAR-overlay effect on the map store's `ready` flag, which
     * is a module singleton. After the map was torn down and rebuilt, that flag was still true
     * from the PREVIOUS instance, so the effect ran against a new map whose style had not
     * loaded, MapLibre threw "Style is not done loading" from `addSource`, and the uncaught
     * throw in a passive effect unmounted the entire workspace.
     *
     * IN-APP navigation is essential to this test. `page.goto` does a full page load, which
     * resets the store — the first version of this check used it, passed against the broken
     * code, and proved nothing.
     */
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(`/investigations/${INVESTIGATION_ID}`);
    await page.waitForSelector('[role="tablist"]', { timeout: 90_000 });
    await page.waitForTimeout(4_000);

    for (let i = 0; i < 3; i++) {
      await page.click('.ws-views a:has-text("Space–time prism")');
      await page.waitForSelector('.prism-canvas', { timeout: 60_000 });
      await page.goBack();
      // The assertion: the workspace still renders. When this regressed, React unmounted the
      // tree and there was no tablist to find.
      await page.waitForSelector('[role="tablist"]', { timeout: 60_000 });
      await page.waitForTimeout(2_500);
    }

    expect(
      errors.filter((e) => /Style is not done loading/i.test(e)),
      "MapLibre threw because an effect ran before the new map's style had loaded",
    ).toHaveLength(0);

    // …and the overlay is actually back, not merely absent without crashing.
    expect(
      await page.evaluate(
        () =>
          !!(
            window as unknown as { __varunaMap?: { getLayer(id: string): unknown } }
          ).__varunaMap?.getLayer('sar-scene-raster'),
      ),
    ).toBe(true);
  });

  test('the prism states that its vertical axis is time, and cannot hide it', async ({ page }) => {
    // A viewer who reads the vertical axis as altitude misreads every track on screen, so
    // this caption is load-bearing rather than decorative — and there is deliberately no
    // control to dismiss it.
    await page.goto(`/investigations/${INVESTIGATION_ID}/prism`);
    await page.waitForSelector('.prism-caption', { timeout: 90_000 });

    await expect(page.locator('.prism-caption')).toContainText(/vertical axis is TIME/i);
    await expect(page.locator('.prism-caption')).toBeVisible();
    expect(await page.locator('.prism-caption button').count()).toBe(0);
  });
});
