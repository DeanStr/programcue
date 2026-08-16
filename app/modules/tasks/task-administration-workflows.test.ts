import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  acceptTestFileScanDispatch,
  completeTestDirectUpload,
} from "~/modules/files/direct-upload.test-helper";
import { FileService } from "~/modules/files/file-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  fixedDateEndEpoch,
  TaskService,
  TaskStateError,
} from "./task-service.server";

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

async function createFileTask(testEnv: CloudflareEnvironment, name: string) {
  const tasks = new TaskService(testEnv);
  const templateId = await tasks.createTemplate(admin, {
    name,
    description: "Upload test evidence.",
    targetType: "speaker",
    taskType: "file_upload",
    impact: "high",
    evidenceMode: "file",
    dueAnchor: "none",
    dueOffsetDays: null,
    fixedDueDate: null,
    autoAssignOnAcceptance: false,
    dependencyIds: [],
  });
  return (await tasks.assignTemplate(admin, templateId, speaker.personId))
    .taskId;
}

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

function withBatchRace(
  testEnv: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let injectRace = true;
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (injectRace) {
            injectRace = false;
            await race();
          }
          return target.batch(statements);
        };
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

function withBatchBarrier(testEnv: CloudflareEnvironment, participants = 2) {
  let arrivals = 0;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          arrivals += 1;
          if (arrivals === participants) release();
          await allArrived;
          return target.batch(statements);
        };
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

async function createDependencyPair(
  testEnv: CloudflareEnvironment,
  dependentName: string,
  dependent: {
    taskType: "checklist" | "file_upload";
    evidenceMode: "checkbox" | "file";
  },
) {
  const tasks = new TaskService(testEnv);
  const prerequisiteTemplateId = await tasks.createTemplate(admin, {
    name: `${dependentName} prerequisite`,
    description: "Complete this first.",
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
  const dependentTemplateId = await tasks.createTemplate(admin, {
    name: dependentName,
    description: "Depends on the prerequisite.",
    targetType: "speaker",
    taskType: dependent.taskType,
    impact: "high",
    evidenceMode: dependent.evidenceMode,
    dueAnchor: "none",
    dueOffsetDays: null,
    fixedDueDate: null,
    autoAssignOnAcceptance: false,
    dependencyIds: [prerequisiteTemplateId],
  });
  const { taskId: dependentTaskId } = await tasks.assignTemplate(
    admin,
    dependentTemplateId,
    speaker.personId,
  );
  let assigned = await tasks.listParticipantTasks(speaker);
  const prerequisite = assigned.find(
    (task) => task.templateId === prerequisiteTemplateId,
  )!;
  await tasks.completeParticipant(speaker, {
    taskId: prerequisite.id,
    revision: prerequisite.revision,
    confirmed: true,
  });
  assigned = await tasks.listParticipantTasks(speaker);
  return {
    prerequisite: assigned.find((task) => task.id === prerequisite.id)!,
    dependent: assigned.find((task) => task.id === dependentTaskId)!,
  };
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
