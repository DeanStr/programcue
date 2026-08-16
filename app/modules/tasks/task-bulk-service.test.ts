import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { OperationService } from "~/platform/operations/operation-service.server";
import {
  TaskBulkService,
  TaskBulkStateError,
} from "./task-bulk-service.server";
import { TaskService } from "./task-service.server";

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

type WorkflowStatus =
  | "prospect"
  | "invited"
  | "confirmed"
  | "declined"
  | "withdrawn";

async function createRosterSpeaker(
  testEnv: CloudflareEnvironment,
  prefix: string,
  status: WorkflowStatus,
) {
  const personId = `${prefix}-person`;
  const email = `${prefix}@example.test`;
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, created_at, updated_at
       ) VALUES (?, ?, ?, 1, unixepoch(), unixepoch())`,
    ).bind(personId, email, `Roster ${status} ${prefix}`),
    testEnv.DB.prepare(
      `INSERT INTO event_speaker_workflows (
         event_id, person_id, status, source, last_operation_id,
         updated_by_person_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'manual', ?, ?, unixepoch(), unixepoch())`,
    ).bind(
      admin.eventId,
      personId,
      status,
      `roster-test:${prefix}`,
      admin.personId,
    ),
  ]);
  return { personId, email, status };
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

function withBulkClaimRace(
  testEnv: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let injectRace = true;
  const wrapStatement = (
    statement: D1PreparedStatement,
    claimStatement: boolean,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values), claimStatement);
        }
        if (property === "run" && claimStatement) {
          return async () => {
            if (injectRace) {
              injectRace = false;
              await race();
            }
            return target.run();
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) =>
          wrapStatement(
            target.prepare(sql),
            sql.includes("SET status = 'running'") &&
              sql.includes("type = 'task.bulk'"),
          );
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? racingDb : Reflect.get(target, property);
    },
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

  it("lists and assigns only active event-roster workflow speakers", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `task-roster-${crypto.randomUUID()}`;
    const active = await Promise.all(
      (["prospect", "invited", "confirmed"] as const).map((status) =>
        createRosterSpeaker(testEnv, `${prefix}-${status}`, status),
      ),
    );
    const inactive = await Promise.all(
      (["declined", "withdrawn"] as const).map((status) =>
        createRosterSpeaker(testEnv, `${prefix}-${status}`, status),
      ),
    );
    const templateId = await createTemplate(testEnv, `${prefix} plan`);
    const tasks = new TaskService(testEnv);

    const [adminWorkspace, bulkWorkspace] = await Promise.all([
      tasks.getAdminWorkspace(admin),
      new TaskBulkService(testEnv).workspace(admin),
    ]);
    for (const speaker of active) {
      expect(adminWorkspace.speakers).toContainEqual(
        expect.objectContaining({
          id: speaker.personId,
          email: speaker.email,
        }),
      );
      expect(bulkWorkspace.speakers).toContainEqual(
        expect.objectContaining({
          id: speaker.personId,
          email: speaker.email,
        }),
      );
      await expect(
        tasks.assignTemplate(admin, templateId, speaker.personId),
      ).resolves.toEqual(
        expect.objectContaining({ taskId: expect.any(String) }),
      );
    }
    for (const speaker of inactive) {
      expect(adminWorkspace.speakers).not.toContainEqual(
        expect.objectContaining({ id: speaker.personId }),
      );
      expect(bulkWorkspace.speakers).not.toContainEqual(
        expect.objectContaining({ id: speaker.personId }),
      );
      await expect(
        tasks.assignTemplate(admin, templateId, speaker.personId),
      ).rejects.toThrow("not an active speaker");
    }
  });

  it("previews and confirms task assignment for roster-only active speakers", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-active-roster-${crypto.randomUUID()}`;
    const active = await Promise.all(
      (["prospect", "invited", "confirmed"] as const).map((status) =>
        createRosterSpeaker(testEnv, `${prefix}-${status}`, status),
      ),
    );
    const declined = await createRosterSpeaker(
      testEnv,
      `${prefix}-declined`,
      "declined",
    );
    const templateId = await createTemplate(testEnv, `${prefix} plan`);
    const service = new TaskBulkService(testEnv);

    await expect(
      service.preview(admin, {
        action: "assign_template",
        recordIds: [declined.personId],
        templateId,
      }),
    ).rejects.toThrow("not all active");

    const preview = await service.preview(admin, {
      action: "assign_template",
      recordIds: active.map((speaker) => speaker.personId),
      templateId,
    });
    expect(preview).toMatchObject({
      changeCount: 3,
      skippedCount: 0,
      invalidCount: 0,
    });
    expect(
      (await service.operation(admin, preview.operationId)).items.every(
        (item) => item.result.expectedRevision !== null,
      ),
    ).toBe(true);

    await service.confirm(admin, preview.operationId);
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE event_id = ? AND template_id = ?
            AND target_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
      )
        .bind(
          admin.eventId,
          templateId,
          JSON.stringify(active.map((speaker) => speaker.personId)),
        )
        .first(),
    ).resolves.toEqual({ count: 3 });
  });

  it("invalidates a bulk assignment preview when an active roster status changes", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-roster-stale-${crypto.randomUUID()}`;
    const rosterSpeaker = await createRosterSpeaker(
      testEnv,
      prefix,
      "prospect",
    );
    const templateId = await createTemplate(testEnv, `${prefix} plan`);
    const service = new TaskBulkService(testEnv);
    const preview = await service.preview(admin, {
      action: "assign_template",
      recordIds: [rosterSpeaker.personId],
      templateId,
    });

    await testEnv.DB.prepare(
      `UPDATE event_speaker_workflows
          SET status = 'invited', revision = revision + 1,
              last_operation_id = ?, updated_at = unixepoch()
        WHERE event_id = ? AND person_id = ?`,
    )
      .bind(
        `roster-status-change:${prefix}`,
        admin.eventId,
        rosterSpeaker.personId,
      )
      .run();

    await expect(service.confirm(admin, preview.operationId)).rejects.toThrow(
      "changed after preview",
    );
    await expect(
      service.operation(admin, preview.operationId),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE event_id = ? AND template_id = ? AND target_id = ?`,
      )
        .bind(admin.eventId, templateId, rosterSpeaker.personId)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("atomically rejects a roster revision race at the bulk claim boundary", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-roster-claim-race-${crypto.randomUUID()}`;
    const rosterSpeaker = await createRosterSpeaker(
      testEnv,
      prefix,
      "prospect",
    );
    const templateId = await createTemplate(testEnv, `${prefix} plan`);
    const racingEnv = withBulkClaimRace(testEnv, async () => {
      await testEnv.DB.prepare(
        `UPDATE event_speaker_workflows
            SET status = 'invited', revision = revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE event_id = ? AND person_id = ?`,
      )
        .bind(
          `roster-claim-race:${prefix}`,
          admin.eventId,
          rosterSpeaker.personId,
        )
        .run();
    });
    const service = new TaskBulkService(racingEnv);
    const preview = await service.preview(admin, {
      action: "assign_template",
      recordIds: [rosterSpeaker.personId],
      templateId,
    });

    await expect(service.confirm(admin, preview.operationId)).rejects.toThrow(
      "changed after preview",
    );
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE event_id = ? AND template_id = ? AND target_id = ?`,
      )
        .bind(admin.eventId, templateId, rosterSpeaker.personId)
        .first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      service.operation(admin, preview.operationId),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("rejects a changed task-template snapshot before claiming the bulk preview", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-template-stale-${crypto.randomUUID()}`;
    const rosterSpeaker = await createRosterSpeaker(
      testEnv,
      prefix,
      "confirmed",
    );
    const templateId = await createTemplate(testEnv, `${prefix} plan`);
    const service = new TaskBulkService(testEnv);
    const preview = await service.preview(admin, {
      action: "assign_template",
      recordIds: [rosterSpeaker.personId],
      templateId,
    });

    await testEnv.DB.prepare(
      `UPDATE task_templates
          SET name = name || ' changed', updated_at = updated_at + 1
        WHERE id = ? AND event_id = ?`,
    )
      .bind(templateId, admin.eventId)
      .run();

    await expect(service.confirm(admin, preview.operationId)).rejects.toThrow(
      "changed after preview",
    );
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE event_id = ? AND template_id = ? AND target_id = ?`,
      )
        .bind(admin.eventId, templateId, rosterSpeaker.personId)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("invalidates a skipped assignment preview when its roster status changes", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-skipped-roster-stale-${crypto.randomUUID()}`;
    const rosterSpeaker = await createRosterSpeaker(
      testEnv,
      prefix,
      "prospect",
    );
    const pendingSpeaker = await createRosterSpeaker(
      testEnv,
      `${prefix}-pending`,
      "confirmed",
    );
    const templateId = await createTemplate(testEnv, `${prefix} plan`);
    await new TaskService(testEnv).assignTemplate(
      admin,
      templateId,
      rosterSpeaker.personId,
    );
    const service = new TaskBulkService(testEnv);
    const preview = await service.preview(admin, {
      action: "assign_template",
      recordIds: [rosterSpeaker.personId, pendingSpeaker.personId],
      templateId,
    });
    expect(preview).toMatchObject({ changeCount: 1, skippedCount: 1 });

    await testEnv.DB.prepare(
      `UPDATE event_speaker_workflows
          SET status = 'withdrawn', revision = revision + 1,
              last_operation_id = ?, updated_at = unixepoch()
        WHERE event_id = ? AND person_id = ?`,
    )
      .bind(
        `roster-skipped-status-change:${prefix}`,
        admin.eventId,
        rosterSpeaker.personId,
      )
      .run();

    await expect(service.confirm(admin, preview.operationId)).rejects.toThrow(
      "changed after preview",
    );
    await expect(
      service.operation(admin, preview.operationId),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE event_id = ? AND template_id = ? AND target_id = ?`,
      )
        .bind(admin.eventId, templateId, pendingSpeaker.personId)
        .first(),
    ).resolves.toEqual({ count: 0 });
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
    expect(storedPreview.expectedTemplates).toHaveLength(2);
    expect(storedPreview.items[0]?.result.additionalPrerequisites).toEqual([
      `${prefix} prerequisite`,
    ]);
    const persistedSnapshot = await testEnv.DB.prepare(
      `SELECT operation.result_json AS operationResultJson,
              item.result_json AS itemResultJson
         FROM operation_jobs operation
         JOIN operation_items item ON item.operation_id = operation.id
        WHERE operation.id = ?
        ORDER BY item.item_key`,
    )
      .bind(preview.operationId)
      .all<{ operationResultJson: string; itemResultJson: string }>();
    expect(
      JSON.parse(persistedSnapshot.results[0]!.operationResultJson),
    ).toMatchObject({ expectedTemplates: expect.any(Array) });
    expect(
      JSON.parse(persistedSnapshot.results[0]!.operationResultJson)
        .expectedTemplates,
    ).toHaveLength(2);
    expect(
      persistedSnapshot.results.every(
        (row) => !("expectedTemplates" in JSON.parse(row.itemResultJson)),
      ),
    ).toBe(true);
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

  it("rejects a status preview when a skipped task drifts before confirmation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-skipped-status-stale-${crypto.randomUUID()}`;
    const secondSpeakerId = await createSpeaker(testEnv, prefix);
    const templateId = await createTemplate(testEnv, `${prefix} task`);
    const tasks = new TaskService(testEnv);
    const pendingTaskId = (
      await tasks.assignTemplate(admin, templateId, "person-demo-speaker")
    ).taskId;
    const skippedTaskId = (
      await tasks.assignTemplate(admin, templateId, secondSpeakerId)
    ).taskId;
    await tasks.administerTask(admin, {
      taskId: skippedTaskId,
      revision: 1,
      intent: "waive",
      reason: "This task is not required for the second speaker.",
    });

    const service = new TaskBulkService(testEnv);
    const preview = await service.preview(admin, {
      action: "waive",
      recordIds: [pendingTaskId, skippedTaskId],
      reason: "These speaker requirements are no longer applicable.",
    });
    expect(preview).toMatchObject({ changeCount: 1, skippedCount: 1 });

    await testEnv.DB.prepare(
      `UPDATE task_instances
          SET status = 'not_started', revision = revision + 1,
              updated_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    )
      .bind(skippedTaskId, admin.eventId)
      .run();

    await expect(service.confirm(admin, preview.operationId)).rejects.toThrow(
      "changed after preview",
    );
    await expect(
      testEnv.DB.prepare(
        `SELECT status, revision FROM task_instances
          WHERE id = ? AND event_id = ?`,
      )
        .bind(pendingTaskId, admin.eventId)
        .first(),
    ).resolves.toEqual({ status: "not_started", revision: 1 });
    await expect(
      service.operation(admin, preview.operationId),
    ).resolves.toMatchObject({
      status: "failed",
      items: expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          errorCode: "STALE_PREVIEW",
          result: expect.objectContaining({ recordId: pendingTaskId }),
        }),
        expect.objectContaining({
          status: "skipped",
          result: expect.objectContaining({ recordId: skippedTaskId }),
        }),
      ]),
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
