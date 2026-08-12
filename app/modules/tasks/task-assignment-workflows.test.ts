import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

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
  describe("assignment workflows", () => {
    it("materializes prerequisites, blocks dependent work, then unlocks it after completion", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const prerequisite = await service.createTemplate(admin, {
        name: "Confirm test profile",
        description: "Confirm the profile details.",
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
      const dependent = await service.createTemplate(admin, {
        name: "Submit test requirements",
        description: "Available only after profile confirmation.",
        targetType: "speaker",
        taskType: "short_form",
        impact: "critical",
        evidenceMode: "admin_approval",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [prerequisite],
      });
      await service.assignTemplate(admin, dependent, speaker.personId);
      let tasks = await service.listParticipantTasks(speaker);
      const first = tasks.find((task) => task.templateId === prerequisite)!;
      const second = tasks.find((task) => task.templateId === dependent)!;
      expect(first.status).toBe("not_started");
      expect(second.status).toBe("blocked");

      await service.completeParticipant(speaker, {
        taskId: first.id,
        revision: first.revision,
        confirmed: true,
      });
      tasks = await service.listParticipantTasks(speaker);
      expect(tasks.find((task) => task.id === second.id)?.status).toBe(
        "not_started",
      );
      const unlocked = tasks.find((task) => task.id === second.id)!;
      await service.completeParticipant(speaker, {
        taskId: unlocked.id,
        revision: unlocked.revision,
        text: "All requirements are confirmed.",
      });
      expect(
        (await service.listParticipantTasks(speaker)).find(
          (task) => task.id === second.id,
        )?.status,
      ).toBe("submitted");
      await service.addComment(
        speaker,
        second.id,
        "Please review the submitted requirements.",
      );
      await service.addComment(
        admin,
        second.id,
        "Check this against the event brief.",
        "administrator",
      );
      const adminTask = (await service.getAdminWorkspace(admin)).tasks.find(
        (task) => task.id === second.id,
      );
      expect(adminTask?.evidence[0]?.details).toMatchObject({
        text: "All requirements are confirmed.",
      });
      expect(adminTask?.comments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "Please review the submitted requirements.",
            visibility: "participant",
          }),
          expect.objectContaining({
            body: "Check this against the event brief.",
            visibility: "administrator",
          }),
        ]),
      );
    });
  });

  describe("assignment workflows", () => {
    it("rejects task assignment before mutation when a required webhook Queue is unbound", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const endpointId = `task-webhook-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO webhook_endpoints (
           id, organisation_id, event_id, name, url, secret_ciphertext,
           event_types_json, status, created_by_person_id
         ) VALUES (?, ?, ?, 'Task events', 'https://hooks.example.com/tasks',
                   'test-only', '["task.created","task.updated"]', 'active', ?)`,
      )
        .bind(endpointId, admin.organisationId, admin.eventId, admin.personId)
        .run();
      const service = new TaskService(testEnv);
      const templateId = await service.createTemplate(admin, {
        name: `Webhook task ${crypto.randomUUID()}`,
        description: "Exercise task event delivery.",
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
      await expect(
        service.assignTemplate(admin, templateId, speaker.personId),
      ).rejects.toMatchObject({ name: "WebhookQueueConfigurationError" });
      expect(
        await testEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM task_instances
               WHERE event_id = ? AND template_id = ? AND target_id = ?) AS taskCount,
             (SELECT COUNT(*) FROM webhook_deliveries
               WHERE endpoint_id = ?) AS deliveryCount`,
        )
          .bind(admin.eventId, templateId, speaker.personId, endpointId)
          .first<{
            taskCount: number;
            deliveryCount: number;
          }>(),
      ).toEqual({ taskCount: 0, deliveryCount: 0 });
      await testEnv.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?")
        .bind(endpointId)
        .run();
    });
  });
});
