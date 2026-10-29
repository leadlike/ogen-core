import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    // DB-backed suites share one Postgres database and truncate between tests
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
