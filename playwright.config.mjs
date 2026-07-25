import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  use: { headless: true },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Fixtures are loaded over file://, where Chrome treats each file as an
        // opaque origin, so a page could not script its own same-origin iframe.
        // Real pages are http(s) and can. Without this the frame tests would be
        // testing the file:// sandbox rather than the tool.
        launchOptions: { args: ['--allow-file-access-from-files'] },
      },
    },
    // The page-world tests also run on real Firefox, since the walker and
    // overlay have to behave there too (Firefox extensions reach closed roots
    // via Element.openOrClosedShadowRoot). The extension-context test skips
    // itself on anything that isn't chromium.
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
