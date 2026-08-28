import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Integration tests need a real MongoDB — they run via vitest.integration.config.ts
    // (`pnpm --filter @varuna/api test:integration`). The unit suite must stay runnable
    // with no services up.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.integration.test.ts'],
    environment: 'node',
    setupFiles: ['src/test/setup-env.ts'],
  },
});
