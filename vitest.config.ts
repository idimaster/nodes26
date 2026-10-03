import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts', 'gotchas/*/test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
