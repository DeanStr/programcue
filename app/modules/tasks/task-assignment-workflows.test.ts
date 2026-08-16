import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
        "participant",
        `comment-intent:${crypto.randomUUID()}`,
      );
      await service.addComment(
        admin,
        second.id,
        "Check this against the event brief.",
        "administrator",
        `comment-intent:${crypto.randomUUID()}`,
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
