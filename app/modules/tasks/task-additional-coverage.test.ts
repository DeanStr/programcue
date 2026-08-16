import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { fixedDateEndEpoch, TaskService } from "./task-service.server";

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
  describe("additional workflow coverage", () => {
    it("coerces only boolean form fields and preserves literal text and select values", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const templateId = await service.createTemplate(admin, {
        name: `Literal structured answers ${crypto.randomUUID()}`,
        description: "Preserve answers that happen to look like booleans.",
        targetType: "speaker",
        taskType: "short_form",
        impact: "high",
        evidenceMode: "text",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [],
        configuration: {
          form: {
            fields: [
              {
                id: "confirmation",
                label: "Confirmed",
                type: "boolean",
                required: true,
              },
              {
                id: "literal_choice",
                label: "Literal choice",
                type: "select",
                required: true,
                options: ["true", "false"],
              },
              {
                id: "literal_text",
                label: "Literal text",
                type: "short_text",
                required: true,
              },
            ],
          },
        },
      });
      const { taskId } = await service.assignTemplate(
        admin,
        templateId,
        speaker.personId,
      );
      const task = (await service.listParticipantTasks(speaker)).find(
        (candidate) => candidate.id === taskId,
      )!;

      await service.completeParticipant(speaker, {
        taskId,
        revision: task.revision,
        responses: {
          confirmation: "true",
          literal_choice: "false",
          literal_text: "true",
        },
      });

      const completed = await testEnv.DB.prepare(
        `SELECT evidence_json AS evidenceJson
           FROM task_instances WHERE id = ? AND event_id = ?`,
      )
        .bind(taskId, speaker.eventId)
        .first<{ evidenceJson: string }>();
      expect(JSON.parse(completed!.evidenceJson).responses).toEqual({
        confirmation: true,
        literal_choice: "false",
        literal_text: "true",
      });
    });
  });

  describe("additional workflow coverage", () => {
    it("interprets fixed due dates at the end of the event-local calendar day", () => {
      expect(fixedDateEndEpoch("2030-06-01", "America/Toronto")).toBe(
        Date.parse("2030-06-02T03:59:59Z") / 1_000,
      );
      expect(fixedDateEndEpoch("2030-06-01", "Australia/Melbourne")).toBe(
        Date.parse("2030-06-01T13:59:59Z") / 1_000,
      );
    });
  });
});
