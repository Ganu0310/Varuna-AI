import { test, expect, type Page } from '@playwright/test';

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

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/investigations/, { timeout: 30_000 });
}

test.describe('WebGL context budget', () => {
  test('the workspace holds at most two, and the prism at most one', async ({ page }) => {
    await login(page);

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

  test('the prism states that its vertical axis is time, and cannot hide it', async ({ page }) => {
    // A viewer who reads the vertical axis as altitude misreads every track on screen, so
    // this caption is load-bearing rather than decorative — and there is deliberately no
    // control to dismiss it.
    await login(page);
    await page.goto(`/investigations/${INVESTIGATION_ID}/prism`);
    await page.waitForSelector('.prism-caption', { timeout: 90_000 });

    await expect(page.locator('.prism-caption')).toContainText(/vertical axis is TIME/i);
    await expect(page.locator('.prism-caption')).toBeVisible();
    expect(await page.locator('.prism-caption button').count()).toBe(0);
  });
});
