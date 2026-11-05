import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts', 'gotchas/*/test.ts'],
    // Graph tests share the single Community database, so test files run one at a time.
    fileParallelism: false,
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'packages/*/bin/**/*.ts',
        'examples/*/src/**/*.ts',
        'graph/**/*.ts',
        'scripts/**/*.ts',
        'viz/src/**/*.ts',
      ],
      reporter: ['text-summary', 'text', 'json-summary'],
      thresholds: {
        lines: 75,
        'packages/engine/src/**': { lines: 90 },
      },
    },
    hookTimeout: 60_000,
  },
});
