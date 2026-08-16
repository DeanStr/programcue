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

  describe("additional workflow coverage", () => {
    it("shows row-level reconciliation errors and refuses confirmation", async () => {
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "sessions",
        fileName: "sessions.csv",
        csv: [
          "slug,title,description,trackSlug,format,durationMinutes,expectedAttendance,status,visibility",
          "missing-track,Missing track,,does-not-exist,presentation,45,100,unscheduled,public",
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 0, invalidCount: 1 });
      expect(
        await env.DB.prepare(
          "SELECT status, error_code AS errorCode, error_message AS errorMessage FROM operation_items WHERE operation_id = ?",
        )
          .bind(preview.operationId)
          .first(),
      ).toMatchObject({
        status: "failed",
        errorCode: "VALIDATION_ERROR",
        errorMessage: "trackSlug does not match a track in this event",
      });
      await expect(
        service.confirm(viewer, preview.operationId),
      ).rejects.toBeInstanceOf(DataImportStateError);
    });
  });
});
