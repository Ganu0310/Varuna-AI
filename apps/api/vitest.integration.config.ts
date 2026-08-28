import { defineConfig } from 'vitest/config';

/**
 * Integration tests — require a REAL MongoDB (and later Redis/MinIO).
 * Separate from the unit suite so `pnpm test` stays runnable with no services.
 * Run with: pnpm --filter @varuna/api test:integration
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    environment: 'node',
    setupFiles: ['src/test/setup-env.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
