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

beforeEach(async () => {
  await ensureDemoData(workerEnv);
});

describe("administrator task filters", () => {
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

  it.each([
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
});
