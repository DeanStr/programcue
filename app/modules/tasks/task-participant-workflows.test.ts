import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  acceptTestFileScanDispatch,
  completeTestDirectUpload,
} from "~/modules/files/direct-upload.test-helper";
import { FileService } from "~/modules/files/file-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { SpeakerService } from "~/modules/speakers/speaker-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { TaskService } from "./task-service.server";
import {
  taskDestinationUrl,
  taskResourcePageId,
} from "./task-service-foundation.server";

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
const submitter: Viewer = {
  personId: "person-demo-submitter",
  name: "Alex Morgan",
  email: "alex.submitter@example.com",
  role: "submitter",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function createSessionCoSpeaker(testEnv: CloudflareEnvironment) {
  const suffix = crypto.randomUUID();
  const personId = `person-session-co-speaker-${suffix}`;
  const position = await testEnv.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS value
       FROM session_speakers
      WHERE event_id = ? AND session_id = 'session-demo-speaker'`,
  )
    .bind(admin.eventId)
    .first<{ value: number }>();
  if (!position || !Number.isSafeInteger(position.value))
    throw new Error("Could not resolve the next session-speaker position.");
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, created_at, updated_at
       ) VALUES (?, ?, 'Session co-speaker', 1, unixepoch(), unixepoch())`,
    ).bind(personId, `${personId}@example.test`),
    testEnv.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role, accepted_at, created_at
       ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch())`,
    ).bind(
      `membership-session-co-speaker-${suffix}`,
      admin.organisationId,
      admin.eventId,
      personId,
    ),
    testEnv.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES ('session-demo-speaker', ?, ?, ?, 'Co-speaker',
                 'confirmed', unixepoch(), 'public')`,
    ).bind(admin.eventId, personId, position.value),
  ]);
  return {
    personId,
    name: "Session co-speaker",
    email: `${personId}@example.test`,
    role: "speaker",
    organisationId: admin.organisationId,
    eventId: admin.eventId,
    demo: true,
  } satisfies Viewer;
}

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
    configuration: {
      fileScope: "participant_document",
      fileKind: "supporting_document",
    },
  });
  return (await tasks.assignTemplate(admin, templateId, speaker.personId))
    .taskId;
}

async function createSessionFileTask(
  testEnv: CloudflareEnvironment,
  name: string,
) {
  const tasks = new TaskService(testEnv);
  const templateId = await tasks.createTemplate(admin, {
    name,
    description: "Upload shared session evidence.",
    targetType: "session",
    taskType: "file_upload",
    impact: "high",
    evidenceMode: "file",
    dueAnchor: "none",
    dueOffsetDays: null,
    fixedDueDate: null,
    autoAssignOnAcceptance: false,
    dependencyIds: [],
    configuration: { fileScope: "session_deliverable", fileKind: "slides" },
  });
  return (await tasks.assignTemplate(admin, templateId, "session-demo-speaker"))
    .taskId;
}

function testPdfFile(name: string, marker = 0) {
  return new File(
    [new TextEncoder().encode(`%PDF-1.7\nTask evidence ${marker}`)],
    name,
    { type: "application/pdf" },
  );
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
    ...(dependent.taskType === "file_upload"
      ? {
          configuration: {
            fileScope: "participant_document" as const,
            fileKind: "supporting_document" as const,
          },
        }
      : {}),
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
  describe("participant workflows", () => {
    it("prevents submitters from commenting on another participant's task", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createChecklistTask(
        testEnv,
        `Submitter comment boundary ${crypto.randomUUID()}`,
      );
      const service = new TaskService(testEnv);

      await expect(
        service.addComment(
          submitter,
          taskId,
          "This task belongs to another participant.",
          "participant",
          `comment-intent:${crypto.randomUUID()}`,
        ),
      ).rejects.toThrow("not accessible to this participant");
      await expect(
        testEnv.DB.prepare(
          "SELECT COUNT(*) AS count FROM task_comments WHERE task_id = ? AND author_person_id = ?",
        )
          .bind(taskId, submitter.personId)
          .first(),
      ).resolves.toEqual({ count: 0 });
    });

    it("stores one comment for an exact browser-intent retry and rejects changed content", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createChecklistTask(
        testEnv,
        `Idempotent comment ${crypto.randomUUID()}`,
      );
      const service = new TaskService(testEnv);
      const intentId = `comment-intent:${crypto.randomUUID()}`;

      await service.addComment(
        speaker,
        taskId,
        "Please review this evidence.",
        "participant",
        intentId,
      );
      await service.addComment(
        speaker,
        taskId,
        "Please review this evidence.",
        "participant",
        intentId,
      );
      await expect(
        service.addComment(
          speaker,
          taskId,
          "This is different content.",
          "participant",
          intentId,
        ),
      ).rejects.toThrow("already used with different content");

      await expect(
        testEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM task_comments
               WHERE task_id = ? AND author_person_id = ?) AS comments,
             (SELECT COUNT(*) FROM audit_events
               WHERE event_id = ? AND entity_id = ?
                 AND action = 'task.comment.added') AS audits`,
        )
          .bind(taskId, speaker.personId, speaker.eventId, taskId)
          .first(),
      ).resolves.toEqual({ comments: 1, audits: 1 });
    });

    it("labels session-scoped deliverables with their session title", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const templateId = await service.createTemplate(admin, {
        name: "Upload session handout",
        description: "Provide the handout for this session.",
        targetType: "session",
        taskType: "file_upload",
        impact: "high",
        evidenceMode: "file",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [],
        configuration: {
          fileScope: "session_deliverable",
          fileKind: "supporting_document",
        },
      });
      const { taskId } = await service.assignTemplate(
        admin,
        templateId,
        "session-demo-speaker",
      );

      const tasks = await service.listParticipantTasks(speaker);
      expect(tasks.find((task) => task.id === taskId)).toMatchObject({
        targetType: "session",
        targetLabel: "Designing inclusive event technology",
      });
    });

    it("binds the built-in session-details acknowledgement to the displayed session revision", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const coSpeaker = await createSessionCoSpeaker(testEnv);
      const service = new TaskService(testEnv);
      const original = await testEnv.DB.prepare(
        `SELECT title, revision FROM sessions
          WHERE id = 'session-demo-speaker' AND event_id = ?`,
      )
        .bind(speaker.eventId)
        .first<{ title: string; revision: number }>();
      if (!original) throw new Error("Demo session is missing.");
      await testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'pending', participation_revision = 1,
                participation_confirmed_at = NULL,
                participation_declined_at = NULL,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = 'session-demo-speaker'
            AND person_id = ?`,
      )
        .bind(speaker.eventId, speaker.personId)
        .run();

      try {
        const clonedPresetTemplateId = crypto.randomUUID();
        await testEnv.DB.prepare(
          `INSERT INTO task_templates (
             id, event_id, name, description, target_type, task_type, impact,
             evidence_mode, due_anchor, due_offset_minutes, fixed_due_at,
             auto_assign_on_acceptance, configuration_json, status
           ) VALUES (?, ?, 'Review session details',
                     'Review the shared session title, description, format, duration and track. Any active session participant may confirm them for the session or leave a correction comment.',
                     'session', 'acknowledgement', 'high', 'checkbox', 'none',
                     NULL, NULL, 1,
                     '{"preset":"session_details_review_v1"}', 'active')`,
        )
          .bind(clonedPresetTemplateId, admin.eventId)
          .run();
        const preset = await service.createSessionDetailsReviewTemplate(
          admin,
          true,
        );
        expect(preset).toEqual({
          templateId: clonedPresetTemplateId,
          created: false,
        });
        const { taskId } = await service.assignTemplate(
          admin,
          preset.templateId,
          "session-demo-speaker",
        );
        await expect(
          service.createTemplate(admin, {
            name: `Duplicate session review ${crypto.randomUUID()}`,
            description:
              "A duplicate preset must fail instead of becoming a second correction route.",
            targetType: "session",
            taskType: "acknowledgement",
            impact: "high",
            evidenceMode: "checkbox",
            dueAnchor: "none",
            dueOffsetDays: null,
            fixedDueDate: null,
            autoAssignOnAcceptance: true,
            dependencyIds: [],
            configuration: { preset: "session_details_review_v1" },
          }),
        ).rejects.toThrow("already contains a session-details review preset");
        const portalSession = (
          await new SpeakerService(testEnv).getPortal(speaker)
        ).sessions.find((session) => session.id === "session-demo-speaker");
        expect(portalSession?.sessionDetailsReviewTaskId).toBe(taskId);
        const displayed = (await service.listParticipantTasks(speaker)).find(
          (task) => task.id === taskId,
        );
        expect(displayed?.sessionDetailsReview).toMatchObject({
          sessionRevision: original.revision,
          fields: {
            title: original.title,
            format: "presentation",
            durationMinutes: 45,
          },
        });
        if (!displayed?.sessionDetailsReview)
          throw new Error("Session review details were not loaded.");
        const coSpeakerDisplay = (
          await service.listParticipantTasks(coSpeaker)
        ).find((task) => task.id === taskId);
        expect(coSpeakerDisplay?.sessionDetailsReview).toEqual(
          displayed.sessionDetailsReview,
        );
        expect(displayed.sessionDetailsReview.fields).not.toHaveProperty(
          "roleLabel",
        );

        await expect(
          new TaskService(
            withBatchRace(testEnv, async () => {
              await testEnv.DB.prepare(
                `UPDATE sessions
                    SET title = 'Changed after participant loaded the task',
                        revision = revision + 1,
                        updated_at = unixepoch()
                  WHERE id = 'session-demo-speaker' AND event_id = ?`,
              )
                .bind(speaker.eventId)
                .run();
            }),
          ).completeParticipant(speaker, {
            taskId,
            revision: displayed.revision,
            confirmed: true,
            sessionDetailsRevision:
              displayed.sessionDetailsReview.sessionRevision,
            sessionDetailsFingerprint:
              displayed.sessionDetailsReview.fingerprint,
          }),
        ).rejects.toThrow(/changed after this page loaded/i);

        const current = (await service.listParticipantTasks(speaker)).find(
          (task) => task.id === taskId,
        );
        if (!current?.sessionDetailsReview)
          throw new Error("Current session review details were not loaded.");
        await service.completeParticipant(speaker, {
          taskId,
          revision: current.revision,
          confirmed: true,
          sessionDetailsRevision: current.sessionDetailsReview.sessionRevision,
          sessionDetailsFingerprint: current.sessionDetailsReview.fingerprint,
        });
        const completed = (await service.listParticipantTasks(speaker)).find(
          (task) => task.id === taskId,
        );
        expect(completed?.reviewedSessionDetails).toMatchObject({
          sessionRevision: original.revision + 1,
          fields: { title: "Changed after participant loaded the task" },
          reviewedAt: expect.any(Number),
        });
        expect(
          (await service.listParticipantTasks(coSpeaker)).find(
            (task) => task.id === taskId,
          ),
        ).toMatchObject({
          status: "completed",
          reviewedSessionDetails: completed?.reviewedSessionDetails,
        });
        if (!completed?.evidenceJson)
          throw new Error("Completed session review evidence is missing.");
        try {
          await testEnv.DB.prepare(
            `UPDATE task_instances SET evidence_json = '{"confirmed":true}'
              WHERE id = ? AND event_id = ?`,
          )
            .bind(taskId, speaker.eventId)
            .run();
          await expect(service.listParticipantTasks(speaker)).rejects.toThrow(
            /missing its canonical review evidence/i,
          );
        } finally {
          await testEnv.DB.prepare(
            `UPDATE task_instances SET evidence_json = ?
              WHERE id = ? AND event_id = ?`,
          )
            .bind(completed.evidenceJson, taskId, speaker.eventId)
            .run();
        }
      } finally {
        await testEnv.DB.prepare(
          `UPDATE sessions SET title = ?, revision = revision + 1,
                  updated_at = unixepoch()
            WHERE id = 'session-demo-speaker' AND event_id = ?`,
        )
          .bind(original.title, speaker.eventId)
          .run();
      }

      const duplicateTemplateId = crypto.randomUUID();
      await testEnv.DB.prepare(
        `INSERT INTO task_templates (
           id, event_id, name, target_type, task_type, impact, evidence_mode,
           due_anchor, auto_assign_on_acceptance, configuration_json, status
         ) VALUES (?, ?, 'Duplicate session review', 'session',
                   'acknowledgement', 'high', 'checkbox', 'none', 1,
                   '{"preset":"session_details_review_v1"}', 'active')`,
      )
        .bind(duplicateTemplateId, speaker.eventId)
        .run();
      try {
        await expect(service.listParticipantTasks(speaker)).rejects.toThrow(
          /differs from the required shared acknowledgement/i,
        );
        await expect(
          new SpeakerService(testEnv).getPortal(speaker),
        ).rejects.toThrow(/differs from the required shared acknowledgement/i);
      } finally {
        await testEnv.DB.prepare("DELETE FROM task_templates WHERE id = ?")
          .bind(duplicateTemplateId)
          .run();
      }
    });

    it("rejects unsupported evidence combinations and persists an explicit supported scope", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const base = {
        name: "Unsupported task configuration",
        description: "Must not be persisted.",
        targetType: "speaker",
        taskType: "checklist",
        impact: "high",
        evidenceMode: "checkbox",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [],
      } as const;

      await expect(
        service.createTemplate(admin, { ...base, evidenceMode: "file" }),
      ).rejects.toBeInstanceOf(ZodError);
      await expect(
        service.createTemplate(admin, {
          ...base,
          configuration: { preset: "session_details_review_v1" },
        }),
      ).rejects.toThrow(
        /session-details review preset must use the fixed high-impact/i,
      );
      await expect(
        service.createTemplate(admin, { ...base, targetType: "session" }),
      ).resolves.toEqual(expect.any(String));

      const persisted = await testEnv.DB.prepare(
        `SELECT target_type AS targetType,
                auto_assign_on_acceptance AS autoAssignOnAcceptance
           FROM task_templates WHERE event_id = ? AND name = ?`,
      )
        .bind(admin.eventId, base.name)
        .first();
      expect(persisted).toEqual({
        targetType: "session",
        autoAssignOnAcceptance: 0,
      });

      const withoutPolicy = Object.fromEntries(
        Object.entries(base).filter(
          ([key]) => key !== "autoAssignOnAcceptance",
        ),
      );
      await expect(
        service.createTemplate(admin, withoutPolicy),
      ).rejects.toBeInstanceOf(ZodError);
      await expect(
        service.createTemplate(admin, {
          ...base,
          name: "Invalid automatic session-start task",
          dueAnchor: "session_start",
          dueOffsetDays: -7,
          autoAssignOnAcceptance: true,
        }),
      ).rejects.toBeInstanceOf(ZodError);
    });
  });

  describe("participant workflows", () => {
    it("fails explicitly when an assigned session-review task has drifted", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const preset = await service.createSessionDetailsReviewTemplate(
        admin,
        true,
      );
      const { taskId } = await service.assignTemplate(
        admin,
        preset.templateId,
        "session-demo-speaker",
      );
      await testEnv.DB.prepare(
        `UPDATE task_instances SET impact = 'low', updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      )
        .bind(taskId, speaker.eventId)
        .run();

      try {
        await expect(service.listParticipantTasks(speaker)).rejects.toThrow(
          /differs from the required shared acknowledgement/i,
        );
        await expect(
          new SpeakerService(testEnv).getPortal(speaker),
        ).rejects.toThrow(/differs from the required shared acknowledgement/i);
        await expect(
          service.addComment(
            speaker,
            taskId,
            "This must not use a drifted correction workflow.",
            "participant",
            `drifted-session-review:${crypto.randomUUID()}`,
          ),
        ).rejects.toThrow(/differs from the required shared acknowledgement/i);
      } finally {
        await testEnv.DB.prepare(
          `UPDATE task_instances SET impact = 'high', updated_at = unixepoch()
            WHERE id = ? AND event_id = ?`,
        )
          .bind(taskId, speaker.eventId)
          .run();
      }
    });

    it("makes an inactive session-details review unavailable without hiding unrelated session tasks", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const originalSession = await testEnv.DB.prepare(
        `SELECT status FROM sessions
          WHERE id = 'session-demo-speaker' AND event_id = ?`,
      )
        .bind(speaker.eventId)
        .first<{ status: string }>();
      if (!originalSession) throw new Error("Demo session is missing.");
      const preset = await service.createSessionDetailsReviewTemplate(
        admin,
        true,
      );
      const reviewTaskId = (
        await service.assignTemplate(
          admin,
          preset.templateId,
          "session-demo-speaker",
        )
      ).taskId;
      const checklistTaskId = crypto.randomUUID();
      await testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, description,
           task_type, impact, evidence_mode, configuration_json, status,
           readiness_state, readiness_percent, revision, created_at, updated_at
         ) VALUES (?, ?, 'session', 'session-demo-speaker',
                   'Cancelled-session operational checklist',
                   'An unrelated session task retains its existing contract.',
                   'checklist', 'low', 'checkbox', '{}', 'not_started',
                   'on_track', 0, 1, unixepoch(), unixepoch())`,
      )
        .bind(checklistTaskId, speaker.eventId)
        .run();
      const review = (await service.listParticipantTasks(speaker)).find(
        (task) => task.id === reviewTaskId,
      );
      if (!review?.sessionDetailsReview)
        throw new Error("Session review details were not loaded.");

      try {
        await testEnv.DB.prepare(
          `UPDATE sessions SET status = 'cancelled', updated_at = unixepoch()
            WHERE id = 'session-demo-speaker' AND event_id = ?`,
        )
          .bind(speaker.eventId)
          .run();

        const participantTaskIds = (
          await service.listParticipantTasks(speaker)
        ).map((task) => task.id);
        expect(participantTaskIds).not.toContain(reviewTaskId);
        expect(participantTaskIds).toContain(checklistTaskId);
        expect(
          (await new SpeakerService(testEnv).getPortal(speaker)).sessions.find(
            (session) => session.id === "session-demo-speaker",
          )?.sessionDetailsReviewTaskId,
        ).toBeNull();
        expect(
          (await service.getAdminWorkspace(admin)).tasks.find(
            (task) => task.id === reviewTaskId,
          )?.participantActionable,
        ).toBe(false);
        await expect(
          service.completeParticipant(speaker, {
            taskId: reviewTaskId,
            revision: review.revision,
            confirmed: true,
            sessionDetailsRevision: review.sessionDetailsReview.sessionRevision,
            sessionDetailsFingerprint: review.sessionDetailsReview.fingerprint,
          }),
        ).rejects.toThrow("not owned by this speaker");
        await expect(
          service.addComment(
            speaker,
            reviewTaskId,
            "This cancelled session must not accept another correction.",
            "participant",
            `cancelled-session-comment:${crypto.randomUUID()}`,
          ),
        ).rejects.toThrow("not accessible to this participant");
      } finally {
        await testEnv.DB.prepare(
          `UPDATE sessions SET status = ?, updated_at = unixepoch()
            WHERE id = 'session-demo-speaker' AND event_id = ?`,
        )
          .bind(originalSession.status, speaker.eventId)
          .run();
      }
    });

    it("rejects ineligible task uploads before any file storage begins", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createChecklistTask(
        testEnv,
        "Non-file upload preflight",
      );

      await expect(
        new TaskService(testEnv).assertFileEvidenceUploadAllowed(
          speaker,
          taskId,
        ),
      ).rejects.toThrow("File task not found");
    });

    it("uses the assigned link destination and records explicit acknowledgement", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const templateId = await service.createTemplate(admin, {
        name: "Visit the event information page",
        description: "Record the page used to confirm the event details.",
        targetType: "speaker",
        taskType: "link_visit",
        impact: "medium",
        evidenceMode: "link",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [],
        configuration: {
          destinationUrl: "https://example.test/event-information",
        },
      });
      const { taskId } = await service.assignTemplate(
        admin,
        templateId,
        speaker.personId,
      );

      await testEnv.DB.prepare(
        `UPDATE task_templates
            SET configuration_json = '{"destinationUrl":"https://example.test/changed"}'
          WHERE id = ? AND event_id = ?`,
      )
        .bind(templateId, admin.eventId)
        .run();
      const assigned = (await service.listParticipantTasks(speaker)).find(
        (task) => task.id === taskId,
      );
      expect(assigned?.destinationUrl).toBe(
        "https://example.test/event-information",
      );

      await expect(
        service.completeParticipant(speaker, {
          taskId,
          revision: 1,
        }),
      ).rejects.toThrow(/Confirm that you visited/);
      await service.completeParticipant(speaker, {
        taskId,
        revision: 1,
        confirmed: true,
      });

      const task = await testEnv.DB.prepare(
        `SELECT status, evidence_mode AS evidenceMode,
                configuration_json AS configurationJson,
                evidence_json AS evidenceJson, revision
           FROM task_instances WHERE id = ?`,
      )
        .bind(taskId)
        .first<{
          status: string;
          evidenceMode: string;
          configurationJson: string;
          evidenceJson: string | null;
          revision: number;
        }>();
      expect(task).toMatchObject({
        status: "completed",
        evidenceMode: "link",
        configurationJson: JSON.stringify({
          destinationUrl: "https://example.test/event-information",
        }),
        revision: 2,
      });
      expect(JSON.parse(task?.evidenceJson ?? "{}")).toMatchObject({
        confirmed: true,
        destinationUrl: "https://example.test/event-information",
        acknowledgedAt: expect.any(Number),
      });
      await testEnv.DB.prepare(
        `UPDATE task_evidence
            SET evidence_json = '{"url":"https://legacy.example.test/participant-entry"}'
          WHERE task_id = ? AND event_id = ?`,
      )
        .bind(taskId, admin.eventId)
        .run();
      const historicalEvidence = (
        await service.getAdminWorkspace(admin)
      ).tasks.find((candidate) => candidate.id === taskId)?.evidence[0]
        ?.details;
      expect(historicalEvidence).toMatchObject({
        url: "https://legacy.example.test/participant-entry",
      });
      expect(() => taskDestinationUrl("{}")).toThrow(
        "This link task has no destination",
      );
    });

    it("returns resource page ids on acknowledgement tasks", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      expect(taskResourcePageId("{}")).toBeNull();
      expect(
        taskResourcePageId('{"resourcePageId":"resource-speaker-handbook"}'),
      ).toBe("resource-speaker-handbook");
      const handbook = (
        await new TaskService(testEnv).listParticipantTasks(speaker)
      ).find((task) => task.id === "task-demo-handbook");
      if (!handbook) throw new Error("Demo handbook task is missing.");
      expect(handbook).toMatchObject({
        taskType: "acknowledgement",
        resourcePageId: "resource-speaker-handbook",
        resourceHref: "/participant/resources?resource=speaker-handbook",
      });
      await expect(
        new TaskService(testEnv).completeParticipant(speaker, {
          taskId: handbook.id,
          revision: handbook.revision,
          confirmed: true,
        }),
      ).rejects.toThrow(
        "Open and acknowledge the published resource to complete this task.",
      );
    });
  });

  describe("participant workflows", () => {
    it("loads participant dependencies and comments for more than 100 tasks", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const prefix = `large-participant-${crypto.randomUUID()}`;
      const taskIds = Array.from(
        { length: 105 },
        (_, index) => `${prefix}-task-${index}`,
      );
      await testEnv.DB.prepare(
        `
        INSERT INTO task_instances (
          id, event_id, target_type, target_id, owner_person_id, title,
          task_type, impact, status, readiness_state, readiness_percent,
          revision, created_at, updated_at
        )
        SELECT CAST(value AS TEXT), ?, 'speaker', ?, ?,
               'Large participant task ' || key, 'checklist', 'medium',
               'not_started', 'on_track', 0, 1, unixepoch(), unixepoch()
          FROM json_each(?)
      `,
      )
        .bind(
          speaker.eventId,
          speaker.personId,
          speaker.personId,
          JSON.stringify(taskIds),
        )
        .run();
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO task_instance_dependencies (
             task_id, depends_on_task_id, created_at
           ) VALUES (?, ?, unixepoch())`,
        ).bind(taskIds[0], taskIds[1]),
        testEnv.DB.prepare(
          `INSERT INTO task_comments (
             id, event_id, task_id, author_person_id, visibility, body, created_at
           ) VALUES (?, ?, ?, ?, 'participant', 'Large-list comment', unixepoch())`,
        ).bind(
          `${prefix}-comment`,
          speaker.eventId,
          taskIds[0],
          admin.personId,
        ),
      ]);

      const tasks = await new TaskService(testEnv).listParticipantTasks(
        speaker,
      );
      const largeTasks = tasks.filter((task) => task.id.startsWith(prefix));
      expect(largeTasks).toHaveLength(105);
      expect(largeTasks.find((task) => task.id === taskIds[0])).toMatchObject({
        dependencies: [
          expect.objectContaining({ id: taskIds[1], status: "not_started" }),
        ],
        comments: [expect.objectContaining({ body: "Large-list comment" })],
      });
    });

    it("does not expose prerequisite metadata from an inaccessible resource task", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const suffix = crypto.randomUUID();
      const resourcePageId = `inaccessible-prerequisite-resource-${suffix}`;
      const templateId = `resource-ack:${resourcePageId}`;
      const prerequisiteId = `${templateId}:${speaker.personId}`;
      const dependentId = `accessible-dependent-${suffix}`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO task_templates (
             id, event_id, name, target_type, task_type, impact, evidence_mode,
             due_anchor, auto_assign_on_acceptance, configuration_json, status,
             created_at, updated_at
           ) VALUES (?, ?, 'Private prerequisite resource', 'speaker',
                     'acknowledgement', 'medium', 'checkbox', 'none', 0, ?,
                     'active', unixepoch(), unixepoch())`,
        ).bind(templateId, speaker.eventId, JSON.stringify({ resourcePageId })),
        testEnv.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, template_id, target_type, target_id,
             owner_person_id, title, task_type, impact, evidence_mode,
             configuration_json, status, readiness_state, readiness_percent,
             revision, created_at, updated_at
           ) VALUES (?, ?, ?, 'speaker', ?, ?, 'Secret prerequisite title',
                     'acknowledgement', 'medium', 'checkbox', ?, 'not_started',
                     'on_track', 0, 1, unixepoch(), unixepoch())`,
        ).bind(
          prerequisiteId,
          speaker.eventId,
          templateId,
          speaker.personId,
          speaker.personId,
          JSON.stringify({ resourcePageId }),
        ),
        testEnv.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, owner_person_id, title,
             task_type, impact, status, readiness_state, readiness_percent,
             revision, created_at, updated_at
           ) VALUES (?, ?, 'speaker', ?, ?, 'Accessible dependent task',
                     'checklist', 'medium', 'not_started', 'on_track', 0, 1,
                     unixepoch(), unixepoch())`,
        ).bind(
          dependentId,
          speaker.eventId,
          speaker.personId,
          speaker.personId,
        ),
        testEnv.DB.prepare(
          `INSERT INTO task_instance_dependencies (
             task_id, depends_on_task_id, created_at
           ) VALUES (?, ?, unixepoch())`,
        ).bind(dependentId, prerequisiteId),
      ]);

      const tasks = await new TaskService(testEnv).listParticipantTasks(
        speaker,
      );
      expect(tasks.map((task) => task.id)).not.toContain(prerequisiteId);
      expect(tasks.find((task) => task.id === dependentId)).toMatchObject({
        status: "blocked",
        readinessState: "blocked",
        readinessPercent: 0,
        dependencies: [
          {
            id: `restricted-prerequisite:${dependentId}`,
            title: "a prerequisite managed by the event team",
            status: "blocked",
          },
        ],
      });
      expect(JSON.stringify(tasks)).not.toContain("Secret prerequisite title");

      await testEnv.DB.prepare(
        `UPDATE task_instances
            SET status = 'completed', readiness_state = 'on_track',
                readiness_percent = 100, completed_at = unixepoch(),
                revision = revision + 1, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      )
        .bind(prerequisiteId, speaker.eventId)
        .run();
      const afterHiddenCompletion = await new TaskService(
        testEnv,
      ).listParticipantTasks(speaker);
      expect(
        afterHiddenCompletion.find((task) => task.id === dependentId),
      ).toMatchObject({ status: "blocked", readinessState: "blocked" });
      await expect(
        new TaskService(testEnv).completeParticipant(speaker, {
          taskId: dependentId,
          revision: 1,
          confirmed: true,
        }),
      ).rejects.toThrow("Complete the prerequisite tasks first.");
    });
  });

  describe("participant workflows", () => {
    it("issues a one-use five-minute token and safely undoes participant completion", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const taskId = await createChecklistTask(
        testEnv,
        `Undo participant completion ${crypto.randomUUID()}`,
      );

      const completion = await service.completeParticipant(speaker, {
        taskId,
        revision: 1,
        confirmed: true,
      });
      expect(completion.undoToken).toMatch(/^[^.]+\.[A-Za-z0-9_-]{43}$/);
      expect(completion.undoExpiresAt).toBeGreaterThan(
        Math.floor(Date.now() / 1_000),
      );

      await service.undoCompletion(speaker, completion.undoToken);
      const task = await testEnv.DB.prepare(
        `SELECT status, readiness_percent AS readinessPercent, evidence_json AS evidenceJson,
                completed_at AS completedAt, revision
           FROM task_instances WHERE id = ? AND event_id = ?`,
      )
        .bind(taskId, speaker.eventId)
        .first<{
          status: string;
          readinessPercent: number;
          evidenceJson: string | null;
          completedAt: number | null;
          revision: number;
        }>();
      expect(task).toEqual({
        status: "not_started",
        readinessPercent: 0,
        evidenceJson: null,
        completedAt: null,
        revision: 3,
      });
      expect(
        await testEnv.DB.prepare(
          "SELECT status FROM task_evidence WHERE task_id = ?",
        )
          .bind(taskId)
          .first(),
      ).toEqual({ status: "superseded" });
      const audit = await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND entity_id = ? AND action = 'task.completion_undone'`,
      )
        .bind(speaker.eventId, taskId)
        .first<{ count: number }>();
      expect(audit?.count).toBe(1);
      await expect(
        service.undoCompletion(speaker, completion.undoToken),
      ).rejects.toThrow("already undone");
    });

    it("binds completion undo to its actor and rejects later evidence", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const taskId = await createChecklistTask(
        testEnv,
        `Scoped participant undo ${crypto.randomUUID()}`,
      );
      const completion = await service.completeParticipant(speaker, {
        taskId,
        revision: 1,
        confirmed: true,
      });
      expect(completion.undoToken).toBeTruthy();
      await expect(
        service.undoCompletion(admin, completion.undoToken),
      ).rejects.toThrow("invalid");
      await testEnv.DB.prepare(
        `INSERT INTO task_evidence (
           id, event_id, task_id, submitted_by_person_id, evidence_json, status, created_at
         ) VALUES (?, ?, ?, ?, '{}', 'submitted', unixepoch())`,
      )
        .bind(crypto.randomUUID(), speaker.eventId, taskId, speaker.personId)
        .run();
      await expect(
        service.undoCompletion(speaker, completion.undoToken),
      ).rejects.toThrow("evidence or dependent work changed");
    });

    it("enforces the server-side completion undo expiry", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const taskId = await createChecklistTask(
        testEnv,
        `Expired participant undo ${crypto.randomUUID()}`,
      );
      const completion = await service.completeParticipant(speaker, {
        taskId,
        revision: 1,
        confirmed: true,
      });
      const operationId = completion.undoToken!.split(".", 1)[0]!;
      await testEnv.DB.prepare(
        `UPDATE operation_jobs
            SET result_json = json_set(result_json, '$.undoExpiresAt', unixepoch() - 1)
          WHERE id = ?`,
      )
        .bind(operationId)
        .run();
      await expect(
        service.undoCompletion(speaker, completion.undoToken),
      ).rejects.toThrow("five-minute undo window has expired");
    });

    it("undoes a direct administrator completion but blocks undo after downstream work", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const service = new TaskService(testEnv);
      const adminTaskId = await createChecklistTask(
        testEnv,
        `Undo administrator completion ${crypto.randomUUID()}`,
      );
      const adminCompletion = await service.administerTask(admin, {
        taskId: adminTaskId,
        revision: 1,
        intent: "complete",
        reason: "",
      });
      expect(adminCompletion.undoToken).toBeTruthy();
      await service.undoCompletion(admin, adminCompletion.undoToken);
      expect(
        await testEnv.DB.prepare(
          "SELECT status, revision FROM task_instances WHERE id = ?",
        )
          .bind(adminTaskId)
          .first(),
      ).toEqual({ status: "not_started", revision: 3 });

      const prerequisiteTemplateId = await service.createTemplate(admin, {
        name: `Undo dependency ${crypto.randomUUID()}`,
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
      const dependentTemplateId = await service.createTemplate(admin, {
        name: `Undo dependent ${crypto.randomUUID()}`,
        description: "Completing this makes the prerequisite undo unsafe.",
        targetType: "speaker",
        taskType: "checklist",
        impact: "high",
        evidenceMode: "checkbox",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [prerequisiteTemplateId],
      });
      const { taskId: dependentTaskId } = await service.assignTemplate(
        admin,
        dependentTemplateId,
        speaker.personId,
      );
      let tasks = await service.listParticipantTasks(speaker);
      const prerequisite = tasks.find(
        (task) => task.templateId === prerequisiteTemplateId,
      )!;
      const completion = await service.completeParticipant(speaker, {
        taskId: prerequisite.id,
        revision: prerequisite.revision,
        confirmed: true,
      });
      expect(completion.undoToken).toBeTruthy();
      tasks = await service.listParticipantTasks(speaker);
      const dependent = tasks.find((task) => task.id === dependentTaskId)!;
      await service.administerTask(admin, {
        taskId: dependent.id,
        revision: dependent.revision,
        intent: "complete",
        reason: "",
      });
      await service.administerTask(admin, {
        taskId: dependent.id,
        revision: dependent.revision + 1,
        intent: "reopen",
        reason: "",
      });

      await expect(
        service.undoCompletion(speaker, completion.undoToken),
      ).rejects.toThrow("dependent work changed");
      expect(
        await testEnv.DB.prepare(
          "SELECT status FROM task_instances WHERE id = ?",
        )
          .bind(prerequisite.id)
          .first(),
      ).toEqual({ status: "completed" });
    });
  });

  describe("participant workflows", () => {
    it("serializes participant completion against prerequisite reopen", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const pair = await createDependencyPair(
        testEnv,
        "Participant dependency race",
        {
          taskType: "checklist",
          evidenceMode: "checkbox",
        },
      );
      const racingEnv = withBatchRace(testEnv, async () => {
        await new TaskService(testEnv).administerTask(admin, {
          taskId: pair.prerequisite.id,
          revision: pair.prerequisite.revision,
          intent: "reopen",
          reason: "Recheck the prerequisite.",
        });
      });
      await expect(
        new TaskService(racingEnv).completeParticipant(speaker, {
          taskId: pair.dependent.id,
          revision: pair.dependent.revision,
          confirmed: true,
        }),
      ).rejects.toThrow(/changed|prerequisite/i);
      const state = await env.DB.prepare(
        `
        SELECT status,
               (SELECT COUNT(*) FROM task_evidence WHERE task_id = task_instances.id) AS evidenceCount
          FROM task_instances WHERE id = ?
      `,
      )
        .bind(pair.dependent.id)
        .first<{ status: string; evidenceCount: number }>();
      expect(state).toEqual({ status: "blocked", evidenceCount: 0 });
    });

    it("serializes file submission against prerequisite reopen", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const pair = await createDependencyPair(testEnv, "File dependency race", {
        taskType: "file_upload",
        evidenceMode: "file",
      });
      const upload = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: pair.dependent.id,
          assetKind: "task_evidence",
        },
        testPdfFile("dependency-race.pdf"),
      );
      const racingEnv = withBatchRace(testEnv, async () => {
        await new TaskService(testEnv).administerTask(admin, {
          taskId: pair.prerequisite.id,
          revision: pair.prerequisite.revision,
          intent: "reopen",
          reason: "Recheck the prerequisite.",
        });
      });
      await expect(
        new TaskService(racingEnv).attachCompletedFileEvidence(speaker, {
          taskId: pair.dependent.id,
          assetId: upload.assetId,
          versionId: upload.versionId,
        }),
      ).rejects.toThrow(/changed|prerequisite/i);
      expect(
        await env.DB.prepare(
          `
        SELECT COUNT(*) AS count FROM task_evidence WHERE task_id = ?
      `,
        )
          .bind(pair.dependent.id)
          .first<{ count: number }>(),
      ).toEqual({ count: 0 });
    });

    it("serializes administrator completion against prerequisite reopen", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const pair = await createDependencyPair(
        testEnv,
        "Administrator dependency race",
        {
          taskType: "checklist",
          evidenceMode: "checkbox",
        },
      );
      const racingEnv = withBatchRace(testEnv, async () => {
        await new TaskService(testEnv).administerTask(admin, {
          taskId: pair.prerequisite.id,
          revision: pair.prerequisite.revision,
          intent: "reopen",
          reason: "Recheck the prerequisite.",
        });
      });
      await expect(
        new TaskService(racingEnv).administerTask(admin, {
          taskId: pair.dependent.id,
          revision: pair.dependent.revision,
          intent: "complete",
          reason: "",
        }),
      ).rejects.toThrow(/changed|prerequisite/i);
      expect(
        (
          await env.DB.prepare("SELECT status FROM task_instances WHERE id = ?")
            .bind(pair.dependent.id)
            .first<{ status: string }>()
        )?.status,
      ).toBe("blocked");
    });
  });

  describe("participant workflows", () => {
    it("does not let an administrator approve file evidence before a clean scan", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const tasks = new TaskService(testEnv);
      const files = new FileService(testEnv);
      const presentation = new File(
        [new TextEncoder().encode("%PDF-1.7\npresentation evidence")],
        "presentation.pdf",
        { type: "application/pdf" },
      );
      const upload = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: "task-demo-slides",
          assetKind: "task_evidence",
        },
        presentation,
      );
      await expect(
        tasks.attachCompletedFileEvidence(speaker, {
          taskId: "task-demo-slides",
          assetId: upload.assetId,
          versionId: upload.versionId,
        }),
      ).resolves.toMatchObject({ duplicate: false });
      await expect(
        tasks.attachCompletedFileEvidence(speaker, {
          taskId: "task-demo-slides",
          assetId: upload.assetId,
          versionId: upload.versionId,
        }),
      ).resolves.toMatchObject({ duplicate: true });
      expect(
        await testEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM task_evidence WHERE task_id = ?) AS evidenceCount,
             (SELECT COUNT(*) FROM audit_events
               WHERE entity_id = ? AND action = 'task.file.submitted') AS auditCount`,
        )
          .bind("task-demo-slides", "task-demo-slides")
          .first<{ evidenceCount: number; auditCount: number }>(),
      ).toEqual({ evidenceCount: 1, auditCount: 1 });
      const submitted = (await tasks.getAdminWorkspace(admin)).tasks.find(
        (item) => item.id === "task-demo-slides",
      )!;
      await expect(
        tasks.administerTask(admin, {
          taskId: submitted.id,
          revision: submitted.revision,
          intent: "approve",
          reason: "",
        }),
      ).rejects.toThrow("still quarantined");

      await files.recordScanResult({
        ...(await acceptTestFileScanDispatch(
          testEnv,
          speaker.eventId,
          upload.versionId,
        )),
        eventId: speaker.eventId,
        versionId: upload.versionId,
        provider: "test-scanner",
        callbackId: `callback-${upload.versionId}`,
        status: "clean",
        result: { verdict: "clean" },
      });
      const download = await files.administratorTaskEvidenceDownload(
        admin,
        upload.assetId,
        upload.versionId,
      );
      expect(download.status).toBe(200);
      expect(download.headers.get("cache-control")).toBe("private, no-store");
      await expect(
        files.administratorTaskEvidenceDownload(
          speaker,
          upload.assetId,
          upload.versionId,
        ),
      ).rejects.toThrow("Administrator access is required");
      await tasks.administerTask(admin, {
        taskId: submitted.id,
        revision: submitted.revision,
        intent: "approve",
        reason: "",
      });
      expect(
        (await tasks.getAdminWorkspace(admin)).tasks.find(
          (item) => item.id === submitted.id,
        )?.status,
      ).toBe("completed");
    });

    it("attaches only the exact completed task-evidence version", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createFileTask(testEnv, "Exact file version");
      const upload = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: taskId,
          assetKind: "task_evidence",
        },
        testPdfFile("exact-version.pdf"),
      );
      await expect(
        new TaskService(testEnv).attachCompletedFileEvidence(speaker, {
          taskId,
          assetId: upload.assetId,
          versionId: crypto.randomUUID(),
        }),
      ).rejects.toThrow("exact file version");
      expect(
        await testEnv.DB.prepare(
          "SELECT COUNT(*) AS count FROM task_evidence WHERE task_id = ?",
        )
          .bind(taskId)
          .first<{ count: number }>(),
      ).toEqual({ count: 0 });
    });

    it("reuses the canonical task asset for retained replacement versions and exact downloads", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createFileTask(testEnv, "Versioned presentation");
      const files = new FileService(testEnv);
      const tasks = new TaskService(testEnv);
      const evidenceFile = testPdfFile;
      const first = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: taskId,
          assetKind: "task_evidence",
        },
        evidenceFile("slides-v1.pdf", 1),
      );
      await tasks.attachCompletedFileEvidence(speaker, {
        taskId,
        assetId: first.assetId,
        versionId: first.versionId,
      });
      await files.recordScanResult({
        ...(await acceptTestFileScanDispatch(
          testEnv,
          speaker.eventId,
          first.versionId,
        )),
        eventId: speaker.eventId,
        versionId: first.versionId,
        provider: "test-scanner",
        callbackId: `callback-${first.versionId}`,
        status: "clean",
        result: { verdict: "clean" },
      });

      const second = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: taskId,
          assetKind: "task_evidence",
        },
        evidenceFile("slides-v2.pdf", 2),
      );
      expect(second).toMatchObject({
        assetId: first.assetId,
        versionNumber: 2,
      });
      await tasks.attachCompletedFileEvidence(speaker, {
        taskId,
        assetId: second.assetId,
        versionId: second.versionId,
      });
      await files.recordScanResult({
        ...(await acceptTestFileScanDispatch(
          testEnv,
          speaker.eventId,
          second.versionId,
        )),
        eventId: speaker.eventId,
        versionId: second.versionId,
        provider: "test-scanner",
        callbackId: `callback-${second.versionId}`,
        status: "clean",
        result: { verdict: "clean" },
      });

      const infected = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: taskId,
          assetKind: "task_evidence",
        },
        evidenceFile("slides-v3-infected.pdf", 3),
      );
      await tasks.attachCompletedFileEvidence(speaker, {
        taskId,
        assetId: infected.assetId,
        versionId: infected.versionId,
      });
      await files.recordScanResult({
        ...(await acceptTestFileScanDispatch(
          testEnv,
          speaker.eventId,
          infected.versionId,
        )),
        eventId: speaker.eventId,
        versionId: infected.versionId,
        provider: "test-scanner",
        callbackId: `callback-${infected.versionId}`,
        status: "infected",
        result: { verdict: "infected" },
      });

      const task = (await tasks.listParticipantTasks(speaker)).find(
        (candidate) => candidate.id === taskId,
      );
      expect(
        await files.listParticipantTaskEvidenceVersions(speaker, [task!.id]),
      ).toEqual([
        expect.objectContaining({
          versionId: infected.versionId,
          versionNumber: 3,
          uploadStatus: "uploaded",
          signatureStatus: "valid",
          scanStatus: "infected",
          releasedAt: null,
          latest: true,
          current: false,
          downloadAvailable: false,
        }),
        expect.objectContaining({
          versionId: second.versionId,
          versionNumber: 2,
          uploadStatus: "uploaded",
          signatureStatus: "valid",
          scanStatus: "clean",
          releasedAt: expect.any(Number),
          latest: false,
          current: true,
          downloadAvailable: true,
        }),
        expect.objectContaining({
          versionId: first.versionId,
          versionNumber: 1,
          uploadStatus: "uploaded",
          signatureStatus: "valid",
          scanStatus: "clean",
          releasedAt: expect.any(Number),
          latest: false,
          current: false,
          downloadAvailable: true,
        }),
      ]);
      await expect(
        files.participantTaskEvidenceDownload(
          speaker,
          first.assetId,
          first.versionId,
        ),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        files.participantTaskEvidenceDownload(
          speaker,
          second.assetId,
          second.versionId,
        ),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        files.administratorTaskEvidenceDownload(
          admin,
          first.assetId,
          first.versionId,
        ),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        files.participantTaskEvidenceDownload(
          submitter,
          first.assetId,
          first.versionId,
        ),
      ).rejects.toThrow("outside your tasks");
    });

    it("shares session-deliverable evidence and replacements with every assigned session speaker", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const coSpeaker = await createSessionCoSpeaker(testEnv);
      const files = new FileService(testEnv);
      const tasks = new TaskService(testEnv);
      const taskId = await createSessionFileTask(
        testEnv,
        `Shared session slides ${crypto.randomUUID()}`,
      );
      const evidenceFile = testPdfFile;
      const target = {
        targetType: "task" as const,
        targetId: taskId,
        assetKind: "task_evidence" as const,
      };

      const first = await completeTestDirectUpload(
        testEnv,
        speaker,
        target,
        evidenceFile("shared-slides-v1.pdf", 1),
      );
      await tasks.attachCompletedFileEvidence(speaker, {
        taskId: target.targetId,
        assetId: first.assetId,
        versionId: first.versionId,
      });
      await files.recordScanResult({
        ...(await acceptTestFileScanDispatch(
          testEnv,
          speaker.eventId,
          first.versionId,
        )),
        eventId: speaker.eventId,
        versionId: first.versionId,
        provider: "test-scanner",
        callbackId: `callback-${first.versionId}`,
        status: "clean",
        result: { verdict: "clean" },
      });

      await expect(
        files.listParticipantTaskEvidenceVersions(coSpeaker, [target.targetId]),
      ).resolves.toEqual([
        expect.objectContaining({
          assetId: first.assetId,
          versionId: first.versionId,
          versionNumber: 1,
          downloadAvailable: true,
        }),
      ]);
      await expect(
        files.participantTaskEvidenceDownload(
          coSpeaker,
          first.assetId,
          first.versionId,
        ),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        files.participantDownload(speaker, first.assetId),
      ).rejects.toThrow();

      const second = await completeTestDirectUpload(
        testEnv,
        coSpeaker,
        target,
        evidenceFile("shared-slides-v2.pdf", 2),
      );
      expect(second).toMatchObject({
        assetId: first.assetId,
        versionNumber: 2,
      });
      await tasks.attachCompletedFileEvidence(coSpeaker, {
        taskId: target.targetId,
        assetId: second.assetId,
        versionId: second.versionId,
      });
      await files.recordScanResult({
        ...(await acceptTestFileScanDispatch(
          testEnv,
          coSpeaker.eventId,
          second.versionId,
        )),
        eventId: coSpeaker.eventId,
        versionId: second.versionId,
        provider: "test-scanner",
        callbackId: `callback-${second.versionId}`,
        status: "clean",
        result: { verdict: "clean" },
      });

      await expect(
        files.listParticipantTaskEvidenceVersions(speaker, [target.targetId]),
      ).resolves.toEqual([
        expect.objectContaining({
          versionId: second.versionId,
          versionNumber: 2,
          current: true,
        }),
        expect.objectContaining({
          versionId: first.versionId,
          versionNumber: 1,
          current: false,
        }),
      ]);

      const third = await completeTestDirectUpload(
        testEnv,
        coSpeaker,
        target,
        evidenceFile("shared-slides-v3.pdf", 3),
      );
      const racingEnv = withBatchRace(testEnv, async () => {
        await testEnv.DB.prepare(
          `DELETE FROM session_speakers
            WHERE event_id = ? AND session_id = 'session-demo-speaker'
              AND person_id = ?`,
        )
          .bind(coSpeaker.eventId, coSpeaker.personId)
          .run();
      });

      await expect(
        new TaskService(racingEnv).attachCompletedFileEvidence(coSpeaker, {
          taskId: target.targetId,
          assetId: third.assetId,
          versionId: third.versionId,
        }),
      ).rejects.toThrow("changed. Refresh before submitting file evidence");
      expect(
        await testEnv.DB.prepare(
          `SELECT COUNT(*) AS count FROM task_evidence
            WHERE event_id = ? AND task_id = ?
              AND CASE WHEN json_valid(evidence_json)
                    THEN json_extract(evidence_json, '$.fileVersionId')
                  END = ?`,
        )
          .bind(coSpeaker.eventId, target.targetId, third.versionId)
          .first<{ count: number }>(),
      ).toEqual({ count: 0 });
      expect(
        await testEnv.DB.prepare(
          `SELECT CASE WHEN json_valid(evidence_json)
                  THEN json_extract(evidence_json, '$.fileVersionId')
                END AS versionId
             FROM task_instances WHERE id = ? AND event_id = ?`,
        )
          .bind(target.targetId, coSpeaker.eventId)
          .first<{ versionId: string | null }>(),
      ).toEqual({ versionId: second.versionId });
      await files.discardUnattachedTaskUpload(
        coSpeaker,
        { assetId: third.assetId, versionId: third.versionId },
        target.targetId,
      );
      expect(
        await testEnv.DB.prepare(
          `SELECT deleted_at AS deletedAt FROM file_versions
            WHERE id = ? AND event_id = ? AND asset_id = ?`,
        )
          .bind(third.versionId, coSpeaker.eventId, third.assetId)
          .first<{ deletedAt: number | null }>(),
      ).toEqual({ deletedAt: expect.any(Number) });
    });

    it("revokes the declined participant's exact-session task and file access while another speaker keeps the shared task active", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const coSpeaker = await createSessionCoSpeaker(testEnv);
      const tasks = new TaskService(testEnv);
      const files = new FileService(testEnv);
      await testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'pending', participation_revision = 1,
                participation_confirmed_at = NULL,
                participation_declined_at = NULL,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = 'session-demo-speaker'
            AND person_id = ?`,
      )
        .bind(speaker.eventId, speaker.personId)
        .run();
      const fileTaskId = await createSessionFileTask(
        testEnv,
        `Revoked session deliverable ${crypto.randomUUID()}`,
      );
      const checklistTemplateId = await tasks.createTemplate(admin, {
        name: `Revoked session checklist ${crypto.randomUUID()}`,
        description: "Confirm the private session requirement.",
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
      const checklistTaskId = (
        await tasks.assignTemplate(
          admin,
          checklistTemplateId,
          "session-demo-speaker",
        )
      ).taskId;
      await testEnv.DB.prepare(
        `UPDATE task_instances SET owner_person_id = ?
          WHERE event_id = ? AND id IN (?, ?)`,
      )
        .bind(speaker.personId, speaker.eventId, fileTaskId, checklistTaskId)
        .run();

      const target = {
        targetType: "task" as const,
        targetId: fileTaskId,
        assetKind: "task_evidence" as const,
      };
      const uploaded = await completeTestDirectUpload(
        testEnv,
        speaker,
        target,
        testPdfFile("revoked-owner-evidence.pdf", 0x44),
      );
      await tasks.attachCompletedFileEvidence(speaker, {
        taskId: fileTaskId,
        assetId: uploaded.assetId,
        versionId: uploaded.versionId,
      });
      await files.recordScanResult({
        ...(await acceptTestFileScanDispatch(
          testEnv,
          speaker.eventId,
          uploaded.versionId,
        )),
        eventId: speaker.eventId,
        versionId: uploaded.versionId,
        provider: "test-scanner",
        callbackId: `callback-${uploaded.versionId}`,
        status: "clean",
        result: { verdict: "clean" },
      });
      const checklist = (await tasks.listParticipantTasks(speaker)).find(
        (task) => task.id === checklistTaskId,
      );
      expect(checklist).toBeDefined();

      await new SpeakerService(testEnv).respondOwnRole(speaker, {
        sessionId: "session-demo-speaker",
        role: "speaker",
        roleRevision: 1,
        response: "declined",
        reason: "I am unavailable for this session.",
      });

      const visibleTaskIds = (await tasks.listParticipantTasks(speaker)).map(
        (task) => task.id,
      );
      expect(visibleTaskIds).not.toContain(fileTaskId);
      expect(visibleTaskIds).not.toContain(checklistTaskId);
      const coSpeakerTaskIds = (
        await tasks.listParticipantTasks(coSpeaker)
      ).map((task) => task.id);
      expect(coSpeakerTaskIds).toContain(fileTaskId);
      expect(coSpeakerTaskIds).toContain(checklistTaskId);
      expect(
        (await tasks.getAdminWorkspace(admin)).tasks.find(
          (task) => task.id === checklistTaskId,
        )?.participantActionable,
      ).toBe(true);
      await expect(
        tasks.completeParticipant(speaker, {
          taskId: checklistTaskId,
          revision: checklist!.revision,
          confirmed: true,
        }),
      ).rejects.toThrow("not owned by this speaker");
      await expect(
        tasks.addComment(
          speaker,
          fileTaskId,
          "This former speaker must not retain access.",
          "participant",
          `comment-intent:${crypto.randomUUID()}`,
        ),
      ).rejects.toThrow("not accessible to this participant");
      await expect(
        tasks.assertFileEvidenceUploadAllowed(speaker, fileTaskId),
      ).rejects.toThrow("File task not found");
      await expect(
        files.assertParticipantTarget(speaker, target),
      ).rejects.toThrow("does not belong to this speaker");
      await expect(
        files.listParticipantTaskEvidenceVersions(speaker, [fileTaskId]),
      ).resolves.toEqual([]);
      await expect(
        files.participantTaskEvidenceDownload(
          speaker,
          uploaded.assetId,
          uploaded.versionId,
        ),
      ).rejects.toThrow("outside your tasks");
      await testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'pending',
                participation_revision = participation_revision + 1,
                participation_confirmed_at = NULL,
                participation_declined_at = NULL,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = 'session-demo-speaker'
            AND person_id = ?`,
      )
        .bind(speaker.eventId, speaker.personId)
        .run();
    });

    it("revalidates session membership in participant completion and comment writes", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const tasks = new TaskService(testEnv);
      const templateId = await tasks.createTemplate(admin, {
        name: `Session authorization race ${crypto.randomUUID()}`,
        description: "Confirm the private session requirement.",
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
      const taskId = (
        await tasks.assignTemplate(admin, templateId, "session-demo-speaker")
      ).taskId;
      await testEnv.DB.prepare(
        "UPDATE task_instances SET owner_person_id = ? WHERE id = ? AND event_id = ?",
      )
        .bind(speaker.personId, taskId, speaker.eventId)
        .run();
      const task = (await tasks.listParticipantTasks(speaker)).find(
        (candidate) => candidate.id === taskId,
      )!;
      const removeRelationship = () =>
        testEnv.DB.prepare(
          `DELETE FROM session_speakers
            WHERE event_id = ? AND session_id = 'session-demo-speaker'
              AND person_id = ?`,
        )
          .bind(speaker.eventId, speaker.personId)
          .run()
          .then(() => undefined);

      await expect(
        new TaskService(
          withBatchRace(testEnv, removeRelationship),
        ).completeParticipant(speaker, {
          taskId,
          revision: task.revision,
          confirmed: true,
        }),
      ).rejects.toThrow("changed. Refresh before completing");
      await expect(
        testEnv.DB.prepare(
          "SELECT status FROM task_instances WHERE id = ? AND event_id = ?",
        )
          .bind(taskId, speaker.eventId)
          .first(),
      ).resolves.toEqual({ status: "not_started" });

      await ensureDemoSpeakerData(testEnv);
      await expect(
        new TaskService(withBatchRace(testEnv, removeRelationship)).addComment(
          speaker,
          taskId,
          "This comment must lose the authorization race.",
          "participant",
          `comment-intent:${crypto.randomUUID()}`,
        ),
      ).rejects.toThrow("Task access changed");
      await expect(
        testEnv.DB.prepare(
          "SELECT COUNT(*) AS count FROM task_comments WHERE task_id = ?",
        )
          .bind(taskId)
          .first(),
      ).resolves.toEqual({ count: 0 });
    });

    it("fails fast when a submitted file task lacks canonical evidence", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createFileTask(testEnv, "Broken file evidence");
      await testEnv.DB.prepare(
        `UPDATE task_instances
            SET status = 'submitted', evidence_json = '{}',
                submitted_at = unixepoch(), revision = revision + 1
          WHERE id = ? AND event_id = ?`,
      )
        .bind(taskId, speaker.eventId)
        .run();

      await expect(
        completeTestDirectUpload(
          testEnv,
          speaker,
          {
            targetType: "task",
            targetId: taskId,
            assetKind: "task_evidence",
          },
          new File(["%PDF-1.7"], "replacement.pdf", {
            type: "application/pdf",
          }),
        ),
      ).rejects.toThrow("missing canonical evidence");
      expect(
        await testEnv.DB.prepare(
          `SELECT COUNT(*) AS count
             FROM file_assets
            WHERE event_id = ? AND target_type = 'task' AND target_id = ?`,
        )
          .bind(speaker.eventId, taskId)
          .first<{ count: number }>(),
      ).toEqual({ count: 0 });
    });

    it("reopens infected file evidence and accepts a replacement upload", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createFileTask(testEnv, "Replace infected evidence");
      const files = new FileService(testEnv);
      const tasks = new TaskService(testEnv);
      const evidenceFile = testPdfFile;
      const infected = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: taskId,
          assetKind: "task_evidence",
        },
        evidenceFile("infected.pdf"),
      );
      await tasks.attachCompletedFileEvidence(speaker, {
        taskId,
        assetId: infected.assetId,
        versionId: infected.versionId,
      });

      await files.recordScanResult({
        ...(await acceptTestFileScanDispatch(
          testEnv,
          speaker.eventId,
          infected.versionId,
        )),
        eventId: speaker.eventId,
        versionId: infected.versionId,
        provider: "test-scanner",
        callbackId: `callback-${infected.versionId}`,
        status: "infected",
        result: { verdict: "infected" },
      });

      const reopened = (await tasks.listParticipantTasks(speaker)).find(
        (task) => task.id === taskId,
      );
      expect(reopened).toMatchObject({ status: "in_progress", revision: 3 });
      expect(
        await testEnv.DB.prepare(
          "SELECT status FROM task_evidence WHERE task_id = ?",
        )
          .bind(taskId)
          .first<{ status: string }>(),
      ).toEqual({ status: "rejected" });

      const replacement = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: taskId,
          assetKind: "task_evidence",
        },
        evidenceFile("replacement.pdf"),
      );
      await tasks.attachCompletedFileEvidence(speaker, {
        taskId,
        assetId: replacement.assetId,
        versionId: replacement.versionId,
      });

      expect(
        (await tasks.listParticipantTasks(speaker)).find(
          (task) => task.id === taskId,
        ),
      ).toMatchObject({ status: "submitted", revision: 4 });
      const evidence = await testEnv.DB.prepare(
        "SELECT status FROM task_evidence WHERE task_id = ? ORDER BY created_at, id",
      )
        .bind(taskId)
        .all<{ status: string }>();
      expect(evidence.results.map((item) => item.status).sort()).toEqual([
        "rejected",
        "submitted",
      ]);
    });

    it("does not let a losing participant completion piggyback on a winning revision", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createChecklistTask(
        testEnv,
        "Concurrent participant completion",
      );
      const racingEnv = withBatchRace(testEnv, async () => {
        await testEnv.DB.prepare(
          `
          UPDATE task_instances
             SET status = 'completed', readiness_state = 'on_track', readiness_percent = 100,
                 revision = revision + 1, last_operation_id = 'winning-completion'
           WHERE id = ? AND event_id = ?
        `,
        )
          .bind(taskId, speaker.eventId)
          .run();
      });

      await expect(
        new TaskService(racingEnv).completeParticipant(speaker, {
          taskId,
          revision: 1,
          confirmed: true,
        }),
      ).rejects.toThrow("changed. Refresh before completing");
      const sideEffects = await testEnv.DB.prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM task_evidence WHERE task_id = ?) AS evidenceCount,
          (SELECT COUNT(*) FROM audit_events WHERE entity_id = ? AND action = 'task.completed') AS auditCount
      `,
      )
        .bind(taskId, taskId)
        .first<{ evidenceCount: number; auditCount: number }>();
      expect(sideEffects).toEqual({ evidenceCount: 0, auditCount: 0 });
    });
  });

  describe("participant workflows", () => {
    it("fails a raced file submission without recording evidence or audit history", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createFileTask(testEnv, "Raced file task");
      const upload = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: taskId,
          assetKind: "task_evidence",
        },
        testPdfFile("raced.pdf"),
      );
      const racingEnv = withBatchRace(testEnv, async () => {
        await testEnv.DB.prepare(
          `
          UPDATE task_instances
             SET status = 'waived', revision = revision + 1,
                 last_operation_id = 'winning-waiver'
           WHERE id = ? AND event_id = ?
        `,
        )
          .bind(taskId, speaker.eventId)
          .run();
      });

      await expect(
        new TaskService(racingEnv).attachCompletedFileEvidence(speaker, {
          taskId,
          assetId: upload.assetId,
          versionId: upload.versionId,
        }),
      ).rejects.toThrow("changed. Refresh before submitting file evidence");
      const task = await testEnv.DB.prepare(
        `
        SELECT status, revision, evidence_json AS evidenceJson
          FROM task_instances WHERE id = ? AND event_id = ?
      `,
      )
        .bind(taskId, speaker.eventId)
        .first<{
          status: string;
          revision: number;
          evidenceJson: string | null;
        }>();
      expect(task).toEqual({
        status: "waived",
        revision: 2,
        evidenceJson: null,
      });
      const sideEffects = await testEnv.DB.prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM task_evidence WHERE task_id = ?) AS evidenceCount,
          (SELECT COUNT(*) FROM audit_events WHERE entity_id = ? AND action = 'task.file.submitted') AS auditCount
      `,
      )
        .bind(taskId, taskId)
        .first<{ evidenceCount: number; auditCount: number }>();
      expect(sideEffects).toEqual({ evidenceCount: 0, auditCount: 0 });
    });

    it("does not let a losing approval alter evidence after a concurrent waiver", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createFileTask(testEnv, "Concurrent approval");
      const files = new FileService(testEnv);
      const tasks = new TaskService(testEnv);
      const upload = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: taskId,
          assetKind: "task_evidence",
        },
        testPdfFile("approval-race.pdf"),
      );
      await tasks.attachCompletedFileEvidence(speaker, {
        taskId,
        assetId: upload.assetId,
        versionId: upload.versionId,
      });
      await files.recordScanResult({
        ...(await acceptTestFileScanDispatch(
          testEnv,
          speaker.eventId,
          upload.versionId,
        )),
        eventId: speaker.eventId,
        versionId: upload.versionId,
        provider: "test-scanner",
        callbackId: `callback-${upload.versionId}`,
        status: "clean",
        result: { verdict: "clean" },
      });
      const submitted = await testEnv.DB.prepare(
        "SELECT revision FROM task_instances WHERE id = ? AND event_id = ?",
      )
        .bind(taskId, speaker.eventId)
        .first<{ revision: number }>();
      const racingEnv = withBatchRace(testEnv, async () => {
        await testEnv.DB.prepare(
          `
          UPDATE task_instances
             SET status = 'waived', revision = revision + 1,
                 last_operation_id = 'winning-admin-waiver'
           WHERE id = ? AND event_id = ?
        `,
        )
          .bind(taskId, speaker.eventId)
          .run();
      });

      await expect(
        new TaskService(racingEnv).administerTask(admin, {
          taskId,
          revision: submitted!.revision,
          intent: "approve",
          reason: "",
        }),
      ).rejects.toThrow("changed. Refresh before applying");
      const evidence = await testEnv.DB.prepare(
        `
        SELECT status, reviewed_by_person_id AS reviewedBy
          FROM task_evidence WHERE task_id = ?
      `,
      )
        .bind(taskId)
        .first<{ status: string; reviewedBy: string | null }>();
      expect(evidence).toEqual({ status: "submitted", reviewedBy: null });
      const audit = await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ? AND action = 'task.approve'",
      )
        .bind(taskId)
        .first<{ count: number }>();
      expect(audit?.count).toBe(0);
    });
  });
});
