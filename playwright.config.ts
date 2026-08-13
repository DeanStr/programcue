import { defineConfig, devices } from "@playwright/test";

import { e2eOrigin } from "./e2e/support/e2e-origin";

const trace =
  process.env.CI || process.env.PROGRAM_CUE_E2E_TRACE === "1"
    ? "retain-on-failure"
    : "off";

const laptopVisualTag = /@laptop-visual/;

export const desktopChromiumProject = {
  name: "desktop-chromium",
  grepInvert: laptopVisualTag,
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
    // The outer runner creates one immutable production build before it starts
    // any shards. A shard must never rebuild the shared output while another
    // Workerd instance is serving it.
    command: "npm run serve:e2e:prepared",
    url: `${e2eOrigin}/admin/event`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    desktopChromiumProject,
    {
      name: "mobile-chromium",
      grepInvert: laptopVisualTag,
      use: { ...devices["Pixel 7"] },
      testMatch: /visual\.spec\.ts/,
    },
    {
      name: "laptop-chromium",
      grep: laptopVisualTag,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
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
