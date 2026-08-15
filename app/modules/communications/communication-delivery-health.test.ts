import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { CommunicationService } from "./communication-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const selectedCommunicationId = "delivery-health-selected";
const otherCommunicationId = "delivery-health-other";

describe("communication delivery health", () => {
  beforeEach(async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM communication_unsubscribes
          WHERE event_id = ? AND address LIKE 'delivery-health-%'`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `DELETE FROM communications
          WHERE event_id = ? AND id IN (?, ?)`,
      ).bind(viewer.eventId, selectedCommunicationId, otherCommunicationId),
      env.DB.prepare(
        `INSERT INTO communications (
           id, event_id, operation_id, idempotency_key, kind, channel, status,
           audience_json, content_snapshot_json, recipient_count,
           created_by_person_id, created_at, updated_at
         ) VALUES (
           ?, ?, 'operation-delivery-health-selected',
           'delivery-health-selected-key', 'transactional', 'email', 'sent',
           '{}', '{}', 10, ?, unixepoch(), unixepoch()
         )`,
      ).bind(selectedCommunicationId, viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT INTO communications (
           id, event_id, operation_id, idempotency_key, kind, channel, status,
           audience_json, content_snapshot_json, recipient_count,
           created_by_person_id, created_at, updated_at
         ) VALUES (
           ?, ?, 'operation-delivery-health-other',
           'delivery-health-other-key', 'transactional', 'email', 'sent',
           '{}', '{}', 2, ?, unixepoch(), unixepoch()
         )`,
      ).bind(otherCommunicationId, viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT INTO communication_deliveries (
           id, event_id, communication_id, recipient_address, recipient_name,
           source_values_json, channel, idempotency_key, status, attempt_count,
           failure_code, failure_message, created_at, updated_at
         )
         SELECT 'delivery-health-' || json_extract(value, '$.status'), ?, ?,
                'delivery-health-' || json_extract(value, '$.status') || '@example.com',
                'Recipient ' || json_extract(value, '$.status'), '{}', 'email',
                'delivery-health-' || json_extract(value, '$.status'),
                json_extract(value, '$.status'), 1,
                json_extract(value, '$.code'), json_extract(value, '$.message'),
                unixepoch(), unixepoch()
           FROM json_each(?)`,
      ).bind(
        viewer.eventId,
        selectedCommunicationId,
        JSON.stringify([
          { status: "queued" },
          { status: "sending" },
          { status: "sent" },
          { status: "delivered" },
          { status: "opened" },
          { status: "clicked" },
          { status: "bounced" },
          { status: "suppressed", code: "provider_suppressed" },
          {
            status: "failed",
            code: "provider_error",
            message: "Provider rejected the request",
          },
          { status: "cancelled" },
        ]),
      ),
      env.DB.prepare(
        `INSERT INTO communication_deliveries (
           id, event_id, communication_id, recipient_address,
           source_values_json, channel, idempotency_key, status,
           created_at, updated_at
         ) VALUES (
           'delivery-health-other-clicked', ?, ?, 'other@example.com', '{}',
           'email', 'delivery-health-other-clicked', 'clicked',
           unixepoch(), unixepoch()
         )`,
      ).bind(viewer.eventId, otherCommunicationId),
      env.DB.prepare(
        `INSERT INTO communication_deliveries (
           id, event_id, communication_id, recipient_address,
           source_values_json, channel, idempotency_key, status,
           failure_code, created_at, updated_at
         ) VALUES (
           'delivery-health-old-failed', ?, ?, 'old@example.com', '{}',
           'email', 'delivery-health-old-failed', 'failed', 'old_failure',
           unixepoch() - (100 * 24 * 60 * 60),
           unixepoch() - (100 * 24 * 60 * 60)
         )`,
      ).bind(viewer.eventId, otherCommunicationId),
      env.DB.prepare(
        `INSERT INTO communication_unsubscribes (
           id, event_id, address, category, reason, created_at
         ) VALUES
           ('delivery-health-unsubscribe', ?, 'delivery-health-recipient@example.com',
            'ad_hoc', 'recipient_unsubscribe', unixepoch()),
           ('delivery-health-provider', ?, 'delivery-health-provider@example.com',
            '*', 'email.suppressed', unixepoch()),
           ('delivery-health-unknown', ?, 'delivery-health-unknown@example.com',
            '*', NULL, unixepoch())`,
      ).bind(viewer.eventId, viewer.eventId, viewer.eventId),
    ]);
  });

  it("reports mutually exclusive latest-state buckets at event or send scope", async () => {
    const service = new CommunicationService(
      env as unknown as CloudflareEnvironment,
    );
    const selected = await service.listDeliveryHealth(viewer, {
      communicationId: selectedCommunicationId,
    });
    expect(selected.scope).toEqual({
      kind: "communication",
      communication: expect.objectContaining({
        id: selectedCommunicationId,
        operationId: "operation-delivery-health-selected",
      }),
    });
    expect(selected.summary).toEqual({
      total: 10,
      pending: 2,
      sent: 1,
      delivered: 3,
      problems: 3,
      cancelled: 1,
    });
    expect(selected.deliveryPage.rows).toHaveLength(10);
    expect(selected.recentProblems).toHaveLength(3);
    expect(selected.recentProblems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          communicationId: selectedCommunicationId,
          operationId: "operation-delivery-health-selected",
        }),
      ]),
    );
    expect(selected.suppressions.recipient).toEqual([
      expect.objectContaining({ reason: "recipient_unsubscribe" }),
    ]);
    expect(selected.suppressions.provider).toEqual([
      expect.objectContaining({ reason: "email.suppressed" }),
    ]);

    const recentEvent = await service.listDeliveryHealth(viewer);
    expect(recentEvent.scope).toEqual({
      kind: "event",
      period: "recent",
      days: 90,
    });
    expect(recentEvent.summary.total).toBe(11);
    expect(recentEvent.summary.delivered).toBe(4);
    expect(recentEvent.recentProblems).toHaveLength(3);
    expect(recentEvent.deliveryPage.rows).toEqual([]);

    const eventLifetime = await service.listDeliveryHealth(viewer, {
      period: "lifetime",
    });
    expect(eventLifetime.scope).toEqual({
      kind: "event",
      period: "lifetime",
      days: null,
    });
    expect(eventLifetime.summary.total).toBe(12);
    expect(eventLifetime.summary.problems).toBe(4);
    expect(eventLifetime.recentProblems).toHaveLength(4);
  });

  it("does not resolve a communication through the wrong organisation", async () => {
    const service = new CommunicationService(
      env as unknown as CloudflareEnvironment,
    );
    const rejected = await service
      .listDeliveryHealth(
        { ...viewer, organisationId: "another-organisation" },
        { communicationId: selectedCommunicationId },
      )
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Response);
    expect((rejected as Response).status).toBe(404);
  });

  it("rejects non-page and out-of-range delivery offsets", async () => {
    const service = new CommunicationService(
      env as unknown as CloudflareEnvironment,
    );
    const unaligned = await service
      .listDeliveryHealth(viewer, {
        communicationId: selectedCommunicationId,
        offset: 1,
      })
      .catch((error: unknown) => error);
    expect(unaligned).toBeInstanceOf(Response);
    expect((unaligned as Response).status).toBe(400);

    const beyondRecipients = await service
      .listDeliveryHealth(viewer, {
        communicationId: selectedCommunicationId,
        offset: 50,
      })
      .catch((error: unknown) => error);
    expect(beyondRecipients).toBeInstanceOf(Response);
    expect((beyondRecipients as Response).status).toBe(404);

    const invalidPeriod = await service
      .listDeliveryHealth(viewer, { period: "forever" as never })
      .catch((error: unknown) => error);
    expect(invalidPeriod).toBeInstanceOf(Response);
    expect((invalidPeriod as Response).status).toBe(400);
  });

  it("fails fast when the delivery aggregate query violates its row contract", async () => {
    const database = {
      prepare(query: string) {
        if (query.includes("SELECT COUNT(*) AS total")) {
          return {
            bind() {
              return { first: async () => null };
            },
          };
        }
        return env.DB.prepare(query);
      },
    };
    const service = new CommunicationService({
      ...(env as unknown as CloudflareEnvironment),
      DB: database,
    } as unknown as CloudflareEnvironment);

    await expect(service.listDeliveryHealth(viewer)).rejects.toThrow(
      "The delivery health aggregate query returned no row.",
    );
  });

  it("bounds each active exclusion category independently", async () => {
    await env.DB.prepare(
      `INSERT INTO communication_unsubscribes (
         id, event_id, address, category, reason, created_at
       )
       SELECT 'delivery-health-bulk-' || value, ?,
              'delivery-health-bulk-' || value || '@example.com',
              'ad_hoc', 'recipient_unsubscribe', unixepoch()
         FROM json_each(?)`,
    )
      .bind(
        viewer.eventId,
        JSON.stringify(Array.from({ length: 35 }, (_, index) => index)),
      )
      .run();

    const health = await new CommunicationService(
      env as unknown as CloudflareEnvironment,
    ).listDeliveryHealth(viewer);
    expect(health.suppressions.recipient).toHaveLength(30);
    expect(health.suppressions.provider).toEqual([
      expect.objectContaining({ reason: "email.suppressed" }),
    ]);
  });
});
