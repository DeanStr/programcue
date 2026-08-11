import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { OperationService } from "~/platform/operations/operation-service.server";
import { TaskService } from "./task-service.server";
import {
  TaskBulkService,
  TaskBulkStateError,
} from "./task-bulk-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function createSpeaker(testEnv: CloudflareEnvironment, prefix: string) {
  const personId = `${prefix}-person`;
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, created_at, updated_at
       ) VALUES (?, ?, ?, 1, unixepoch(), unixepoch())`,
    ).bind(personId, `${prefix}@example.test`, `Speaker ${prefix}`),
    testEnv.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role, accepted_at, created_at
       ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch())`,
    ).bind(
      `${prefix}-membership`,
      admin.organisationId,
      admin.eventId,
      personId,
    ),
  ]);
  return personId;
}

async function createTemplate(
  testEnv: CloudflareEnvironment,
  name: string,
  dependencyIds: string[] = [],
) {
  return new TaskService(testEnv).createTemplate(admin, {
    name,
    description: "Bulk task test.",
    targetType: "speaker",
    taskType: "checklist",
    impact: "high",
    evidenceMode: "checkbox",
    dueAnchor: "none",
    dueOffsetDays: null,
    fixedDueDate: null,
    autoAssignOnAcceptance: false,
    dependencyIds,
  });
}

describe("bulk task operations", () => {
  it("fails closed before loading a bulk workspace from an unreadable Airtable projection", async () => {
    const unavailable = new Error("Airtable projection is unavailable.");
    const assertReadable = vi.fn(async () => {
      throw unavailable;
    });
    const service = new TaskBulkService(
      env as unknown as CloudflareEnvironment,
      {
        airtable: { assertReadable } as unknown as AirtableProviderBoundary,
      },
    );

    await expect(service.workspace(admin)).rejects.toBe(unavailable);
    expect(assertReadable).toHaveBeenCalledWith(admin);
  });

  it("previews prerequisite effects and confirms a multi-speaker assignment", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-assign-${crypto.randomUUID()}`;
    const secondSpeakerId = await createSpeaker(testEnv, prefix);
    const prerequisiteId = await createTemplate(
      testEnv,
      `${prefix} prerequisite`,
    );
    const templateId = await createTemplate(testEnv, `${prefix} plan`, [
      prerequisiteId,
    ]);
    const service = new TaskBulkService(testEnv);

    const preview = await service.preview(admin, {
      action: "assign_template",
      recordIds: ["person-demo-speaker", secondSpeakerId],
      templateId,
    });
    expect(preview).toMatchObject({
      changeCount: 2,
      skippedCount: 0,
      invalidCount: 0,
    });
    const storedPreview = await service.operation(admin, preview.operationId);
    expect(storedPreview.items).toHaveLength(2);
    expect(storedPreview.items[0]?.result.additionalPrerequisites).toEqual([
      `${prefix} prerequisite`,
    ]);
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE event_id = ? AND template_id IN (?, ?)`,
      )
        .bind(admin.eventId, templateId, prerequisiteId)
        .first(),
    ).toEqual({ count: 0 });

    await service.confirm(admin, preview.operationId);
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE event_id = ? AND template_id IN (?, ?)`,
      )
        .bind(admin.eventId, templateId, prerequisiteId)
        .first(),
    ).toEqual({ count: 4 });
    expect(await service.operation(admin, preview.operationId)).toMatchObject({
      status: "completed",
      items: [
        expect.objectContaining({ status: "completed" }),
        expect.objectContaining({ status: "completed" }),
      ],
    });
    await expect(
      service.confirm(admin, preview.operationId),
    ).rejects.toBeInstanceOf(TaskBulkStateError);
  });

  it("rejects an assignment preview when a prerequisite is assigned concurrently", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-prerequisite-race-${crypto.randomUUID()}`;
    const prerequisiteId = await createTemplate(
      testEnv,
      `${prefix} prerequisite`,
    );
    const templateId = await createTemplate(testEnv, `${prefix} plan`, [
      prerequisiteId,
    ]);
    const service = new TaskBulkService(testEnv);
    const preview = await service.preview(admin, {
      action: "assign_template",
      recordIds: ["person-demo-speaker"],
      templateId,
    });

    await new TaskService(testEnv).assignTemplate(
      admin,
      prerequisiteId,
      "person-demo-speaker",
    );

    await expect(service.confirm(admin, preview.operationId)).rejects.toThrow(
      "changed after preview",
    );
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE event_id = ? AND template_id = ? AND target_id = ?`,
      )
        .bind(admin.eventId, templateId, "person-demo-speaker")
        .first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      service.operation(admin, preview.operationId),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("previews and confirms audited waiver and reopen status changes", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-status-${crypto.randomUUID()}`;
    const secondSpeakerId = await createSpeaker(testEnv, prefix);
    const templateId = await createTemplate(testEnv, `${prefix} task`);
    const tasks = new TaskService(testEnv);
    const taskIds = [
      (await tasks.assignTemplate(admin, templateId, "person-demo-speaker"))
        .taskId,
      (await tasks.assignTemplate(admin, templateId, secondSpeakerId)).taskId,
    ];
    const service = new TaskBulkService(testEnv);
    const waiver = await service.preview(admin, {
      action: "waive",
      recordIds: taskIds,
      reason: "Speaker requirements are no longer applicable.",
    });
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) AND status = 'waived'`,
      )
        .bind(JSON.stringify(taskIds))
        .first(),
    ).toEqual({ count: 0 });
    await service.confirm(admin, waiver.operationId);
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) AND status = 'waived'`,
      )
        .bind(JSON.stringify(taskIds))
        .first(),
    ).toEqual({ count: 2 });

    const reopen = await service.preview(admin, {
      action: "reopen",
      recordIds: taskIds,
      // Unrendered conditional form controls arrive through FormData as null.
      templateId: null,
      reason: null,
    });
    await service.confirm(admin, reopen.operationId);
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) AND status = 'not_started'`,
      )
        .bind(JSON.stringify(taskIds))
        .first(),
    ).toEqual({ count: 2 });
    const audit = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE event_id = ? AND entity_type = 'operation'
          AND action = 'task_bulk.completed'
          AND entity_id IN (?, ?)`,
    )
      .bind(admin.eventId, waiver.operationId, reopen.operationId)
      .first<{ count: number }>();
    expect(audit?.count).toBe(2);
  });

  it("fails a stale status preview before applying any selected mutation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-stale-${crypto.randomUUID()}`;
    const secondSpeakerId = await createSpeaker(testEnv, prefix);
    const templateId = await createTemplate(testEnv, `${prefix} task`);
    const tasks = new TaskService(testEnv);
    const taskIds = [
      (await tasks.assignTemplate(admin, templateId, "person-demo-speaker"))
        .taskId,
      (await tasks.assignTemplate(admin, templateId, secondSpeakerId)).taskId,
    ];
    const service = new TaskBulkService(testEnv);
    const preview = await service.preview(admin, {
      action: "waive",
      recordIds: taskIds,
      reason: "The bulk preview must be regenerated.",
    });
    await testEnv.DB.prepare(
      "UPDATE task_instances SET revision = revision + 1 WHERE id = ?",
    )
      .bind(taskIds[1])
      .run();

    await expect(service.confirm(admin, preview.operationId)).rejects.toThrow(
      "changed after preview",
    );
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) AND status = 'waived'`,
      )
        .bind(JSON.stringify(taskIds))
        .first(),
    ).toEqual({ count: 0 });
    expect(await service.operation(admin, preview.operationId)).toMatchObject({
      status: "failed",
    });
  });

  it("cancels an uncommitted preview through the unified operation service", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-cancel-${crypto.randomUUID()}`;
    const templateId = await createTemplate(testEnv, `${prefix} task`);
    const tasks = new TaskService(testEnv);
    const { taskId } = await tasks.assignTemplate(
      admin,
      templateId,
      "person-demo-speaker",
    );
    await tasks.administerTask(admin, {
      taskId,
      revision: 1,
      intent: "complete",
      reason: "",
    });
    const service = new TaskBulkService(testEnv);
    const preview = await service.preview(admin, {
      action: "reopen",
      recordIds: [taskId],
    });

    await new OperationService(testEnv).cancel(admin, preview.operationId);
    expect(await service.operation(admin, preview.operationId)).toMatchObject({
      status: "cancelled",
      items: [expect.objectContaining({ status: "skipped" })],
    });
    expect(
      await testEnv.DB.prepare("SELECT status FROM task_instances WHERE id = ?")
        .bind(taskId)
        .first(),
    ).toEqual({ status: "completed" });
  });
});
