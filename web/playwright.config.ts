import { defineConfig } from '@playwright/test';

// BASE_PATH=/openmutual/ runs the same tests with the app under that path, behind a strict proxy
// that turns away anything outside it (see scripts/e2e-stack.sh).
const prefixed = Boolean(process.env.BASE_PATH);
// E2E_ORIGIN points the tests at a different front, like a real nginx in front of port 3517.
const origin = process.env.E2E_ORIGIN ?? (prefixed ? 'http://127.0.0.1:3518' : 'http://127.0.0.1:3517');
const base = prefixed ? `/${process.env.BASE_PATH!.replace(/^\/+|\/+$/g, '')}/` : '/';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: origin,
    // The Chrome already on the machine, so the tests download nothing.
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'bash ../scripts/e2e-stack.sh',
    url: `${origin}${base}`,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
