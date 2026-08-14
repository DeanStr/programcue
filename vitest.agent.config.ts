import { resolve } from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "~": resolve(import.meta.dirname, "app"),
    },
  },
  plugins: [
    cloudflareTest(async () => ({
      main: "./app/modules/ai/program-cue-agent.test-worker.ts",
      additionalExports: {
        ProgramCueEventAgent: "DurableObject",
      },
      miniflare: {
        compatibilityDate: "2026-08-08",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["FILES", "BACKUPS"],
        durableObjects: {
          PROGRAM_CUE_AGENT: {
            className: "ProgramCueEventAgent",
            useSQLite: true,
          },
        },
        bindings: {
          APP_ENV: "test",
          DEMO_MODE: "true",
          EVALUATION_MODE: "false",
          SOURCE_REVISION: "test-revision",
          DEFAULT_EVENT_ID: "evt-foe-2025",
          BETTER_AUTH_URL: "http://localhost",
          BETTER_AUTH_SECRET:
            "test-only-secret-with-at-least-thirty-two-characters",
          ANONYMOUS_ITINERARY_SECRET:
            "test-only-itinerary-secret-with-at-least-thirty-two-characters",
          AUTH_EMAIL_FROM: "Program Cue Test <test@example.com>",
          TEST_MIGRATIONS: await readD1Migrations(
            resolve(import.meta.dirname, "migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    name: "agent",
    include: ["app/modules/ai/program-cue-agent.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
