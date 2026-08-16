import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  DataImportService,
  DataImportStateError,
} from "~/platform/operations/data-import-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("CSV imports", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare(
      "DELETE FROM operation_jobs WHERE event_id = ? AND type = 'data.import'",
    )
      .bind(viewer.eventId)
      .run();
  });

  describe("submission imports", () => {
    it("rejects submission lifecycle states that require the evaluation and decision workflows", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const existingReference = `IMPORT-ACCEPTED-${suffix}`;
      await env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, status, answers_json,
           submitted_snapshot_json, submitted_at
         ) VALUES (?, ?, ?, 'Released decision', 'accepted', '{}', '{}', unixepoch())`,
      )
        .bind(
          `submission-import-accepted-${suffix}`,
          viewer.eventId,
          existingReference,
        )
        .run();

      const preview = await new DataImportService(
        env as unknown as CloudflareEnvironment,
      ).preview(viewer, {
        resource: "submissions",
        fileName: "submission-lifecycle.csv",
        csv: [
          "publicReference,title,category,format,status,submitterEmail,submittedAt",
          `${existingReference},Attempted reopen,,,draft,,`,
          `IMPORT-NEW-ACCEPTED-${suffix},Attempted acceptance,,,accepted,,2026-08-10T12:00:00Z`,
        ].join("\n"),
      });

      expect(preview).toMatchObject({ validCount: 0, invalidCount: 2 });
      const items = await env.DB.prepare(
        `SELECT error_message AS errorMessage
           FROM operation_items WHERE operation_id = ? ORDER BY item_key`,
      )
        .bind(preview.operationId)
        .all<{ errorMessage: string }>();
      expect(items.results[0]?.errorMessage).toContain(
        "must be changed through the submission, evaluation or decision workflow",
      );
      expect(items.results[1]?.errorMessage).toContain("must be draft");
      await expect(
        new DataImportService(env as unknown as CloudflareEnvironment).confirm(
          viewer,
          preview.operationId,
        ),
      ).rejects.toBeInstanceOf(DataImportStateError);
    });
  });
});
