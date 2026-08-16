import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
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
const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function createChecklistTask(
  testEnv: CloudflareEnvironment,
  name: string,
) {
  const tasks = new TaskService(testEnv);
  const templateId = await tasks.createTemplate(admin, {
    name,
    description: "Confirm the test requirement.",
    targetType: "speaker",
    taskType: "checklist",
    impact: "high",
    evidenceMode: "checkbox",
    dueAnchor: "none",
    dueOffsetDays: null,
    fixedDueDate: null,
    autoAssignOnAcceptance: false,
    dependencyIds: [],
  });
  return (await tasks.assignTemplate(admin, templateId, speaker.personId))
    .taskId;
}

describe("onboarding task service", () => {
  describe("administration workflows", () => {
    it("requires a reason for an administrator waiver", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const task = (
        await new TaskService(testEnv).getAdminWorkspace(admin)
      ).tasks.find((item) => item.id === "task-demo-slides")!;
      await expect(
        new TaskService(testEnv).administerTask(admin, {
          taskId: task.id,
          revision: task.revision,
          intent: "waive",
          reason: "",
        }),
      ).rejects.toThrow("Explain why");
    });

    it("extends one speaker task deadline with audited event-local intent", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const executeIdempotent = vi.fn(
        async (
          _viewer: unknown,
          _command: unknown,
          execute: () => Promise<unknown>,
        ) => execute(),
      );
      const service = new TaskService(testEnv, {
        airtable: {
          executeIdempotent,
        } as unknown as AirtableProviderBoundary,
      });
      const taskId = await createChecklistTask(
        testEnv,
        `Deadline extension ${crypto.randomUUID()}`,
      );
      await testEnv.DB.prepare(
        `UPDATE task_instances
            SET due_at = unixepoch() - 60, status = 'overdue',
                readiness_state = 'overdue'
          WHERE id = ? AND event_id = ?`,
      )
        .bind(taskId, admin.eventId)
        .run();

      const result = await service.extendSpeakerDeadline(admin, {
        taskId,
        revision: 1,
        dueDate: "2035-05-20",
        reason: "Speaker requested an agreed individual extension.",
      });
      expect(result.dueAt).toBeGreaterThan(Math.floor(Date.now() / 1_000));
      expect(executeIdempotent).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: admin.eventId }),
        expect.objectContaining({ operation: "task.deadline.extend" }),
        expect.any(Function),
        { replay: "reject" },
      );
      await expect(
        testEnv.DB.prepare(
          `SELECT status, readiness_state AS readinessState,
                  readiness_percent AS readinessPercent, due_at AS dueAt,
                  revision,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.entity_id = task_instances.id
                      AND audit.action = 'task.deadline.extended') AS auditCount
             FROM task_instances WHERE id = ? AND event_id = ?`,
        )
          .bind(taskId, admin.eventId)
          .first(),
      ).resolves.toEqual({
        status: "not_started",
        readinessState: "on_track",
        readinessPercent: 0,
        dueAt: result.dueAt,
        revision: 2,
        auditCount: 1,
      });
    });

    it("does not turn a missing deadline into an extension", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const taskId = await createChecklistTask(
        testEnv,
        `No deadline extension ${crypto.randomUUID()}`,
      );

      await expect(
        service.extendSpeakerDeadline(admin, {
          taskId,
          revision: 1,
          dueDate: "2035-05-20",
          reason: "This must remain a distinct template change.",
        }),
      ).rejects.toThrow(/no existing deadline to extend/i);
      await expect(
        testEnv.DB.prepare(
          `SELECT due_at AS dueAt, revision,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.entity_id = task_instances.id
                      AND audit.action = 'task.deadline.extended') AS auditCount
             FROM task_instances WHERE id = ? AND event_id = ?`,
        )
          .bind(taskId, admin.eventId)
          .first(),
      ).resolves.toEqual({ dueAt: null, revision: 1, auditCount: 0 });
    });
  });

  describe("administration workflows", () => {
    it("rejects administrator actions that are illegal for the current task state", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const cases = [
        { status: "submitted", intent: "complete" },
        { status: "not_started", intent: "reopen" },
        { status: "completed", intent: "waive" },
      ] as const;

      for (const item of cases) {
        const taskId = await createChecklistTask(
          testEnv,
          `Illegal ${item.intent} from ${item.status}`,
        );
        await testEnv.DB.prepare(
          `
          UPDATE task_instances SET status = ? WHERE id = ? AND event_id = ?
        `,
        )
          .bind(item.status, taskId, admin.eventId)
          .run();

        await expect(
          service.administerTask(admin, {
            taskId,
            revision: 1,
            intent: item.intent,
            reason: item.intent === "waive" ? "No longer needed" : "",
          }),
        ).rejects.toThrow(/cannot be/);
        expect(
          await testEnv.DB.prepare(
            `
          SELECT status, revision FROM task_instances WHERE id = ? AND event_id = ?
        `,
          )
            .bind(taskId, admin.eventId)
            .first(),
        ).toEqual({
          status: item.status,
          revision: 1,
        });
      }
    });
  });
});
