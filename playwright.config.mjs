import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  use: { headless: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The page-world tests also run on real Firefox, since the walker and
    // overlay have to behave there too (Firefox extensions reach closed roots
    // via Element.openOrClosedShadowRoot). The extension-context test skips
    // itself on anything that isn't chromium.
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
