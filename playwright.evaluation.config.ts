import { defineConfig, devices } from "@playwright/test";

import { e2eOrigin } from "./e2e/support/e2e-origin";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /evaluation-public-application\.spec\.ts/,
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
    extraHTTPHeaders: { "cf-connecting-ip": "203.0.113.210" },
    storageState: { cookies: [], origins: [] },
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  webServer: {
    command: "npm run serve:e2e:evaluation",
    url: `${e2eOrigin}/evaluate`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "evaluation-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});
