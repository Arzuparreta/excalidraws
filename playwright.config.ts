import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4317',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:4317/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
