import { defineConfig } from "@playwright/test";

import fullConfig, { desktopChromiumProject } from "./playwright.config";

export default defineConfig({
  ...fullConfig,
  projects: [
    {
      ...desktopChromiumProject,
      testIgnore: [
        /cross-browser-smoke\.spec\.ts/,
        /evaluation-public-application\.spec\.ts/,
        /performance\.spec\.ts/,
        /visual\.spec\.ts/,
      ],
    },
  ],
});
