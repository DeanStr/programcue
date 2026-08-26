import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { TaskService } from "~/modules/tasks/task-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./admin-tasks";

const workerEnv = env as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";
const administrator: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId,
  demo: true,
};

function context(environment: CloudflareEnvironment = workerEnv) {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function adminPost(values: Record<string, string>) {
  const eventCookie = currentEventCookie(eventId, workerEnv).split(";", 1)[0];
  return new Request("http://localhost/admin/tasks", {
    method: "POST",
    headers: {
      cookie: `program_cue_demo_identity=administrator; ${eventCookie}`,
      origin: "http://localhost",
    },
    body: new URLSearchParams(values),
  });
}

function routeEnvironment(queued: unknown[]) {
  const channel = {
    async fetch() {
      return Response.json({ accepted: true });
    },
  };
  return {
    ...workerEnv,
    DB: workerEnv.DB,
    OPERATIONS_QUEUE: {
      async send(message: unknown) {
        queued.push(message);
      },
    },
    EVENT_CHANNEL: {
      idFromName(name: string) {
        return name;
      },
      get() {
        return channel;
      },
    },
  } as unknown as CloudflareEnvironment;
}

function adminRequest(search = "") {
  const eventCookie = currentEventCookie(eventId, workerEnv).split(";", 1)[0];
  return new Request(`http://localhost/admin/tasks${search}`, {
    headers: {
      cookie: `program_cue_demo_identity=administrator; ${eventCookie}`,
    },
  });
}

async function load(search = "") {
  return loader({
    request: adminRequest(search),
    params: {},
    context: context(),
  } as never);
}

async function createChecklistTask(
  environment: CloudflareEnvironment,
  name: string,
) {
  const service = new TaskService(environment);
  const templateId = await service.createTemplate(administrator, {
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
  return (
    await service.assignTemplate(
      administrator,
      templateId,
      "person-demo-speaker",
    )
  ).taskId;
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
});

describe("administrator task filters", () => {
  it("defaults to assigned work and validates URL-addressable workspace views", async () => {
    await expect(load()).resolves.toMatchObject({ view: "assigned" });
    await expect(load("?view=plans")).resolves.toMatchObject({ view: "plans" });
    await expect(load("?view=templates")).resolves.toMatchObject({
      view: "templates",
    });
  });

  it("applies the supported status, scope, type and impact filters", async () => {
    const completed = await load(
      "?state=completed&target=speaker&type=short_form&impact=high",
    );
    expect(completed.filters).toEqual({
      task: "",
      state: "completed",
      target: "speaker",
      type: "short_form",
      impact: "high",
    });
    expect(completed.tasks.length).toBeGreaterThan(0);
    expect(
      completed.tasks.every(
        (task) =>
          task.status === "completed" &&
          task.targetType === "speaker" &&
          task.taskType === "short_form" &&
          task.impact === "high",
      ),
    ).toBe(true);

    const incomplete = await load("?state=open");
    expect(incomplete.tasks.length).toBeGreaterThan(0);
    expect(
      incomplete.tasks.every((task) =>
        [
          "not_started",
          "in_progress",
          "blocked",
          "submitted",
          "overdue",
        ].includes(task.status),
      ),
    ).toBe(true);

    await workerEnv.DB.prepare(
      `UPDATE task_instances
          SET due_at = unixepoch() - 60
        WHERE id = 'task-demo-handbook' AND event_id = ?`,
    )
      .bind(eventId)
      .run();
    try {
      const overdue = await load("?state=overdue");
      expect(overdue.tasks.map((task) => task.id)).toContain(
        "task-demo-handbook",
      );
      expect(overdue.tasks.every((task) => task.isOverdue)).toBe(true);
    } finally {
      await workerEnv.DB.prepare(
        `UPDATE task_instances
            SET due_at = unixepoch('2027-05-12T16:00:00Z')
          WHERE id = 'task-demo-handbook' AND event_id = ?`,
      )
        .bind(eventId)
        .run();
    }
  });

  it("keeps administrator-only session work in readiness after every participant declines", async () => {
    const before = await load();
    const sessionId = crypto.randomUUID();
    const administratorTaskId = crypto.randomUUID();
    const participantTaskId = crypto.randomUUID();
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status,
           visibility, revision, created_at, updated_at
         ) VALUES (?, ?, 'Declined session with organiser work', ?,
                   'presentation', 30, 'unscheduled', 'private', 1,
                   unixepoch(), unixepoch())`,
      ).bind(sessionId, eventId, `declined-admin-work-${sessionId}`),
      workerEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_revision,
           participation_declined_at, visibility
         ) VALUES (?, ?, 'person-demo-speaker', 0, 'Speaker', 'declined', 1,
                   unixepoch(), 'private')`,
      ).bind(sessionId, eventId),
      workerEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, description,
           task_type, impact, evidence_mode, configuration_json, status,
           readiness_state, readiness_percent, revision, due_at,
           created_at, updated_at
         ) VALUES (?, ?, 'session', ?, 'Resolve organiser follow-up',
                   'This remains operational after participant decline.',
                   'administrator_only', 'critical', 'admin_approval', '{}',
                   'overdue', 'overdue', 0, 1, unixepoch() - 60,
                   unixepoch(), unixepoch())`,
      ).bind(administratorTaskId, eventId, sessionId),
      workerEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, description,
           task_type, impact, evidence_mode, configuration_json, status,
           readiness_state, readiness_percent, revision, due_at,
           created_at, updated_at
         ) VALUES (?, ?, 'session', ?, 'Participant follow-up',
                   'This is inactive after every participant declines.',
                   'checklist', 'critical', 'checkbox', '{}', 'overdue',
                   'overdue', 0, 1, unixepoch() - 60,
                   unixepoch(), unixepoch())`,
      ).bind(participantTaskId, eventId, sessionId),
    ]);

    const after = await load();
    expect(after.taskSummary.outstanding).toBe(
      before.taskSummary.outstanding + 1,
    );
    expect(after.taskSummary.overdue).toBe(before.taskSummary.overdue + 1);
    expect(
      after.tasks.find((task) => task.id === administratorTaskId),
    ).toMatchObject({
      participantActionable: false,
      readinessRelevant: true,
    });
    expect(
      after.tasks.find((task) => task.id === participantTaskId),
    ).toMatchObject({
      participantActionable: false,
      readinessRelevant: false,
    });
  });

  it.each([
    "?view=unknown",
    "?view=plans&view=templates",
    "?state=incomplete",
    "?state=unknown",
    "?target=person",
    "?type=upload",
    "?impact=urgent",
    "?state=open&state=completed",
  ])("fails fast for invalid task filters: %s", async (search) => {
    await expect(load(search)).rejects.toMatchObject({ status: 400 });
  });

  it("replays one assignment POST intent without duplicating its audit or webhook work", async () => {
    const queued: unknown[] = [];
    const testEnv = routeEnvironment(queued);
    const workspace = await loader({
      request: adminRequest(),
      params: {},
      context: context(testEnv),
    } as never);
    const target = workspace.speakers[0]!;
    const service = new TaskService(testEnv);
    const suffix = crypto.randomUUID();
    const templateId = await service.createTemplate(
      administrator,
      {
        name: `Route exact assignment ${suffix}`,
        description: "Assign exactly once across a retried browser POST.",
        targetType: "speaker",
        taskType: "checklist",
        impact: "high",
        evidenceMode: "checkbox",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [],
      },
      `template-${suffix}`,
    );
    const endpointId = `route-task-webhook-${suffix}`;
    await testEnv.DB.prepare(
      `INSERT INTO webhook_endpoints (
         id, organisation_id, event_id, name, url, secret_ciphertext,
         event_types_json, status, created_by_person_id
       ) VALUES (?, ?, ?, 'Route task events',
                 'https://hooks.example.com/route-task', 'test-only',
                 '["task.created"]', 'active', ?)`,
    )
      .bind(
        endpointId,
        administrator.organisationId,
        administrator.eventId,
        administrator.personId,
      )
      .run();
    const intentId = crypto.randomUUID();
    const values = {
      intent: "assign",
      assignIntentId: intentId,
      templateId,
      targetId: target.id,
    };
    const invoke = () =>
      action({
        request: adminPost(values),
        params: {},
        context: context(testEnv),
      } as never);

    const first = await invoke();
    const replay = await invoke();
    if (first instanceof Response || replay instanceof Response) {
      throw new Error("Task assignment action returned a raw response.");
    }
    expect(replay.data).toEqual(first.data);
    await expect(
      testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM task_instances task
             WHERE task.event_id = ? AND task.template_id = ?
               AND task.target_type = 'speaker' AND task.target_id = ?) AS taskCount,
           (SELECT COUNT(*) FROM audit_events audit
             WHERE audit.event_id = ? AND audit.action = 'task.assigned'
               AND audit.correlation_id = ?) AS auditCount,
           (SELECT COUNT(*) FROM webhook_deliveries delivery
             WHERE delivery.endpoint_id = ? AND delivery.event_type = 'task.created')
             AS deliveryCount,
           (SELECT COUNT(*) FROM operation_jobs operation
             JOIN operation_items item ON item.operation_id = operation.id
            WHERE operation.event_id = ? AND operation.type = 'webhook.deliver'
              AND item.entity_type = 'webhook_delivery'
              AND item.entity_id IN (
                SELECT id FROM webhook_deliveries WHERE endpoint_id = ?
              )) AS operationCount`,
      )
        .bind(
          administrator.eventId,
          templateId,
          target.id,
          administrator.eventId,
          intentId,
          endpointId,
          administrator.eventId,
          endpointId,
        )
        .first(),
    ).resolves.toEqual({
      taskCount: 1,
      auditCount: 1,
      deliveryCount: 1,
      operationCount: 1,
    });
    await testEnv.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?")
      .bind(endpointId)
      .run();
  });

  it("does not default a missing required task type during creation", async () => {
    const result = await action({
      request: adminPost({
        intent: "create-template",
        intentId: crypto.randomUUID(),
        name: "Missing task type",
        description: "This request intentionally omits taskType.",
        targetType: "speaker",
        impact: "medium",
        evidenceMode: "checkbox",
        dueAnchor: "none",
        dueOffsetDays: "",
        fixedDueDate: "",
      }),
      params: {},
      context: context(),
    } as never);

    expect(result.data).toMatchObject({ ok: false });
    expect(result.init?.status).toBe(422);
  });

  it("retains a non-structured template draft after validation fails", async () => {
    const result = await action({
      request: adminPost({
        intent: "create-template",
        intentId: crypto.randomUUID(),
        name: "x",
        description: "Retain these entered checklist details.",
        targetType: "speaker",
        taskType: "checklist",
        impact: "medium",
        evidenceMode: "checkbox",
        dueAnchor: "none",
        dueOffsetDays: "",
        fixedDueDate: "",
        formFieldsJson: "[]",
      }),
      params: {},
      context: context(),
    } as never);

    expect(result.init?.status).toBe(422);
    expect(result.data).toMatchObject({
      ok: false,
      draft: {
        name: "x",
        description: "Retain these entered checklist details.",
        targetType: "speaker",
        taskType: "checklist",
        impact: "medium",
        evidenceMode: "checkbox",
      },
    });
  });

  it("rejects a select question with more than 20 visible options", async () => {
    const result = await action({
      request: adminPost({
        intent: "create-template",
        intentId: crypto.randomUUID(),
        name: "Overlong option list",
        description: "Reject options that cannot be saved as shown.",
        targetType: "speaker",
        taskType: "short_form",
        impact: "medium",
        evidenceMode: "text",
        dueAnchor: "none",
        dueOffsetDays: "",
        fixedDueDate: "",
        formFieldsJson: JSON.stringify([
          {
            id: "support_level",
            label: "Support level",
            type: "select",
            required: true,
            help: "",
            options: Array.from(
              { length: 21 },
              (_value, index) => `Option ${index + 1}`,
            ),
          },
        ]),
      }),
      params: {},
      context: context(),
    } as never);

    expect(result.init?.status).toBe(422);
    expect(result.data).toMatchObject({
      ok: false,
      message: "Select fields support at most 20 options.",
    });
  });

  it("creates an organiser-authored structured short-form task", async () => {
    const intentId = crypto.randomUUID();
    const fields = [
      {
        id: "needs_av",
        label: "Do you need event AV support?",
        type: "boolean",
        required: true,
        help: "Confirm whether the production team should contact you.",
        options: [],
      },
      {
        id: "av_details",
        label: "Describe the required support",
        type: "long_text",
        required: false,
        help: "Include connectors or playback requirements.",
        options: [],
        requiredWhen: { fieldId: "needs_av", equals: true },
      },
    ];
    const result = await action({
      request: adminPost({
        intent: "create-template",
        intentId,
        name: "Audio visual requirements",
        description: "Collect the participant's AV requirements.",
        targetType: "speaker",
        taskType: "short_form",
        impact: "high",
        evidenceMode: "text",
        dueAnchor: "acceptance",
        dueOffsetDays: "7",
        fixedDueDate: "",
        formFieldsJson: JSON.stringify(fields),
      }),
      params: {},
      context: context(),
    } as never);

    expect(result.data).toMatchObject({
      committed: true,
      intent: "create-template",
    });
    await expect(
      workerEnv.DB.prepare(
        `SELECT configuration_json AS configurationJson
           FROM task_templates
          WHERE event_id = ? AND name = ?`,
      )
        .bind(eventId, "Audio visual requirements")
        .first<{ configurationJson: string }>(),
    ).resolves.toEqual({
      configurationJson: JSON.stringify({ form: { fields } }),
    });
  });

  it("does not replace client-held task questions when their JSON is invalid", async () => {
    const result = await action({
      request: adminPost({
        intent: "create-template",
        intentId: crypto.randomUUID(),
        name: "Audio visual requirements",
        description: "Collect the participant's AV requirements.",
        targetType: "speaker",
        taskType: "short_form",
        impact: "high",
        evidenceMode: "text",
        dueAnchor: "acceptance",
        dueOffsetDays: "7",
        fixedDueDate: "",
        formFieldsJson: JSON.stringify([
          {
            id: "needs_av",
            label: "",
            type: "boolean",
            required: true,
            help: "",
            options: [],
          },
        ]),
      }),
      params: {},
      context: context(),
    } as never);

    expect(result.init?.status).toBe(422);
    expect(result.data).toMatchObject({ ok: false });
    expect(
      "draft" in result.data ? result.data.draft : undefined,
    ).toBeUndefined();
  });
});

describe("administrator task actions", () => {
  it("reopens a completed task when the form omits the optional reason", async () => {
    const queued: unknown[] = [];
    const testEnv = routeEnvironment(queued);
    const taskId = await createChecklistTask(
      testEnv,
      `Route reopen without reason ${crypto.randomUUID()}`,
    );
    await testEnv.DB.prepare(
      `UPDATE task_instances
          SET status = 'completed', readiness_state = 'on_track',
              readiness_percent = 100, completed_at = unixepoch(),
              completed_by_person_id = ?
        WHERE id = ? AND event_id = ?`,
    )
      .bind(administrator.personId, taskId, administrator.eventId)
      .run();

    const result = await action({
      request: adminPost({
        intent: "reopen",
        taskId,
        revision: "1",
      }),
      params: {},
      context: context(testEnv),
    } as never);

    if (result instanceof Response) {
      throw new Error("Task reopen returned a raw response.");
    }
    expect(result.data).toMatchObject({
      ok: true,
      message: "Task reopened.",
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT status, readiness_percent AS readinessPercent, revision,
                completed_at AS completedAt,
                completed_by_person_id AS completedByPersonId
           FROM task_instances WHERE id = ? AND event_id = ?`,
      )
        .bind(taskId, administrator.eventId)
        .first(),
    ).resolves.toEqual({
      status: "not_started",
      readinessPercent: 0,
      revision: 2,
      completedAt: null,
      completedByPersonId: null,
    });
  });

  it("still rejects a waiver when the form omits its required reason", async () => {
    const queued: unknown[] = [];
    const testEnv = routeEnvironment(queued);
    const taskId = await createChecklistTask(
      testEnv,
      `Route waiver without reason ${crypto.randomUUID()}`,
    );

    const result = await action({
      request: adminPost({
        intent: "waive",
        taskId,
        revision: "1",
      }),
      params: {},
      context: context(testEnv),
    } as never);

    if (result instanceof Response) {
      throw new Error("Task waiver returned a raw response.");
    }
    expect(result.data).toMatchObject({
      ok: false,
      message: "Explain why this requirement is being waived.",
    });
    expect(result.init?.status).toBe(409);
    await expect(
      testEnv.DB.prepare(
        `SELECT status, revision FROM task_instances
          WHERE id = ? AND event_id = ?`,
      )
        .bind(taskId, administrator.eventId)
        .first(),
    ).resolves.toEqual({ status: "not_started", revision: 1 });
  });
});
