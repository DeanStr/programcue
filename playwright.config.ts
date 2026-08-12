import { defineConfig, devices } from "@playwright/test";

import { e2eOrigin } from "./e2e/support/e2e-origin";

const trace = process.env.CI || process.env.PROGRAM_CUE_E2E_TRACE === "1"
  ? "retain-on-failure"
  : "off";

export const desktopChromiumProject = {
  name: "desktop-chromium",
  testIgnore: /cross-browser-smoke\.spec\.ts/,
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
  },
};

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
    trace,
    storageState: {
      cookies: [
        {
          name: "program_cue_demo_identity",
          value: "administrator",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
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
    desktopChromiumProject,
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
