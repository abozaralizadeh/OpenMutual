import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3517',
    // The Chrome already on the machine, so the tests download nothing.
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'bash ../scripts/e2e-stack.sh',
    url: 'http://localhost:3517',
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
