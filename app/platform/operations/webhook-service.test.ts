import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { signWebhookPayload } from "~/platform/operations/webhook-crypto.server";
import { resolveWebhookHostname } from "~/platform/operations/webhook-endpoint-service.server";
import {
  validateWebhookDestination,
  validateWebhookUrl,
  WebhookAuditOriginRequiredError,
  WebhookEndpointCredentialsErasedError,
  WebhookEventIdempotencyConflictError,
  WebhookQueueConfigurationError,
  WebhookService,
  webhookActorForAudit,
} from "~/platform/operations/webhook-service.server";
import { processWebhookDelivery } from "../../../workers/queue/webhook-delivery-handler";

const viewer: Viewer & { auditOrigin: "admin_ui" } = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
  auditOrigin: "admin_ui",
};

const credentialKey = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)),
);
const publicResolver = async () => ["93.184.216.34"];

describe("outbound webhooks", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare("DELETE FROM webhook_endpoints WHERE event_id = ?")
      .bind(viewer.eventId)
      .run();
  });

  it("rejects non-public destinations at configuration and delivery time", async () => {
    expect(() => validateWebhookUrl("http://hooks.example.com/events")).toThrow(
      "HTTPS",
    );
    expect(() => validateWebhookUrl("https://127.0.0.1/events")).toThrow(
      "public DNS",
    );
    expect(() => validateWebhookUrl("https://192.0.2.1/events")).toThrow(
      "public DNS",
    );
    expect(() => validateWebhookUrl("https://93.184.216.34/events")).toThrow(
      "public DNS",
    );
    expect(() => validateWebhookUrl("https://service.internal/events")).toThrow(
      "public DNS",
    );
    await expect(
      validateWebhookDestination(
        "https://hooks.example.com/events",
        async () => ["93.184.216.34", "127.0.0.1"],
      ),
    ).rejects.toThrow("only to public network addresses");
    for (const address of [
      "192.88.99.1",
      "2001::1",
      "2002:5db8:d822::1",
      "2001:db8::1",
    ]) {
      await expect(
        validateWebhookDestination(
          "https://hooks.example.com/events",
          async () => [address],
        ),
      ).rejects.toThrow("only to public network addresses");
    }
    await expect(
      validateWebhookDestination(
        "https://hooks.example.com/events",
        publicResolver,
      ),
    ).resolves.toBe("https://hooks.example.com/events");
  });

  it("fails closed when either DNS address-family lookup is unavailable", async () => {
    const partialFetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get("type") === "A") {
        return new Response(null, { status: 503 });
      }
      return Response.json({
        Status: 0,
        Answer: [{ type: 28, data: "2606:4700:4700::1111" }],
      });
    }) as unknown as typeof fetch;
    await expect(
      resolveWebhookHostname("hooks.example.com", partialFetcher),
    ).rejects.toThrow("HTTP 503");

    const failedDnsFetcher = vi.fn(async () =>
      Response.json({
        Status: 2,
        Answer: [{ type: 1, data: "93.184.216.34" }],
      }),
    ) as unknown as typeof fetch;
    await expect(
      resolveWebhookHostname("hooks.example.com", failedDnsFetcher),
    ).rejects.toThrow("DNS status 2");
  });

  it("does not re-enable an endpoint whose signing secret was erased", async () => {
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: { send: async () => undefined },
    } as unknown as CloudflareEnvironment;
    const service = new WebhookService(testEnv);
    const created = await service.create(viewer, {
      name: `Erased secret ${crypto.randomUUID()}`,
      url: "https://hooks.example.com/erased",
      eventTypes: ["submission.created"],
    });
    await testEnv.DB.prepare(
      `UPDATE webhook_endpoints
          SET status = 'disabled', secret_ciphertext = 'retained-' || id
        WHERE id = ? AND event_id = ?`,
    )
      .bind(created.id, viewer.eventId)
      .run();
    await expect(
      service.setStatus(viewer, created.id, "active"),
    ).rejects.toBeInstanceOf(WebhookEndpointCredentialsErasedError);
    await expect(service.list(viewer)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.id,
          status: "disabled",
          credentialsErased: true,
        }),
      ]),
    );
    await expect(service.queueTest(viewer, created.id)).rejects.toBeInstanceOf(
      WebhookEndpointCredentialsErasedError,
    );
    await expect(
      testEnv.DB.prepare(
        "SELECT COUNT(*) AS total FROM webhook_deliveries WHERE endpoint_id = ?",
      )
        .bind(created.id)
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
  });

  it("fails fast when a person-originated event omits its audit origin", async () => {
    const service = new WebhookService(env as unknown as CloudflareEnvironment);
    const actorWithoutOrigin = {
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      personId: viewer.personId,
    } as Parameters<WebhookService["queueEvent"]>[0];

    await expect(
      service.queueEvent(actorWithoutOrigin, {
        eventType: "submission.submitted",
        entityType: "submission",
        entityId: "submission-missing-audit-origin",
        idempotencyKey: `submission.submitted:${crypto.randomUUID()}`,
        correlationId: crypto.randomUUID(),
        data: { revision: 1 },
      }),
    ).rejects.toBeInstanceOf(WebhookAuditOriginRequiredError);
  });

  it("preserves an explicit public-form origin without inventing a person actor", async () => {
    const correlationId = crypto.randomUUID();
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: { send: async () => undefined },
    } as unknown as CloudflareEnvironment;
    const service = new WebhookService(testEnv);
    await service.create(viewer, {
      name: `Public form ${crypto.randomUUID()}`,
      url: "https://hooks.example.com/public-form",
      eventTypes: ["submission.created"],
    });

    await service.queueEvent(
      webhookActorForAudit(
        {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          personId: null,
        },
        "public_form",
      ),
      {
        eventType: "submission.created",
        entityType: "submission",
        entityId: `submission-${crypto.randomUUID()}`,
        idempotencyKey: `submission.created:${crypto.randomUUID()}`,
        correlationId,
        data: { status: "draft" },
      },
    );

    await expect(
      testEnv.DB.prepare(
        `SELECT actor_kind AS actorKind, origin,
                actor_person_id AS actorPersonId
           FROM audit_events
          WHERE event_id = ? AND action = 'webhook.queued'
            AND correlation_id = ?`,
      )
        .bind(viewer.eventId, correlationId)
        .first(),
    ).resolves.toEqual({
      actorKind: "system",
      origin: "public_form",
      actorPersonId: null,
    });
  });

  it("encrypts endpoint secrets and records a verifiably signed successful test", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment & {
      WEBHOOK_CREDENTIALS_KEY: string;
    };
    const service = new WebhookService(testEnv);
    const endpoint = await service.create(viewer, {
      name: "Analytics",
      url: "https://hooks.example.com/program-cue",
      eventTypes: ["submission.submitted", "schedule.published"],
    });
    const stored = await env.DB.prepare(
      "SELECT secret_ciphertext AS ciphertext FROM webhook_endpoints WHERE id = ?",
    )
      .bind(endpoint.id)
      .first<{ ciphertext: string }>();
    expect(stored?.ciphertext).toMatch(/^v2:/u);
    expect(stored?.ciphertext).not.toContain(endpoint.secret);

    const operation = await service.queueTest(viewer, endpoint.id);
    expect(queued).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT dispatched_at IS NOT NULL AS dispatched FROM operation_jobs WHERE id = ?",
      )
        .bind(operation.operationId)
        .first(),
    ).toEqual({ dispatched: 1 });
    await expect(service.dispatchPendingEvents()).resolves.toEqual({
      queued: 0,
      queueFailed: 0,
    });
    expect(queued).toHaveLength(1);
    const requests: Request[] = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(null, {
          status: 204,
          headers: { "x-request-id": "provider-request-1" },
        });
      },
    );
    await processWebhookDelivery(queued[0], testEnv, fetcher, publicResolver);

    expect(fetcher).toHaveBeenCalledOnce();
    const request = requests[0];
    if (!request) throw new Error("The webhook request was not captured.");
    const timestamp = Number(request.headers.get("program-cue-timestamp"));
    const body = await request.text();
    expect(request.headers.get("program-cue-delivery")).toBe(
      operation.deliveryId,
    );
    expect(request.headers.get("program-cue-event")).toBe("program_cue.test");
    expect(request.headers.get("program-cue-signature")).toBe(
      `v1=${await signWebhookPayload(endpoint.secret, timestamp, body)}`,
    );
    expect(
      await env.DB.prepare(
        `SELECT status, progress_completed AS completed, progress_failed AS failed
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operation.operationId)
        .first(),
    ).toEqual({ status: "completed", completed: 1, failed: 0 });
    expect(
      await env.DB.prepare(
        "SELECT status, attempt_count AS attemptCount FROM webhook_deliveries WHERE id = ?",
      )
        .bind(operation.deliveryId)
        .first(),
    ).toEqual({ status: "delivered", attemptCount: 1 });
  });

  it("uses endpoint authority committed before the delivery claim", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment & {
      WEBHOOK_CREDENTIALS_KEY: string;
    };
    const service = new WebhookService(testEnv);
    const endpoint = await service.create(viewer, {
      name: "Rotated receiver",
      url: "https://hooks.example.com/rotated",
      eventTypes: ["submission.submitted"],
    });
    const operation = await service.queueTest(viewer, endpoint.id);

    let releaseClaim!: () => void;
    const claimReleased = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimReachedResolve!: () => void;
    const claimReached = new Promise<void>((resolve) => {
      claimReachedResolve = resolve;
    });
    let interceptedClaim = false;
    const delayedDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!interceptedClaim) {
              interceptedClaim = true;
              claimReachedResolve();
              await claimReleased;
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const workerEnv = { ...testEnv, DB: delayedDb } as typeof testEnv;
    const requests: Request[] = [];
    const worker = processWebhookDelivery(
      queued[0],
      workerEnv,
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 204 });
      }),
      publicResolver,
    );
    await claimReached;
    const rotated = await service.rotateSecret(viewer, endpoint.id);
    releaseClaim();
    await worker;

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("The webhook request was not captured.");
    const timestamp = Number(request.headers.get("program-cue-timestamp"));
    const body = await request.text();
    expect(request.headers.get("program-cue-signature")).toBe(
      `v1=${await signWebhookPayload(rotated.secret, timestamp, body)}`,
    );
    expect(request.headers.get("program-cue-signature")).not.toBe(
      `v1=${await signWebhookPayload(endpoint.secret, timestamp, body)}`,
    );
    await expect(
      env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
        .bind(operation.operationId)
        .first(),
    ).resolves.toEqual({ status: "completed" });
  });

  it("does not contact an endpoint disabled before the delivery claim", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment & {
      WEBHOOK_CREDENTIALS_KEY: string;
    };
    const service = new WebhookService(testEnv);
    const endpoint = await service.create(viewer, {
      name: "Disabled receiver",
      url: "https://hooks.example.com/disabled",
      eventTypes: ["submission.submitted"],
    });
    const operation = await service.queueTest(viewer, endpoint.id);

    let releaseClaim!: () => void;
    const claimReleased = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimReachedResolve!: () => void;
    const claimReached = new Promise<void>((resolve) => {
      claimReachedResolve = resolve;
    });
    let interceptedClaim = false;
    const delayedDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!interceptedClaim) {
              interceptedClaim = true;
              claimReachedResolve();
              await claimReleased;
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const worker = processWebhookDelivery(
      queued[0],
      { ...testEnv, DB: delayedDb } as typeof testEnv,
      fetcher,
      publicResolver,
    );
    await claimReached;
    try {
      await service.setStatus(viewer, endpoint.id, "disabled");
    } finally {
      releaseClaim();
    }
    await worker;

    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      env.DB.prepare(
        "SELECT status, last_error AS lastError FROM operation_jobs WHERE id = ?",
      )
        .bind(operation.operationId)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      lastError: "The webhook endpoint was disabled before delivery.",
    });
  });

  it("records provider failure honestly and leaves the operation retryable", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment & {
      WEBHOOK_CREDENTIALS_KEY: string;
    };
    const service = new WebhookService(testEnv);
    const endpoint = await service.create(viewer, {
      name: "Failing receiver",
      url: "https://hooks.example.com/fail",
      eventTypes: ["submission.submitted"],
    });
    const operation = await service.queueTest(viewer, endpoint.id);
    const failingFetcher = vi.fn(
      async () => new Response("try later", { status: 503 }),
    );
    await processWebhookDelivery(
      queued[0],
      testEnv,
      failingFetcher,
      publicResolver,
    );
    // Queue delivery is at-least-once. A duplicate after the owned failure was
    // committed must wait for the operator retry transition instead of issuing
    // a second POST by claiming the terminal operation directly.
    await processWebhookDelivery(
      queued[0],
      testEnv,
      failingFetcher,
      publicResolver,
    );
    expect(failingFetcher).toHaveBeenCalledOnce();

    expect(
      await env.DB.prepare(
        "SELECT status, last_error AS lastError FROM operation_jobs WHERE id = ?",
      )
        .bind(operation.operationId)
        .first(),
    ).toEqual({
      status: "failed",
      lastError: "Webhook endpoint returned HTTP 503.",
    });
    expect(
      await env.DB.prepare(
        "SELECT status, failure_count AS failureCount FROM webhook_endpoints WHERE id = ?",
      )
        .bind(endpoint.id)
        .first(),
    ).toEqual({ status: "failing", failureCount: 1 });
    expect((await service.list(viewer))[0]?.latestDelivery).toMatchObject({
      id: operation.deliveryId,
      status: "failed",
      attemptCount: 1,
      operationId: operation.operationId,
    });

    const eventDeliveries = await service.queueEvent(viewer, {
      eventType: "submission.submitted",
      entityType: "submission",
      entityId: "submission-after-transient-webhook-failure",
      idempotencyKey: `submission.submitted:${crypto.randomUUID()}`,
      correlationId: crypto.randomUUID(),
      data: { revision: 1 },
    });
    expect(eventDeliveries).toHaveLength(1);
    expect(eventDeliveries[0]).toMatchObject({
      endpointId: endpoint.id,
      status: "queued",
    });

    const recoveryTest = await service.queueTest(
      viewer,
      endpoint.id,
      `recovery-${crypto.randomUUID()}`,
    );
    const recoveryMessage = queued.find(
      (message) =>
        (message as { operationId?: string }).operationId ===
        recoveryTest.operationId,
    );
    await processWebhookDelivery(
      recoveryMessage,
      testEnv,
      vi.fn(async () => new Response(null, { status: 204 })),
      publicResolver,
    );
    await expect(
      env.DB.prepare(
        "SELECT status, failure_count AS failureCount FROM webhook_endpoints WHERE id = ?",
      )
        .bind(endpoint.id)
        .first(),
    ).resolves.toEqual({ status: "active", failureCount: 0 });
  });

  it("fails fast when an active endpoint has no operations Queue binding", async () => {
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment & {
      WEBHOOK_CREDENTIALS_KEY: string;
    };
    const service = new WebhookService(testEnv);
    const endpoint = await service.create(viewer, {
      name: "Unqueueable receiver",
      url: "https://hooks.example.com/unqueueable",
      eventTypes: ["submission.submitted"],
    });

    await expect(service.queueTest(viewer, endpoint.id)).rejects.toBeInstanceOf(
      WebhookQueueConfigurationError,
    );

    await expect(
      service.queueEvent(viewer, {
        eventType: "submission.submitted",
        entityType: "submission",
        entityId: "submission-without-queue",
        idempotencyKey: `submission.submitted:${crypto.randomUUID()}`,
        correlationId: crypto.randomUUID(),
        data: { revision: 1 },
      }),
    ).rejects.toBeInstanceOf(WebhookQueueConfigurationError);
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE endpoint_id = ?",
      )
        .bind(endpoint.id)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("records a genuine Queue rejection and returns an honest retryable status", async () => {
    const send = vi.fn(async () => {
      throw new Error("Queue transport rejected the message.");
    });
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: { send },
    } as unknown as CloudflareEnvironment & {
      WEBHOOK_CREDENTIALS_KEY: string;
    };
    const service = new WebhookService(testEnv);
    const endpoint = await service.create(viewer, {
      name: "Transient queue receiver",
      url: "https://hooks.example.com/transient-queue",
      eventTypes: ["submission.submitted"],
    });
    const input = {
      eventType: "submission.submitted",
      entityType: "submission",
      entityId: "submission-with-queue-rejection",
      idempotencyKey: `submission.submitted:${crypto.randomUUID()}`,
      correlationId: crypto.randomUUID(),
      data: { revision: 1 },
    } as const;

    const [failure] = await service.queueEvent(viewer, input);
    expect(failure).toMatchObject({
      endpointId: endpoint.id,
      status: "queue_failed",
      duplicate: false,
    });
    await expect(
      env.DB.prepare(
        "SELECT status, last_error AS lastError FROM operation_jobs WHERE id = ?",
      )
        .bind(failure?.operationId)
        .first(),
    ).resolves.toEqual({
      status: "queue_failed",
      lastError: "Queue transport rejected the message.",
    });

    await expect(service.queueEvent(viewer, input)).resolves.toEqual([
      expect.objectContaining({
        operationId: failure?.operationId,
        status: "queue_failed",
        duplicate: true,
      }),
    ]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("returns terminal duplicate operations without enqueueing them again", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment & {
      WEBHOOK_CREDENTIALS_KEY: string;
    };
    const service = new WebhookService(testEnv);
    await service.create(viewer, {
      name: "Terminal replay receiver",
      url: "https://hooks.example.com/terminal-replay",
      eventTypes: ["speaker.updated"],
    });
    const terminalStatuses = [
      "completed",
      "partially_failed",
      "failed",
      "cancelled",
    ] as const;

    for (const status of terminalStatuses) {
      const input = {
        eventType: "speaker.updated",
        entityType: "speaker",
        entityId: `speaker-${status}`,
        idempotencyKey: `speaker.updated:${status}:${crypto.randomUUID()}`,
        correlationId: crypto.randomUUID(),
        data: { revision: 2 },
      } as const;
      const [created] = await service.queueEvent(viewer, input);
      await env.DB.prepare(
        "UPDATE operation_jobs SET status = ? WHERE id = ? AND event_id = ?",
      )
        .bind(status, created?.operationId, viewer.eventId)
        .run();

      await expect(
        service.queueEvent(viewer, {
          ...input,
          correlationId: crypto.randomUUID(),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          operationId: created?.operationId,
          status,
          duplicate: true,
        }),
      ]);
    }
    expect(queued).toHaveLength(terminalStatuses.length);
  });

  it("rejects reuse of an event idempotency key for different content", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    const service = new WebhookService(testEnv);
    await service.create(viewer, {
      name: `Content-bound ${crypto.randomUUID()}`,
      url: "https://hooks.example.com/content-bound",
      eventTypes: ["speaker.updated"],
    });
    const idempotencyKey = `speaker.updated:${crypto.randomUUID()}`;
    const first = await service.queueEvent(viewer, {
      eventType: "speaker.updated",
      entityType: "speaker",
      entityId: "speaker-content-bound",
      idempotencyKey,
      correlationId: crypto.randomUUID(),
      data: { revision: 2, status: "published" },
    });

    await expect(
      service.queueEvent(viewer, {
        eventType: "speaker.updated",
        entityType: "speaker",
        entityId: "speaker-content-bound",
        idempotencyKey,
        correlationId: crypto.randomUUID(),
        data: { status: "published", revision: 2 },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        operationId: first[0]?.operationId,
        duplicate: true,
      }),
    ]);
    await expect(
      service.queueEvent(viewer, {
        eventType: "speaker.updated",
        entityType: "speaker",
        entityId: "speaker-content-bound",
        idempotencyKey,
        correlationId: crypto.randomUUID(),
        data: { revision: 3, status: "published" },
      }),
    ).rejects.toMatchObject({
      name: WebhookEventIdempotencyConflictError.name,
      operationId: first[0]?.operationId,
    });
    expect(queued).toHaveLength(1);
  });

  it("converges concurrent exact event requests on one durable delivery", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    const service = new WebhookService(testEnv);
    const endpoint = await service.create(viewer, {
      name: `Concurrent ${crypto.randomUUID()}`,
      url: "https://hooks.example.com/concurrent",
      eventTypes: ["speaker.updated"],
    });
    const input = {
      eventType: "speaker.updated",
      entityType: "speaker",
      entityId: "speaker-concurrent",
      idempotencyKey: `speaker.updated:concurrent:${crypto.randomUUID()}`,
      data: { revision: 2 },
    } as const;
    const firstCorrelationId = crypto.randomUUID();
    const secondCorrelationId = crypto.randomUUID();

    const [first, second] = await Promise.all([
      service.queueEvent(viewer, {
        ...input,
        correlationId: firstCorrelationId,
      }),
      service.queueEvent(viewer, {
        ...input,
        correlationId: secondCorrelationId,
      }),
    ]);

    expect(first[0]?.deliveryId).toBe(second[0]?.deliveryId);
    expect(first[0]?.operationId).toBe(second[0]?.operationId);
    expect(first[0]?.status).toBe("queued");
    expect(second[0]?.status).toBe("queued");
    expect([first[0]?.duplicate, second[0]?.duplicate].sort()).toEqual([
      false,
      true,
    ]);
    expect(queued).toHaveLength(1);
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE endpoint_id = ?",
      )
        .bind(endpoint.id)
        .first(),
    ).toEqual({ count: 1 });
    const persistedCorrelation = await testEnv.DB.prepare(
      `SELECT audit.correlation_id AS auditCorrelationId,
              json_extract(delivery.payload_json, '$.correlationId')
                AS payloadCorrelationId
         FROM webhook_deliveries delivery
         JOIN audit_events audit
           ON audit.entity_type = 'webhook_delivery'
          AND audit.entity_id = delivery.id
          AND audit.action = 'webhook.queued'
        WHERE delivery.endpoint_id = ?`,
    )
      .bind(endpoint.id)
      .first<{
        auditCorrelationId: string;
        payloadCorrelationId: string;
      }>();
    expect(persistedCorrelation?.auditCorrelationId).toBe(
      persistedCorrelation?.payloadCorrelationId,
    );
    expect([firstCorrelationId, secondCorrelationId]).toContain(
      persistedCorrelation?.payloadCorrelationId,
    );
  });

  it("materialises a webhook operation in the same batch as its domain audit", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    const service = new WebhookService(testEnv);
    await service.create(viewer, {
      name: `Transactional ${crypto.randomUUID()}`,
      url: "https://hooks.example.com/transactional",
      eventTypes: ["speaker.updated"],
    });
    const auditEventId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const prepared = await service.prepareEventForAudit(
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: viewer.personId,
      },
      {
        eventType: "speaker.updated",
        entityType: "speaker",
        entityId: viewer.personId,
        idempotencyKey: `speaker.updated:transactional:${crypto.randomUUID()}`,
        correlationId,
        data: { revision: 9 },
      },
      auditEventId,
    );

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) VALUES (?, 'person', 'internal', 1, ?, ?, ?, 'speaker.profile.updated', 'person', ?, '{}', unixepoch())`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
      ),
      ...prepared.statements,
    ]);

    await expect(
      testEnv.DB.prepare(
        `SELECT actor_kind AS actorKind, origin, actor_person_id AS actorPersonId
           FROM audit_events
          WHERE event_id = ? AND action = 'webhook.queued'
            AND correlation_id = ?`,
      )
        .bind(viewer.eventId, correlationId)
        .first(),
    ).resolves.toEqual({
      actorKind: "person",
      origin: "internal",
      actorPersonId: viewer.personId,
    });

    expect(queued).toHaveLength(0);
    await expect(service.dispatchPendingEvents()).resolves.toEqual({
      queued: 1,
      queueFailed: 0,
    });
    expect(queued).toHaveLength(1);
  });

  it("does not materialise a prepared event when its domain audit did not commit", async () => {
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: credentialKey,
      OPERATIONS_QUEUE: { send: async () => undefined },
    } as unknown as CloudflareEnvironment;
    const service = new WebhookService(testEnv);
    const endpoint = await service.create(viewer, {
      name: `Guarded ${crypto.randomUUID()}`,
      url: "https://hooks.example.com/guarded",
      eventTypes: ["speaker.updated"],
    });
    const prepared = await service.prepareEventForAudit(
      viewer,
      {
        eventType: "speaker.updated",
        entityType: "speaker",
        entityId: viewer.personId,
        idempotencyKey: `speaker.updated:guarded:${crypto.randomUUID()}`,
        correlationId: crypto.randomUUID(),
        data: { revision: 10 },
      },
      crypto.randomUUID(),
    );

    await testEnv.DB.batch(prepared.statements);
    await expect(
      testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE endpoint_id = ?",
      )
        .bind(endpoint.id)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });
});
