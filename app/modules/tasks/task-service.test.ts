import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
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
    dependencyIds: [],
  });
  return tasks.assignTemplate(admin, templateId, speaker.personId);
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
    dependencyIds: [],
  });
  return tasks.assignTemplate(admin, templateId, speaker.personId);
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
    dependencyIds: [prerequisiteTemplateId],
  });
  const dependentTaskId = await tasks.assignTemplate(
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
  it("rejects task scopes and evidence combinations that have no implemented workflow", async () => {
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
      dependencyIds: [],
    } as const;

    await expect(
      service.createTemplate(admin, { ...base, evidenceMode: "file" }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      service.createTemplate(admin, { ...base, targetType: "session" }),
    ).rejects.toBeInstanceOf(ZodError);

    const persisted = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM task_templates WHERE event_id = ? AND name = ?",
    )
      .bind(admin.eventId, base.name)
      .first<{ count: number }>();
    expect(persisted?.count).toBe(0);
  });

  it("rejects ineligible task uploads before any file storage begins", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const taskId = await createChecklistTask(
      testEnv,
      "Non-file upload preflight",
    );

    await expect(
      new TaskService(testEnv).assertFileEvidenceUploadAllowed(speaker, taskId),
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
      dependencyIds: [],
    });
    const taskId = await service.assignTemplate(
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
      .first<{ status: string; evidenceJson: string | null; revision: number }>();
    expect(task).toEqual({
      status: "not_started",
      evidenceJson: null,
      revision: 1,
    });
  });

  it("interprets fixed due dates at the end of the event-local calendar day", () => {
    expect(fixedDateEndEpoch("2030-06-01", "America/Toronto")).toBe(
      Date.parse("2030-06-02T03:59:59Z") / 1_000,
    );
    expect(fixedDateEndEpoch("2030-06-01", "Australia/Melbourne")).toBe(
      Date.parse("2030-06-01T13:59:59Z") / 1_000,
    );
  });

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
      ).bind(`${prefix}-comment`, speaker.eventId, taskIds[0], admin.personId),
    ]);

    const tasks = await new TaskService(testEnv).listParticipantTasks(speaker);
    const largeTasks = tasks.filter((task) => task.id.startsWith(prefix));
    expect(largeTasks).toHaveLength(105);
    expect(largeTasks.find((task) => task.id === taskIds[0])).toMatchObject({
      dependencies: [
        expect.objectContaining({ id: taskIds[1], status: "not_started" }),
      ],
      comments: [expect.objectContaining({ body: "Large-list comment" })],
    });
  });

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

  it.each(["acceptance", "session_start"] as const)(
    "rejects an unresolved %s due anchor without materializing the task",
    async (dueAnchor) => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const personId = `person-unanchored-${crypto.randomUUID()}`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `
          INSERT INTO people (
            id, email, display_name, email_verified, profile_status, created_at, updated_at
          ) VALUES (?, ?, 'Unanchored Speaker', 1, 'published', unixepoch(), unixepoch())
        `,
        ).bind(personId, `${personId}@example.com`),
        testEnv.DB.prepare(
          `
          INSERT INTO memberships (
            id, organisation_id, event_id, person_id, role, accepted_at, created_at
          ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch())
        `,
        ).bind(
          `membership-unanchored-${crypto.randomUUID()}`,
          admin.organisationId,
          admin.eventId,
          personId,
        ),
      ]);
      const service = new TaskService(testEnv);
      const templateId = await service.createTemplate(admin, {
        name: `Unresolved ${dueAnchor} ${crypto.randomUUID()}`,
        description: "This task requires a real due-date anchor.",
        targetType: "speaker",
        taskType: "checklist",
        impact: "high",
        evidenceMode: "checkbox",
        dueAnchor,
        dueOffsetDays: 2,
        fixedDueDate: null,
        dependencyIds: [],
      });

      await expect(
        service.assignTemplate(admin, templateId, personId),
      ).rejects.toBeInstanceOf(TaskStateError);
      const stored = await testEnv.DB.prepare(
        `
        SELECT COUNT(*) AS count FROM task_instances
         WHERE event_id = ? AND template_id = ? AND target_id = ?
      `,
      )
        .bind(admin.eventId, templateId, personId)
        .first<{ count: number }>();
      expect(stored?.count).toBe(0);
    },
  );

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
      dependencyIds: [],
    });
    const service = new TaskService(withBatchBarrier(testEnv));
    const ids = await Promise.all([
      service.assignTemplate(admin, templateId, speaker.personId),
      service.assignTemplate(admin, templateId, speaker.personId),
    ]);
    expect(new Set(ids).size).toBe(1);
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
    const upload = await new FileService(testEnv).uploadParticipantFile(
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
      new TaskService(racingEnv).submitFileEvidence(
        speaker,
        pair.dependent.id,
        upload.assetId,
      ),
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
    const upload = await files.uploadParticipantFile(
      speaker,
      {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      png,
    );
    await tasks.submitFileEvidence(speaker, "task-demo-slides", upload.assetId);
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
      eventId: speaker.eventId,
      versionId: upload.versionId,
      provider: "test-scanner",
      clean: true,
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
    const infected = await files.uploadParticipantFile(
      speaker,
      {
        targetType: "task",
        targetId: taskId,
        assetKind: "task_evidence",
      },
      evidenceFile("infected.png"),
    );
    await tasks.submitFileEvidence(speaker, taskId, infected.assetId);

    await files.recordScanResult({
      eventId: speaker.eventId,
      versionId: infected.versionId,
      provider: "test-scanner",
      clean: false,
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

    const replacement = await files.uploadParticipantFile(
      speaker,
      {
        targetType: "task",
        targetId: taskId,
        assetKind: "task_evidence",
      },
      evidenceFile("replacement.png"),
    );
    await tasks.submitFileEvidence(speaker, taskId, replacement.assetId);

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

  it.each(["completed", "waived"] as const)(
    "does not record file evidence after a task is %s",
    async (status) => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoSpeakerData(testEnv);
      const taskId = await createFileTask(testEnv, `Final ${status} file task`);
      const files = new FileService(testEnv);
      const upload = await files.uploadParticipantFile(
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
          `${status}.png`,
          { type: "image/png" },
        ),
      );
      await testEnv.DB.prepare(
        `
        UPDATE task_instances
           SET status = ?, revision = revision + 1
         WHERE id = ? AND event_id = ?
      `,
      )
        .bind(status, taskId, speaker.eventId)
        .run();

      await expect(
        new TaskService(testEnv).submitFileEvidence(
          speaker,
          taskId,
          upload.assetId,
        ),
      ).rejects.toThrow("already completed or waived");
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
    },
  );

  it("fails a raced file submission without recording evidence or audit history", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const taskId = await createFileTask(testEnv, "Raced file task");
    const upload = await new FileService(testEnv).uploadParticipantFile(
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
      new TaskService(racingEnv).submitFileEvidence(
        speaker,
        taskId,
        upload.assetId,
      ),
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
    expect(task).toEqual({ status: "waived", revision: 2, evidenceJson: null });
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
    const upload = await files.uploadParticipantFile(
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
    await tasks.submitFileEvidence(speaker, taskId, upload.assetId);
    await files.recordScanResult({
      eventId: speaker.eventId,
      versionId: upload.versionId,
      provider: "test-scanner",
      clean: true,
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
