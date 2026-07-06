// @ts-check
import { defineConfig, devices } from '@playwright/test';

// Tests E2E contre le worker déployé en production.
// page.route() intercepte les appels API côté navigateur, peu importe l'origine.
const BASE_URL = 'https://bwrmaps.com';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 2,
  reporter: 'list',

  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
