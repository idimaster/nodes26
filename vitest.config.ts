import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts', 'gotchas/*/test.ts'],
    // Graph tests share the single Community database, so test files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
