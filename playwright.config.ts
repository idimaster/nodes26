import { defineConfig } from '@playwright/test';

// Demo UI E2E (T4.2). Needs Neo4j up (docker compose up -d); wipes and reloads the graph.
const PORT = 4747;

export default defineConfig({
  testDir: 'tests/e2e-ui',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 90_000,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true, viewport: { width: 1920, height: 1080 } },
  webServer: {
    command: 'node_modules/.bin/tsx scripts/build-ui.ts && node_modules/.bin/tsx packages/gate/bin/console.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { GATE_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
