import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { DataImportService } from "~/platform/operations/data-import-service.server";

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

  describe("task imports", () => {
    it("rejects invalid task lifecycle changes and task IDs owned by another event", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const otherEventId = `event-import-task-${suffix}`;
      const crossEventTaskId = `task-cross-event-${suffix}`;
      const currentTaskId = `task-current-event-${suffix}`;
      const unblockedTaskId = `task-unblocked-${suffix}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO events (
             id, organisation_id, name, slug, timezone, starts_at, ends_at,
             brand_accent, session_formats_json, file_policy_json
           ) SELECT ?, organisation_id, 'Import collision event', ?, timezone,
                    starts_at, ends_at, brand_accent, session_formats_json,
                    file_policy_json
               FROM events WHERE id = ? AND organisation_id = ?`,
        ).bind(
          otherEventId,
          `import-collision-${suffix}`,
          viewer.eventId,
          viewer.organisationId,
        ),
        env.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, title, task_type, impact,
             status, readiness_state, readiness_percent, revision
           ) VALUES (?, ?, 'event', ?, 'Other event task', 'checklist', 'medium',
                     'not_started', 'on_track', 0, 1)`,
        ).bind(crossEventTaskId, otherEventId, otherEventId),
        env.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, title, task_type, impact,
             status, readiness_state, readiness_percent, revision
           ) VALUES (?, ?, 'event', ?, 'Completed task', 'checklist', 'medium',
                     'completed', 'on_track', 100, 1)`,
        ).bind(currentTaskId, viewer.eventId, viewer.eventId),
        env.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, title, task_type, impact,
             status, readiness_state, readiness_percent, revision
           ) VALUES (?, ?, 'event', ?, 'Unblocked task', 'checklist', 'medium',
                     'not_started', 'on_track', 0, 1)`,
        ).bind(unblockedTaskId, viewer.eventId, viewer.eventId),
      ]);

      const preview = await new DataImportService(
        env as unknown as CloudflareEnvironment,
      ).preview(viewer, {
        resource: "tasks",
        fileName: "task-lifecycle.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,impact,dueAt",
          `${crossEventTaskId},Collision,,event,${viewer.eventId},,not_started,medium,`,
          `${currentTaskId},Attempted progress,,event,${viewer.eventId},,in_progress,medium,`,
          `task-new-completed-${suffix},Attempted completion,,event,${viewer.eventId},,completed,medium,`,
          `${unblockedTaskId},Attempted block,,event,${viewer.eventId},,blocked,medium,`,
        ].join("\n"),
      });

      expect(preview).toMatchObject({ validCount: 0, invalidCount: 4 });
      const errors = await env.DB.prepare(
        `SELECT error_message AS errorMessage
           FROM operation_items WHERE operation_id = ? ORDER BY item_key`,
      )
        .bind(preview.operationId)
        .all<{ errorMessage: string }>();
      expect(errors.results.map((row) => row.errorMessage)).toEqual([
        "id is already owned by a task in another event",
        "a completed task cannot transition to in progress by CSV import",
        "a new task must start in not_started status; import later lifecycle changes against its assigned id",
        "blocked status requires at least one unfinished prerequisite task",
      ]);
    });

    it("applies explicit task completion, waiver and reopen lifecycle transitions", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const completedTaskId = `task-import-complete-${suffix}`;
      const waivedTaskId = `task-import-waive-${suffix}`;
      const reopenedTaskId = `task-import-reopen-${suffix}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, title, task_type, impact,
             status, readiness_state, readiness_percent, revision
           ) VALUES (?, ?, 'event', ?, 'Import completion', 'checklist', 'high',
                     'in_progress', 'at_risk', 40, 1)`,
        ).bind(completedTaskId, viewer.eventId, viewer.eventId),
        env.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, title, task_type, impact,
             status, readiness_state, readiness_percent, revision
           ) VALUES (?, ?, 'event', ?, 'Import waiver', 'checklist', 'medium',
                     'not_started', 'on_track', 0, 1)`,
        ).bind(waivedTaskId, viewer.eventId, viewer.eventId),
        env.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, title, task_type, impact,
             status, readiness_state, readiness_percent, revision,
             waiver_json, completed_at, completed_by_person_id
           ) VALUES (?, ?, 'event', ?, 'Import reopen', 'checklist', 'low',
                     'waived', 'on_track', 100, 1,
                     '{"reason":"Previous waiver","by":"person-demo-admin"}',
                     unixepoch(), ?)`,
        ).bind(reopenedTaskId, viewer.eventId, viewer.eventId, viewer.personId),
      ]);

      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "tasks",
        fileName: "task-statuses.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,statusReason,impact,dueAt",
          `${completedTaskId},Imported completion,,event,${viewer.eventId},,completed,,high,`,
          `${waivedTaskId},Imported waiver,,event,${viewer.eventId},,waived,No longer required,medium,`,
          `${reopenedTaskId},Imported reopen,,event,${viewer.eventId},,not_started,,low,`,
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 3, invalidCount: 0 });

      await service.confirm(viewer, preview.operationId);
      const tasks = await env.DB.prepare(
        `SELECT id, status, readiness_state AS readinessState,
                readiness_percent AS readinessPercent, revision,
                waiver_json AS waiverJson, completed_at AS completedAt,
                completed_by_person_id AS completedByPersonId,
                last_operation_id AS operationId
           FROM task_instances
          WHERE id IN (?, ?, ?) ORDER BY id`,
      )
        .bind(completedTaskId, waivedTaskId, reopenedTaskId)
        .all<{
          id: string;
          status: string;
          readinessState: string;
          readinessPercent: number;
          revision: number;
          waiverJson: string | null;
          completedAt: number | null;
          completedByPersonId: string | null;
          operationId: string;
        }>();
      const byId = Object.fromEntries(
        tasks.results.map((task) => [task.id, task]),
      );
      expect(byId[completedTaskId]).toMatchObject({
        status: "completed",
        readinessState: "on_track",
        readinessPercent: 100,
        revision: 2,
        completedByPersonId: viewer.personId,
        operationId: preview.operationId,
      });
      expect(byId[completedTaskId]?.completedAt).toEqual(expect.any(Number));
      expect(byId[waivedTaskId]).toMatchObject({
        status: "waived",
        readinessState: "on_track",
        readinessPercent: 100,
        revision: 2,
        completedByPersonId: viewer.personId,
        operationId: preview.operationId,
      });
      expect(JSON.parse(byId[waivedTaskId]!.waiverJson!)).toEqual({
        reason: "No longer required",
        by: viewer.personId,
      });
      expect(byId[reopenedTaskId]).toMatchObject({
        status: "not_started",
        readinessState: "on_track",
        readinessPercent: 0,
        revision: 2,
        waiverJson: null,
        completedAt: null,
        completedByPersonId: null,
        operationId: preview.operationId,
      });
      const lifecycleAudits = await env.DB.prepare(
        `SELECT action FROM audit_events
          WHERE event_id = ? AND correlation_id = ?
            AND entity_type = 'task_instance'
          ORDER BY action`,
      )
        .bind(viewer.eventId, preview.operationId)
        .all<{ action: string }>();
      expect(lifecycleAudits.results.map((row) => row.action)).toEqual([
        "task.complete",
        "task.reopen",
        "task.waive",
      ]);
    });

    it("fails before mutation when webhook fan-out would exceed the D1 query budget", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const taskIds = Array.from(
        { length: 66 },
        (_, index) => `task-import-budget-${suffix}-${index}`,
      );
      await env.DB.prepare("DELETE FROM webhook_endpoints WHERE event_id = ?")
        .bind(viewer.eventId)
        .run();
      await env.DB.batch(
        taskIds.map((taskId, index) =>
          env.DB.prepare(
            `INSERT INTO task_instances (
               id, event_id, target_type, target_id, title, task_type, impact,
               status, readiness_state, readiness_percent, revision
             ) VALUES (?, ?, 'event', ?, ?, 'checklist', 'medium',
                       'in_progress', 'at_risk', 40, 1)`,
          ).bind(
            taskId,
            viewer.eventId,
            viewer.eventId,
            `Budget task ${index}`,
          ),
        ),
      );
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "tasks",
        fileName: "task-budget.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,statusReason,impact,dueAt",
          ...taskIds.map(
            (taskId, index) =>
              `${taskId},Budget task ${index},,event,${viewer.eventId},,completed,,medium,`,
          ),
        ].join("\n"),
      });
      await env.DB.prepare(
        `INSERT INTO webhook_endpoints (
           id, organisation_id, event_id, name, url, secret_ciphertext,
           event_types_json, status, failure_count, created_at, updated_at
         ) VALUES (?, ?, ?, 'Task import budget', 'https://example.com/webhook',
                   'test-ciphertext', '["task.updated"]', 'active', 0,
                   unixepoch(), unixepoch())`,
      )
        .bind(
          `webhook-import-budget-${suffix}`,
          viewer.organisationId,
          viewer.eventId,
        )
        .run();

      await expect(
        service.confirm(viewer, preview.operationId),
      ).rejects.toThrow("more than one import can process safely");
      await expect(
        env.DB.prepare(
          "SELECT status, revision FROM task_instances WHERE id = ?",
        )
          .bind(taskIds[0])
          .first(),
      ).resolves.toEqual({ status: "in_progress", revision: 1 });
      await expect(
        env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
          .bind(preview.operationId)
          .first(),
      ).resolves.toEqual({ status: "received" });
    });

    it("rejects a cross-event task ID claimed after preview without reporting completion", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const taskId = `task-late-cross-event-${suffix}`;
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "tasks",
        fileName: "task-id-race.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,impact,dueAt",
          `${taskId},Previewed task,,event,${viewer.eventId},,not_started,medium,`,
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 1, invalidCount: 0 });

      const otherEventId = `event-late-task-${suffix}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO events (
             id, organisation_id, name, slug, timezone, starts_at, ends_at,
             brand_accent, session_formats_json, file_policy_json
           ) SELECT ?, organisation_id, 'Late task collision', ?, timezone,
                    starts_at, ends_at, brand_accent, session_formats_json,
                    file_policy_json
               FROM events WHERE id = ? AND organisation_id = ?`,
        ).bind(
          otherEventId,
          `late-task-collision-${suffix}`,
          viewer.eventId,
          viewer.organisationId,
        ),
        env.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, title, task_type, impact,
             status, readiness_state, readiness_percent, revision
           ) VALUES (?, ?, 'event', ?, 'Concurrent task', 'checklist', 'medium',
                     'not_started', 'on_track', 0, 1)`,
        ).bind(taskId, otherEventId, otherEventId),
      ]);

      await expect(
        service.confirm(viewer, preview.operationId),
      ).rejects.toThrow("changed after preview");
      await expect(
        env.DB.prepare(
          "SELECT status, progress_completed AS completed FROM operation_jobs WHERE id = ?",
        )
          .bind(preview.operationId)
          .first(),
      ).resolves.toEqual({ status: "received", completed: 0 });
    });
  });

  describe("task imports", () => {
    it("uses canonical room limits and strict RFC 3339 task timestamps", async () => {
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const roomPreview = await service.preview(viewer, {
        resource: "rooms",
        fileName: "invalid-rooms.csv",
        csv: [
          "name,building,level,capacity,position,status",
          `${"R".repeat(121)},,,,0,active`,
          "Oversized capacity,,,100001,1,active",
        ].join("\n"),
      });
      expect(roomPreview).toMatchObject({ validCount: 0, invalidCount: 2 });

      const taskPreview = await service.preview(viewer, {
        resource: "tasks",
        fileName: "invalid-task-dates.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,impact,dueAt",
          `invalid-calendar-date,Invalid calendar date,,event,${viewer.eventId},,not_started,medium,2026-02-30T00:00:00Z`,
          `locale-date,Locale date,,event,${viewer.eventId},,not_started,medium,02/03/2026`,
        ].join("\n"),
      });
      expect(taskPreview).toMatchObject({ validCount: 0, invalidCount: 2 });
      const errors = await env.DB.prepare(
        `SELECT error_message AS errorMessage
           FROM operation_items WHERE operation_id = ? ORDER BY item_key`,
      )
        .bind(taskPreview.operationId)
        .all<{ errorMessage: string }>();
      expect(errors.results.map((row) => row.errorMessage)).toEqual([
        expect.stringContaining("RFC 3339"),
        expect.stringContaining("RFC 3339"),
      ]);
    });
  });
});
