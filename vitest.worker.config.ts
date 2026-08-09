import { resolve } from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

import { nodeOnlyTestFiles } from "./vitest.test-files.ts";

export default defineProject({
  resolve: {
    alias: {
      "~": resolve(import.meta.dirname, "app"),
    },
  },
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        compatibilityDate: "2026-08-08",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["FILES"],
        bindings: {
          APP_ENV: "test",
          DEMO_MODE: "true",
          DEFAULT_EVENT_ID: "evt-foe-2025",
          BETTER_AUTH_URL: "http://localhost",
          BETTER_AUTH_SECRET: "test-only-secret-with-at-least-thirty-two-characters",
          AUTH_EMAIL_FROM: "Program Cue Test <test@example.com>",
          RESEND_API_KEY: "test-resend-key",
          TEST_MIGRATIONS: await readD1Migrations(resolve(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    name: "worker",
    include: ["app/**/*.test.ts"],
    exclude: [...nodeOnlyTestFiles],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
