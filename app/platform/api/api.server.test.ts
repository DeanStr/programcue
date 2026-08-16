import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  action as operationsAction,
  loader as operationsLoader,
} from "~/routes/api-operations";
import {
  action as tasksAction,
  loader as tasksLoader,
} from "~/routes/api-tasks";
import {
  type ApiError,
  apiFailure,
  readJson,
  requireApiKey,
  requireApiMethod,
  requireIdempotencyKey,
} from "./api.server";

afterEach(() => vi.restoreAllMocks());

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const eventId = "evt-foe-2025";

function routeContext() {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: env as unknown as CloudflareEnvironment,
    ctx: {} as ExecutionContext,
  });
  return context;
}

async function errorCode(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("scoped API keys", () => {
  it("authorises only the configured tenant, event and scope", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const token = "pc_test_scoped_api_key_123456789";
    await env.DB.prepare(
      `
      INSERT INTO api_keys (
        id, organisation_id, event_id, name, key_prefix, key_hash, scopes_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    `,
    )
      .bind(
        "api-test-scoped",
        "org-future-events",
        "evt-foe-2025",
        "Test key",
        "pc_test_",
        await hash(token),
        JSON.stringify(["operations:read"]),
      )
      .run();

    const request = new Request(
      "https://example.test/api/v1/events/evt-foe-2025/operations",
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    await expect(
      requireApiKey(request, testEnv, "operations:read", "evt-foe-2025"),
    ).resolves.toMatchObject({
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
    });
    await expect(
      requireApiKey(request, testEnv, "tasks:read", "evt-foe-2025"),
    ).rejects.toMatchObject({
      status: 403,
      code: "SCOPE_FORBIDDEN",
    } satisfies Partial<ApiError>);
    await expect(
      requireApiKey(request, testEnv, "operations:read", "another-event"),
    ).rejects.toMatchObject({
      status: 403,
      code: "EVENT_FORBIDDEN",
    } satisfies Partial<ApiError>);

    await env.DB.prepare(
      `UPDATE events SET activation_status = 'provisioning_failed'
        WHERE id = ?`,
    )
      .bind(eventId)
      .run();
    try {
      await expect(
        requireApiKey(request, testEnv, "operations:read", eventId),
      ).rejects.toMatchObject({
        status: 404,
        code: "EVENT_NOT_FOUND",
      } satisfies Partial<ApiError>);
    } finally {
      await env.DB.prepare(
        "UPDATE events SET activation_status = 'active' WHERE id = ?",
      )
        .bind(eventId)
        .run();
    }
  });

  it("fails closed when a stored key claims an unsupported wildcard scope", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const token = "pc_test_wildcard_api_key_123456789";
    await env.DB.prepare(
      `
      INSERT INTO api_keys (
        id, organisation_id, event_id, name, key_prefix, key_hash, scopes_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    `,
    )
      .bind(
        "api-test-wildcard",
        "org-future-events",
        "evt-foe-2025",
        "Unsupported wildcard key",
        "pc_test_",
        await hash(token),
        JSON.stringify(["*"]),
      )
      .run();

    await expect(
      requireApiKey(
        new Request("https://example.test/api/v1/events/evt-foe-2025/tasks", {
          headers: { authorization: `Bearer ${token}` },
        }),
        testEnv,
        "tasks:read",
        "evt-foe-2025",
      ),
    ).rejects.toMatchObject({
      status: 500,
      code: "INVALID_API_KEY_RECORD",
    } satisfies Partial<ApiError>);
  });
});

describe("API method boundaries", () => {
  it("allows the documented mutation method and rejects other action methods", () => {
    expect(() =>
      requireApiMethod(
        new Request("https://example.test/api", { method: "POST" }),
        "POST",
      ),
    ).not.toThrow();
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(() =>
        requireApiMethod(
          new Request("https://example.test/api", { method }),
          "POST",
        ),
      ).toThrowError(
        expect.objectContaining({ status: 405, code: "METHOD_NOT_ALLOWED" }),
      );
    }
  });

  it("stops reading an undeclared-length JSON body at the configured byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://example.test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    await expect(readJson(request, 8)).rejects.toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(cancelled).toBe(true);
  });

  it("accepts JSON parameters but rejects lookalike media types", async () => {
    await expect(
      readJson(
        new Request("https://example.test/api", {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: '{"valid":true}',
        }),
      ),
    ).resolves.toEqual({ valid: true });

    await expect(
      readJson(
        new Request("https://example.test/api", {
          method: "POST",
          headers: { "content-type": "application/jsonp" },
          body: '{"valid":true}',
        }),
      ),
    ).rejects.toMatchObject({
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    } satisfies Partial<ApiError>);
  });

  it("redacts internal errors when APP_ENV is missing or invalid", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const environment of ["unknown", "prodution", ""]) {
      const response = apiFailure(
        new Error("sensitive database details"),
        new Request("https://example.test/api/v1/health"),
        environment,
      );
      await expect(response.json()).resolves.toMatchObject({
        error: { message: "Unexpected server error" },
      });
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "sensitive database details",
    );
    expect(log.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subsystem: "api-request",
          event: "unhandled-error",
        }),
      ]),
    );
  });
});

describe("versioned API route methods", () => {
  it("requires a bounded explicit idempotency key for retryable mutations", () => {
    expect(() =>
      requireIdempotencyKey(
        new Request("https://programcue.test/api/v1/tasks"),
      ),
    ).toThrowError(
      expect.objectContaining({
        status: 422,
        code: "INVALID_IDEMPOTENCY_KEY",
      }),
    );
    expect(
      requireIdempotencyKey(
        new Request("https://programcue.test/api/v1/tasks", {
          headers: { "idempotency-key": "task-request_123" },
        }),
      ),
    ).toBe("task-request_123");
  });

  it("keeps documented GET collection loaders available for authentication", async () => {
    const tasks = await tasksLoader({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/tasks`,
      ),
      params: { eventId },
      context: routeContext(),
    } as never);
    const operations = await operationsLoader({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/operations`,
      ),
      params: { eventId },
      context: routeContext(),
    } as never);

    expect(tasks.status).toBe(401);
    expect(await errorCode(tasks)).toBe("AUTH_REQUIRED");
    expect(operations.status).toBe(401);
    expect(await errorCode(operations)).toBe("AUTH_REQUIRED");
  });

  it("rejects a non-POST task action before mutation", async () => {
    const response = await tasksAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/tasks`,
        {
          method: "DELETE",
        },
      ),
      params: { eventId },
      context: routeContext(),
    } as never);

    expect(response.status).toBe(405);
    expect(await errorCode(response)).toBe("METHOD_NOT_ALLOWED");
  });

  it("reports the service-owned task webhook result without queueing it again", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const suffix = crypto.randomUUID();
    const token = `pc_task_route_${suffix}`;
    await env.DB.prepare(
      `INSERT INTO api_keys (
         id, organisation_id, event_id, name, key_prefix, key_hash,
         scopes_json, created_at
       ) VALUES (?, 'org-future-events', ?, ?, 'pc_task_', ?,
                 '["tasks:write"]', unixepoch())`,
    )
      .bind(
        `api-task-route-${suffix}`,
        eventId,
        `Task route ${suffix}`,
        await hash(token),
      )
      .run();
    const queueEvent = vi.spyOn(WebhookService.prototype, "queueEvent");
    vi.spyOn(
      WebhookService.prototype,
      "dispatchPreparedEvent",
    ).mockResolvedValue([
      {
        endpointId: `endpoint-${suffix}`,
        deliveryId: `delivery-${suffix}`,
        operationId: `operation-${suffix}`,
        status: "queue_failed",
        duplicate: false,
      },
    ]);

    const response = await tasksAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/tasks`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": `task-route-${suffix}`,
          },
          body: JSON.stringify({
            title: "Confirm API task webhook recovery",
            targetType: "event",
            targetId: eventId,
            taskType: "checklist",
            impact: "medium",
          }),
        },
      ),
      params: { eventId },
      context: routeContext(),
    } as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      task: { title: "Confirm API task webhook recovery" },
      webhookDeliveries: [
        {
          endpointId: `endpoint-${suffix}`,
          deliveryId: `delivery-${suffix}`,
          operationId: `operation-${suffix}`,
          status: "queue_failed",
        },
      ],
      webhookWarning:
        "The task was created, but one or more outbound webhook deliveries require retry.",
    });
    expect(queueEvent).not.toHaveBeenCalled();
  });

  it("rejects generic operation creation synchronously because no generic consumer exists", async () => {
    const response = operationsAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/operations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "export.generate",
            idempotencyKey: "generic-export:test",
            payload: { format: "csv" },
          }),
        },
      ),
      params: { eventId },
      context: routeContext(),
    } as never);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(await errorCode(response)).toBe("METHOD_NOT_ALLOWED");
  });
});
