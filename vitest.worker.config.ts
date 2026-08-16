import { resolve } from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
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
        r2Buckets: ["FILES", "BACKUPS"],
        images: { binding: "IMAGES" },
        bindings: {
          APP_ENV: "test",
          DEMO_MODE: "true",
          EVALUATION_MODE: "false",
          MAINTENANCE_MODE: "false",
          SOURCE_REVISION: "test-revision",
          DEFAULT_EVENT_ID: "evt-foe-2025",
          BETTER_AUTH_URL: "http://localhost",
          BETTER_AUTH_SECRET:
            "test-only-secret-with-at-least-thirty-two-characters",
          ANONYMOUS_ITINERARY_SECRET:
            "test-only-itinerary-secret-with-at-least-thirty-two-characters",
          AUTH_EMAIL_FROM: "Program Cue Test <test@example.com>",
          EMAIL_PROVIDER: "resend",
          RESEND_API_KEY: "test-resend-key",
          INTEGRATION_CREDENTIALS_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          WEBHOOK_CREDENTIALS_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          TURNSTILE_SECRET_KEY: "test-turnstile-secret",
          FILE_SCANNER_WEBHOOK_SECRET: "test-file-scanner-secret",
          FILE_SCANNER_API_URL: "https://scanner.example.test/jobs",
          FILE_SCANNER_DISPATCH_SECRET:
            "test-scanner-dispatch-secret-at-least-32-characters",
          RESOURCE_EMBED_PROVIDERS: "youtube,vimeo,google_maps",
          GOOGLE_MAPS_EMBED_API_KEY: "test-google-maps-embed-key-1234567890",
          R2_ACCOUNT_ID: "test-account-id",
          R2_BUCKET_NAME: "program-cue-test-files",
          R2_ACCESS_KEY_ID: "test-r2-access-key",
          R2_SECRET_ACCESS_KEY: "test-r2-secret-key",
          TEST_MIGRATIONS: await readD1Migrations(
            resolve(import.meta.dirname, "migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    name: "worker",
    include: ["app/**/*.test.ts"],
    exclude: [...nodeOnlyTestFiles, "app/modules/ai/program-cue-agent.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
