import { defineConfig } from "@playwright/test";

import fullConfig, { desktopChromiumProject } from "./playwright.config";

export default defineConfig({
  ...fullConfig,
  projects: [
    {
      ...desktopChromiumProject,
      testMatch:
        /(?:accessibility-axe|assistant|canonical-golden-path|canonical-provider-boundaries|security-headers)\.spec\.ts/u,
    },
  ],
});
