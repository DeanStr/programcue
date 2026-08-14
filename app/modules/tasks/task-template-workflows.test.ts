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
  describe("template workflows", () => {
    it("creates and validates the minimum structured travel onboarding forms", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      await expect(
        service.createTravelOnboardingTemplates(admin, false),
      ).rejects.toThrow(/review and confirm/i);
      const templates = await service.createTravelOnboardingTemplates(
        admin,
        true,
      );
      expect(templates.createdTemplateIds).toHaveLength(2);
      await expect(
        service.createTravelOnboardingTemplates(admin, true),
      ).resolves.toEqual({
        hotelTemplateId: templates.hotelTemplateId,
        flightTemplateId: templates.flightTemplateId,
        createdTemplateIds: [],
      });
      const stored = await testEnv.DB.prepare(
        `SELECT id, auto_assign_on_acceptance AS autoAssign,
                configuration_json AS configurationJson
           FROM task_templates WHERE id IN (?, ?) ORDER BY name`,
      )
        .bind(templates.hotelTemplateId, templates.flightTemplateId)
        .all<{
          id: string;
          autoAssign: number;
          configurationJson: string;
        }>();
      expect(stored.results).toHaveLength(2);
      expect(stored.results.every((row) => row.autoAssign === 1)).toBe(true);
      expect(
        stored.results.map(
          (row) => JSON.parse(row.configurationJson).preset as string,
        ),
      ).toEqual(["speaker_travel_flight_v1", "speaker_travel_hotel_v1"]);
      expect(
        stored.results.every(
          (row) => JSON.parse(row.configurationJson).form.fields.length >= 4,
        ),
      ).toBe(true);
      await testEnv.DB.prepare(
        `UPDATE task_templates
            SET due_anchor = 'none', due_offset_minutes = NULL
          WHERE id = ? AND event_id = ?`,
      )
        .bind(templates.hotelTemplateId, admin.eventId)
        .run();

      const { taskId } = await service.assignTemplate(
        admin,
        templates.hotelTemplateId,
        speaker.personId,
      );
      const participantTask = (
        await service.listParticipantTasks(speaker)
      ).find((task) => task.id === taskId)!;
      expect(participantTask.formFields.map((field) => field.id)).toContain(
        "requires_hotel",
      );
      await expect(
        service.completeParticipant(speaker, {
          taskId,
          revision: participantTask.revision,
          responses: { requires_hotel: true, check_in: "2030-05-20" },
        }),
      ).rejects.toThrow(/check-out date/i);
      await expect(
        service.completeParticipant(speaker, {
          taskId,
          revision: participantTask.revision,
          responses: {
            requires_hotel: true,
            check_in: "2030-02-30",
            check_out: "2030-05-23",
          },
        }),
      ).rejects.toThrow(/valid date.*check-in/i);
      await service.completeParticipant(speaker, {
        taskId,
        revision: participantTask.revision,
        responses: {
          requires_hotel: true,
          check_in: "2030-05-20",
          check_out: "2030-05-23",
          room_requirements: "Step-free route from the lobby.",
        },
      });
      const completed = await testEnv.DB.prepare(
        `SELECT status, evidence_json AS evidenceJson
           FROM task_instances WHERE id = ? AND event_id = ?`,
      )
        .bind(taskId, speaker.eventId)
        .first<{ status: string; evidenceJson: string }>();
      expect(completed?.status).toBe("completed");
      expect(JSON.parse(completed!.evidenceJson).responses).toMatchObject({
        requires_hotel: true,
        check_in: "2030-05-20",
      });
    });
  });

  describe("template workflows", () => {
    it("validates both travel presets before creating either missing form", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const eventId = `evt-travel-atomic-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           session_formats_json, file_policy_json
         )
         SELECT ?, organisation_id, 'Travel atomicity', ?, timezone,
                starts_at, ends_at, session_formats_json, file_policy_json
           FROM events WHERE id = ? AND organisation_id = ?`,
      )
        .bind(
          eventId,
          `travel-atomic-${crypto.randomUUID()}`,
          admin.eventId,
          admin.organisationId,
        )
        .run();
      const eventAdmin = { ...admin, eventId };
      const service = new TaskService(testEnv);
      const templates = await service.createTravelOnboardingTemplates(
        eventAdmin,
        true,
      );
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          "DELETE FROM task_templates WHERE id = ? AND event_id = ?",
        ).bind(templates.hotelTemplateId, eventId),
        testEnv.DB.prepare(
          `UPDATE task_templates SET name = 'Modified flight preset'
            WHERE id = ? AND event_id = ?`,
        ).bind(templates.flightTemplateId, eventId),
      ]);

      await expect(
        service.createTravelOnboardingTemplates(eventAdmin, true),
      ).rejects.toThrow(/differs from the required hotel or flight form/i);
      await expect(
        testEnv.DB.prepare(
          `SELECT COUNT(*) AS count FROM task_templates
            WHERE event_id = ?
              AND json_extract(configuration_json, '$.preset') = 'speaker_travel_hotel_v1'`,
        )
          .bind(eventId)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    });

    it("reuses exact travel preset winners when two confirmations race", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const eventId = `evt-travel-race-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           session_formats_json, file_policy_json
         )
         SELECT ?, organisation_id, 'Travel preset race', ?, timezone,
                starts_at, ends_at, session_formats_json, file_policy_json
           FROM events WHERE id = ? AND organisation_id = ?`,
      )
        .bind(
          eventId,
          `travel-race-${crypto.randomUUID()}`,
          admin.eventId,
          admin.organisationId,
        )
        .run();
      const eventAdmin = { ...admin, eventId };
      const racingEnv = withBatchBarrier(testEnv);

      const [first, second] = await Promise.all([
        new TaskService(racingEnv).createTravelOnboardingTemplates(
          eventAdmin,
          true,
        ),
        new TaskService(racingEnv).createTravelOnboardingTemplates(
          eventAdmin,
          true,
        ),
      ]);

      expect(second.hotelTemplateId).toBe(first.hotelTemplateId);
      expect(second.flightTemplateId).toBe(first.flightTemplateId);
      expect(
        first.createdTemplateIds.length + second.createdTemplateIds.length,
      ).toBe(2);
      const stored = await testEnv.DB.prepare(
        `SELECT COUNT(*) AS templateCount
           FROM task_templates
          WHERE event_id = ?
            AND json_extract(configuration_json, '$.preset') IN (?, ?)`,
      )
        .bind(eventId, "speaker_travel_hotel_v1", "speaker_travel_flight_v1")
        .first<{ templateCount: number }>();
      expect(stored).toEqual({ templateCount: 2 });
    });

    it("scopes deterministic template intents to one event and rejects payload drift", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const secondEventId = `evt-task-intent-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           session_formats_json, file_policy_json
         )
         SELECT ?, organisation_id, 'Task intent event', ?, timezone,
                starts_at, ends_at, session_formats_json, file_policy_json
           FROM events WHERE id = ? AND organisation_id = ?`,
      )
        .bind(
          secondEventId,
          `task-intent-${crypto.randomUUID()}`,
          admin.eventId,
          admin.organisationId,
        )
        .run();
      const input = {
        name: "Event-scoped template intent",
        description: "The same caller intent is safe in another event.",
        targetType: "speaker" as const,
        taskType: "checklist" as const,
        impact: "high" as const,
        evidenceMode: "checkbox" as const,
        dueAnchor: "none" as const,
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [],
      };
      const intentId = `template-intent-${crypto.randomUUID()}`;
      const service = new TaskService(testEnv);
      const first = await service.createTemplate(admin, input, intentId);
      await expect(
        service.createTemplate(admin, input, intentId),
      ).resolves.toBe(first);
      await expect(
        service.createTemplate(
          admin,
          { ...input, name: "A different template" },
          intentId,
        ),
      ).rejects.toBeInstanceOf(TaskStateError);

      const second = await service.createTemplate(
        { ...admin, eventId: secondEventId },
        input,
        intentId,
      );
      expect(second).not.toBe(first);
      const stored = await testEnv.DB.prepare(
        `SELECT event_id AS eventId FROM task_templates
          WHERE id IN (?, ?) ORDER BY event_id`,
      )
        .bind(first, second)
        .all<{ eventId: string }>();
      expect(stored.results.map((row) => row.eventId).sort()).toEqual(
        [admin.eventId, secondEventId].sort(),
      );
    });
  });

  describe("template workflows", () => {
    it("assigns session and event templates to their real targets", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const sessionTemplateId = await service.createTemplate(admin, {
        name: `Session preparation ${crypto.randomUUID()}`,
        description: "Prepare this session together.",
        targetType: "session",
        taskType: "checklist",
        impact: "high",
        evidenceMode: "checkbox",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [],
      });
      const eventTemplateId = await service.createTemplate(admin, {
        name: `Event administration ${crypto.randomUUID()}`,
        description: "Complete an event-wide administration step.",
        targetType: "event",
        taskType: "administrator_only",
        impact: "medium",
        evidenceMode: "none",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [],
      });
      const sessionAssignment = await service.assignTemplate(
        admin,
        sessionTemplateId,
        "session-demo-speaker",
      );
      const eventAssignment = await service.assignTemplate(
        admin,
        eventTemplateId,
        admin.eventId,
      );

      expect(
        await testEnv.DB.prepare(
          `SELECT target_type AS targetType,target_id AS targetId,
                  owner_person_id AS ownerPersonId
             FROM task_instances WHERE id = ?`,
        )
          .bind(sessionAssignment.taskId)
          .first(),
      ).toEqual({
        targetType: "session",
        targetId: "session-demo-speaker",
        ownerPersonId: null,
      });
      expect(
        await testEnv.DB.prepare(
          `SELECT target_type AS targetType,target_id AS targetId,
                  owner_person_id AS ownerPersonId
             FROM task_instances WHERE id = ?`,
        )
          .bind(eventAssignment.taskId)
          .first(),
      ).toEqual({
        targetType: "event",
        targetId: admin.eventId,
        ownerPersonId: null,
      });
      const participantTasks = await service.listParticipantTasks(speaker);
      expect(
        participantTasks.some((task) => task.id === sessionAssignment.taskId),
      ).toBe(true);
      expect(
        participantTasks.some((task) => task.id === eventAssignment.taskId),
      ).toBe(false);

      await expect(
        service.createTemplate(admin, {
          name: `Invalid mixed-scope dependency ${crypto.randomUUID()}`,
          description:
            "A session plan cannot reuse a speaker target implicitly.",
          targetType: "session",
          taskType: "checklist",
          impact: "high",
          evidenceMode: "checkbox",
          dueAnchor: "none",
          dueOffsetDays: null,
          fixedDueDate: null,
          autoAssignOnAcceptance: true,
          dependencyIds: ["task-template-profile"],
        }),
      ).rejects.toBeInstanceOf(TaskStateError);
    });
  });

  describe("template workflows", () => {
    it("revalidates active roster status at the task insert boundary", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const suffix = crypto.randomUUID();
      const personId = `task-roster-race-person-${suffix}`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, created_at, updated_at
           ) VALUES (?, ?, 'Roster race speaker', 1, unixepoch(), unixepoch())`,
        ).bind(personId, `task-roster-race-${suffix}@example.test`),
        testEnv.DB.prepare(
          `INSERT INTO event_speaker_workflows (
             event_id, person_id, status, source, last_operation_id,
             updated_by_person_id, created_at, updated_at
           ) VALUES (?, ?, 'prospect', 'manual', ?, ?, unixepoch(), unixepoch())`,
        ).bind(
          admin.eventId,
          personId,
          `task-roster-race-create:${suffix}`,
          admin.personId,
        ),
      ]);
      const templateId = await new TaskService(testEnv).createTemplate(admin, {
        name: `Roster race ${crypto.randomUUID()}`,
        description: "Do not assign after the speaker withdraws.",
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
      const racingEnv = withBatchRace(testEnv, async () => {
        await testEnv.DB.prepare(
          `UPDATE event_speaker_workflows
              SET status = 'withdrawn', revision = revision + 1,
                  last_operation_id = ?, updated_at = unixepoch()
            WHERE event_id = ? AND person_id = ?`,
        )
          .bind(
            `task-roster-race:${crypto.randomUUID()}`,
            admin.eventId,
            personId,
          )
          .run();
      });

      await expect(
        new TaskService(racingEnv).assignTemplate(admin, templateId, personId),
      ).rejects.toThrow("changed before it could be created");
      await expect(
        testEnv.DB.prepare(
          `SELECT COUNT(*) AS count FROM task_instances
            WHERE event_id = ? AND template_id = ? AND target_id = ?`,
        )
          .bind(admin.eventId, templateId, personId)
          .first(),
      ).resolves.toEqual({ count: 0 });
    });

    it("rolls back the full dependency plan when the roster changes at the assignment batch", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const suffix = crypto.randomUUID();
      const personId = `task-plan-roster-race-person-${suffix}`;
      const endpointId = `task-plan-roster-race-webhook-${suffix}`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, created_at, updated_at
           ) VALUES (?, ?, 'Task plan roster race speaker', 1, unixepoch(), unixepoch())`,
        ).bind(personId, `task-plan-roster-race-${suffix}@example.test`),
        testEnv.DB.prepare(
          `INSERT INTO event_speaker_workflows (
             event_id, person_id, status, source, last_operation_id,
             updated_by_person_id, created_at, updated_at
           ) VALUES (?, ?, 'prospect', 'manual', ?, ?, unixepoch(), unixepoch())`,
        ).bind(
          admin.eventId,
          personId,
          `task-plan-roster-create:${suffix}`,
          admin.personId,
        ),
        testEnv.DB.prepare(
          `INSERT INTO webhook_endpoints (
             id, organisation_id, event_id, name, url, secret_ciphertext,
             event_types_json, status, created_by_person_id
           ) VALUES (?, ?, ?, 'Task plan race events',
                     'https://hooks.example.com/task-plan-race', 'test-only',
                     '["task.created"]', 'active', ?)`,
        ).bind(endpointId, admin.organisationId, admin.eventId, admin.personId),
      ]);
      const tasks = new TaskService(testEnv);
      const prerequisiteId = await tasks.createTemplate(admin, {
        name: `Task plan race prerequisite ${suffix}`,
        description: "Must remain atomic with its dependent task.",
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
      const rootTemplateId = await tasks.createTemplate(admin, {
        name: `Task plan race root ${suffix}`,
        description: "Must not survive a rejected dependency plan.",
        targetType: "speaker",
        taskType: "checklist",
        impact: "high",
        evidenceMode: "checkbox",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [prerequisiteId],
      });
      const queueEnv = {
        ...testEnv,
        OPERATIONS_QUEUE: {
          send: async () => undefined,
        },
      } as unknown as CloudflareEnvironment;
      const racingEnv = withBatchRace(queueEnv, async () => {
        await testEnv.DB.prepare(
          `UPDATE event_speaker_workflows
              SET status = 'withdrawn', revision = revision + 1,
                  last_operation_id = ?, updated_at = unixepoch()
            WHERE event_id = ? AND person_id = ?`,
        )
          .bind(`task-plan-roster-race:${suffix}`, admin.eventId, personId)
          .run();
      });

      await expect(
        new TaskService(racingEnv).assignTemplate(
          admin,
          rootTemplateId,
          personId,
        ),
      ).rejects.toThrow("changed before it could be created");
      await expect(
        testEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM task_instances
               WHERE event_id = ? AND target_id = ?
                 AND template_id IN (?, ?)) AS taskCount,
             (SELECT COUNT(*) FROM audit_events
               WHERE event_id = ? AND action = 'task.assigned'
                 AND json_extract(metadata_json, '$.targetId') = ?) AS auditCount,
             (SELECT COUNT(*) FROM webhook_deliveries
               WHERE endpoint_id = ? AND event_type = 'task.created') AS deliveryCount`,
        )
          .bind(
            admin.eventId,
            personId,
            prerequisiteId,
            rootTemplateId,
            admin.eventId,
            personId,
            endpointId,
          )
          .first(),
      ).resolves.toEqual({ taskCount: 0, auditCount: 0, deliveryCount: 0 });
      await testEnv.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?")
        .bind(endpointId)
        .run();
    });

    it("materializes one task when the same template is assigned concurrently", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const templateId = await new TaskService(testEnv).createTemplate(admin, {
        name: `Concurrent assignment ${crypto.randomUUID()}`,
        description: "Create this task once.",
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
      const service = new TaskService(withBatchBarrier(testEnv));
      const assignments = await Promise.all([
        service.assignTemplate(admin, templateId, speaker.personId),
        service.assignTemplate(admin, templateId, speaker.personId),
      ]);
      expect(
        new Set(assignments.map((assignment) => assignment.taskId)).size,
      ).toBe(1);
      const stored = await env.DB.prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM task_instances
            WHERE event_id = ? AND template_id = ? AND target_id = ?) AS taskCount,
          (SELECT COUNT(*) FROM audit_events
            WHERE event_id = ? AND action = 'task.assigned'
              AND json_extract(metadata_json, '$.templateId') = ?) AS auditCount
      `,
      )
        .bind(
          speaker.eventId,
          templateId,
          speaker.personId,
          speaker.eventId,
          templateId,
        )
        .first<{ taskCount: number; auditCount: number }>();
      expect(stored).toEqual({ taskCount: 1, auditCount: 1 });
    });

    it("propagates an unrelated assignment batch failure when a concurrent task exists", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const templateId = await new TaskService(testEnv).createTemplate(admin, {
        name: `Unrelated batch failure ${crypto.randomUUID()}`,
        description: "Do not recover an unrelated database failure.",
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
      const injectedFailure = new Error(
        "Injected unrelated task assignment database failure.",
      );
      const racingEnv = withBatchRace(testEnv, async () => {
        await new TaskService(testEnv).assignTemplate(
          admin,
          templateId,
          speaker.personId,
        );
        throw injectedFailure;
      });

      await expect(
        new TaskService(racingEnv).assignTemplate(
          admin,
          templateId,
          speaker.personId,
        ),
      ).rejects.toBe(injectedFailure);
    });

    it("replays an exact assignment intent without duplicating its webhook delivery", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const suffix = crypto.randomUUID();
      const endpointId = `task-intent-webhook-${suffix}`;
      await testEnv.DB.prepare(
        `INSERT INTO webhook_endpoints (
           id, organisation_id, event_id, name, url, secret_ciphertext,
           event_types_json, status, created_by_person_id
         ) VALUES (?, ?, ?, 'Task intent events',
                   'https://hooks.example.com/task-intent', 'test-only',
                   '["task.created"]', 'active', ?)`,
      )
        .bind(endpointId, admin.organisationId, admin.eventId, admin.personId)
        .run();
      const queueEnv = {
        ...testEnv,
        OPERATIONS_QUEUE: {
          send: async () => undefined,
        },
      } as unknown as CloudflareEnvironment;
      const service = new TaskService(queueEnv);
      const templateId = await service.createTemplate(admin, {
        name: `Exact intent webhook ${suffix}`,
        description: "Create one durable delivery across an exact retry.",
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
      const intentId = crypto.randomUUID();

      const first = await service.assignTemplate(
        admin,
        templateId,
        speaker.personId,
        intentId,
      );
      await expect(
        service.assignTemplate(admin, templateId, speaker.personId, intentId),
      ).resolves.toEqual(first);
      await expect(
        testEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM webhook_deliveries delivery
               WHERE delivery.endpoint_id = ?
                 AND delivery.event_type = 'task.created'
                 AND delivery.entity_id = ?) AS deliveryCount,
             (SELECT COUNT(*) FROM operation_jobs operation
               JOIN operation_items item ON item.operation_id = operation.id
              WHERE operation.event_id = ?
                AND operation.type = 'webhook.deliver'
                AND item.entity_type = 'webhook_delivery'
                AND item.entity_id IN (
                  SELECT id FROM webhook_deliveries WHERE endpoint_id = ?
                )) AS operationCount`,
        )
          .bind(endpointId, first.taskId, admin.eventId, endpointId)
          .first(),
      ).resolves.toEqual({ deliveryCount: 1, operationCount: 1 });
      await testEnv.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?")
        .bind(endpointId)
        .run();
    });

    it("keeps a distinct assignment intent as a no-op while the original intent resumes only persisted webhooks", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const suffix = crypto.randomUUID();
      const endpointId = `task-intent-recovery-webhook-${suffix}`;
      const lateEndpointId = `task-intent-late-webhook-${suffix}`;
      const service = new TaskService(testEnv);
      const templateId = await service.createTemplate(admin, {
        name: `Assignment intent recovery ${suffix}`,
        description: "Recover only the side effects of the creating intent.",
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
      await testEnv.DB.prepare(
        `INSERT INTO webhook_endpoints (
           id, organisation_id, event_id, name, url, secret_ciphertext,
           event_types_json, status, created_by_person_id
         ) VALUES (?, ?, ?, 'Task intent recovery events',
                   'https://hooks.example.com/task-intent-recovery', 'test-only',
                   '["task.created"]', 'active', ?)`,
      )
        .bind(endpointId, admin.organisationId, admin.eventId, admin.personId)
        .run();

      const originalIntentId = crypto.randomUUID();
      const injectedFailure = new Error(
        "Injected failure after the assignment batch committed.",
      );
      let failAfterCommit = true;
      const interruptedDb = new Proxy(testEnv.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              const results = await target.batch(statements);
              if (failAfterCommit) {
                failAfterCommit = false;
                throw injectedFailure;
              }
              return results;
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const queuedOperationIds: string[] = [];
      const queueEnv = {
        ...testEnv,
        OPERATIONS_QUEUE: {
          send: async (message: { operationId: string }) => {
            queuedOperationIds.push(message.operationId);
          },
        },
      } as unknown as CloudflareEnvironment;
      const interruptedEnv = new Proxy(queueEnv, {
        get(target, property) {
          return property === "DB"
            ? interruptedDb
            : Reflect.get(target, property);
        },
      });

      await expect(
        new TaskService(interruptedEnv).assignTemplate(
          admin,
          templateId,
          speaker.personId,
          originalIntentId,
        ),
      ).rejects.toBe(injectedFailure);
      const persistedTask = await testEnv.DB.prepare(
        `SELECT id FROM task_instances
          WHERE event_id = ? AND template_id = ?
            AND target_type = 'speaker' AND target_id = ?`,
      )
        .bind(admin.eventId, templateId, speaker.personId)
        .first<{ id: string }>();
      expect(persistedTask).not.toBeNull();
      expect(queuedOperationIds).toEqual([]);

      await testEnv.DB.prepare(
        `INSERT INTO webhook_endpoints (
           id, organisation_id, event_id, name, url, secret_ciphertext,
           event_types_json, status, created_by_person_id
         ) VALUES (?, ?, ?, 'Late task intent events',
                   'https://hooks.example.com/task-intent-late', 'test-only',
                   '["task.created"]', 'active', ?)`,
      )
        .bind(
          lateEndpointId,
          admin.organisationId,
          admin.eventId,
          admin.personId,
        )
        .run();

      await expect(
        service.assignTemplate(
          admin,
          templateId,
          speaker.personId,
          crypto.randomUUID(),
        ),
      ).resolves.toEqual({
        taskId: persistedTask!.id,
        webhookWarning: null,
      });
      expect(queuedOperationIds).toEqual([]);

      const recoveryService = new TaskService(queueEnv);
      await expect(
        recoveryService.assignTemplate(
          admin,
          templateId,
          speaker.personId,
          originalIntentId,
        ),
      ).resolves.toEqual({
        taskId: persistedTask!.id,
        webhookWarning: null,
      });
      await expect(
        recoveryService.assignTemplate(
          admin,
          templateId,
          speaker.personId,
          originalIntentId,
        ),
      ).resolves.toEqual({
        taskId: persistedTask!.id,
        webhookWarning: null,
      });
      expect(queuedOperationIds).toHaveLength(1);
      await expect(
        testEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM task_instances task
               WHERE task.event_id = ? AND task.template_id = ?
                 AND task.target_type = 'speaker' AND task.target_id = ?) AS taskCount,
             (SELECT COUNT(*) FROM audit_events audit
               WHERE audit.event_id = ? AND audit.action = 'task.assigned'
                 AND audit.entity_id = ?) AS auditCount,
             (SELECT COUNT(*) FROM webhook_deliveries delivery
               WHERE delivery.endpoint_id = ?
                 AND delivery.event_type = 'task.created'
                 AND delivery.entity_id = ?) AS persistedDeliveryCount,
             (SELECT COUNT(*) FROM webhook_deliveries delivery
               WHERE delivery.endpoint_id = ?
                 AND delivery.event_type = 'task.created'
                 AND delivery.entity_id = ?) AS lateDeliveryCount,
             (SELECT COUNT(*) FROM operation_jobs operation
               JOIN operation_items item ON item.operation_id = operation.id
              WHERE operation.event_id = ?
                AND operation.type = 'webhook.deliver'
                AND operation.dispatched_at IS NOT NULL
                AND item.entity_type = 'webhook_delivery'
                AND item.entity_id IN (
                  SELECT id FROM webhook_deliveries WHERE endpoint_id = ?
                )) AS dispatchedOperationCount`,
        )
          .bind(
            admin.eventId,
            templateId,
            speaker.personId,
            admin.eventId,
            persistedTask!.id,
            endpointId,
            persistedTask!.id,
            lateEndpointId,
            persistedTask!.id,
            admin.eventId,
            endpointId,
          )
          .first(),
      ).resolves.toEqual({
        taskCount: 1,
        auditCount: 1,
        persistedDeliveryCount: 1,
        lateDeliveryCount: 0,
        dispatchedOperationCount: 1,
      });
      await testEnv.DB.prepare(
        "DELETE FROM webhook_endpoints WHERE id IN (?, ?)",
      )
        .bind(endpointId, lateEndpointId)
        .run();
    });
  });
});
