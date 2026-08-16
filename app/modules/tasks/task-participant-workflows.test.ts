import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  acceptTestFileScanDispatch,
  completeTestDirectUpload,
} from "~/modules/files/direct-upload.test-helper";
import { FileService } from "~/modules/files/file-service.server";
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
const submitter: Viewer = {
  personId: "person-demo-submitter",
  name: "Alex Morgan",
  email: "alex.submitter@example.com",
  role: "submitter",
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

    it("rejects non-web task evidence links before persisting clickable evidence", async () => {
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
      });
      const { taskId } = await service.assignTemplate(
        admin,
        templateId,
        speaker.personId,
      );

      await expect(
        service.completeParticipant(speaker, {
          taskId,
          revision: 1,
          url: "javascript:alert(document.domain)",
        }),
      ).rejects.toBeInstanceOf(ZodError);

      const task = await testEnv.DB.prepare(
        "SELECT status, evidence_json AS evidenceJson, revision FROM task_instances WHERE id = ?",
      )
        .bind(taskId)
        .first<{
          status: string;
          evidenceJson: string | null;
          revision: number;
        }>();
      expect(task).toEqual({
        status: "not_started",
        evidenceJson: null,
        revision: 1,
      });
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
        new File(
          [
            new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
            ]),
          ],
          "dependency-race.png",
          { type: "image/png" },
        ),
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
      const png = new File(
        [
          new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
          ]),
        ],
        "evidence.png",
        { type: "image/png" },
      );
      const upload = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: "task-demo-slides",
          assetKind: "task_evidence",
        },
        png,
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
        new File(
          [
            new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
            ]),
          ],
          "exact-version.png",
          { type: "image/png" },
        ),
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
      const evidenceFile = (name: string, marker: number) =>
        new File(
          [
            new Uint8Array([
              0x89,
              0x50,
              0x4e,
              0x47,
              0x0d,
              0x0a,
              0x1a,
              0x0a,
              marker,
            ]),
          ],
          name,
          { type: "image/png" },
        );
      const first = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: taskId,
          assetKind: "task_evidence",
        },
        evidenceFile("slides-v1.png", 1),
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
        evidenceFile("slides-v2.png", 2),
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
        evidenceFile("slides-v3-infected.png", 3),
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
      const evidenceFile = (name: string) =>
        new File(
          [
            new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
            ]),
          ],
          name,
          { type: "image/png" },
        );
      const infected = await completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: taskId,
          assetKind: "task_evidence",
        },
        evidenceFile("infected.png"),
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
        evidenceFile("replacement.png"),
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
        new File(
          [
            new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
            ]),
          ],
          "raced.png",
          { type: "image/png" },
        ),
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
        new File(
          [
            new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
            ]),
          ],
          "approval-race.png",
          { type: "image/png" },
        ),
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
