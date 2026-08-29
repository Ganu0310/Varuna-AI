import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STORAGE_STATE = 'e2e/.auth/state.json';

/**
 * Sign in ONCE and share the session across the suite.
 *
 * Every spec used to log in per test. The API allows 10 auth requests per minute per IP
 * (02_TRD SEC-5), so as the suite grew it started tripping its own rate limiter: tests failed
 * at `toHaveURL(/investigations/)` still sitting on /login, which reads like a broken app
 * rather than a throttled one. The limiter was right; the suite was hammering it.
 *
 * Signing in once is also what a real session looks like, so the tests exercise the same
 * cookie lifetime an analyst does rather than a fresh login per action.
 */
async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://localhost:5173';
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'Set E2E_EMAIL and E2E_PASSWORD. These tests run against a real account on a real ' +
        'stack; there is no fixture login to fall back to.',
    );
  }

  mkdirSync(dirname(STORAGE_STATE), { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/investigations/, { timeout: 30_000 });

  await page.context().storageState({ path: STORAGE_STATE });
  await browser.close();
}

export default globalSetup;
