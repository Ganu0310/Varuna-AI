import { defineConfig, devices } from '@playwright/test';

/**
 * E2E configuration — 14 §14.6 Phase 13, 08_APP_FLOW §8.2 / §8.3.
 *
 * These run against a REAL stack: the real API, the real ML service, the real MongoDB with
 * the imported Marine Cadastre archive and the real Sentinel-1 scene. There is no fixture
 * server and no mocked API, because a green E2E suite against stubs would tell us the UI can
 * render invented data — the one thing this project must never do.
 *
 * Consequence, stated plainly: these tests do not run without a stack up. They fail loudly
 * rather than skipping, since a silently-skipped E2E suite reads as a passing one.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  // Journey 1 runs the real pipeline: ingest, detection and correlation are minutes of real
  // work on a real scene, not milliseconds of fixture lookup.
  timeout: 10 * 60 * 1000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  // Signs in once; every test starts already authenticated. See e2e/global-setup.ts for why.
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    storageState: 'e2e/.auth/state.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // The workspace needs WebGL for MapLibre; the headless shell provides it via SwiftShader.
    launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
