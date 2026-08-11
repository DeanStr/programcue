import { defineConfig, devices } from "@playwright/test";

import { e2eOrigin } from "./e2e/support/e2e-origin";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "line",
  use: {
    baseURL: e2eOrigin,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.01,
    },
  },
  webServer: {
    command: "npm run serve:e2e",
    url: `${e2eOrigin}/admin/event`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      testMatch: /visual\.spec\.ts/,
    },
    {
      name: "firefox-smoke",
      use: { ...devices["Desktop Firefox"] },
      testMatch: /cross-browser-smoke\.spec\.ts/,
    },
    {
      name: "webkit-smoke",
      use: { ...devices["Desktop Safari"] },
      testMatch: /cross-browser-smoke\.spec\.ts/,
    },
  ],
});
