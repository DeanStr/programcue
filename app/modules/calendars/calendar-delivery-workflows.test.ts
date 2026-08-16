import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ResendEmailProvider } from "~/modules/communications/resend.server";
import { processCalendarSync } from "../../../workers/communications-queue";
import { calendarQueueMessageSchema } from "./calendar-schema";
import { CalendarService } from "./calendar-service.server";
import {
  scheduledSpeakerEnvironment,
  calendarTestViewer as viewer,
} from "./calendar-service-test-fixture";

describe("calendar delivery workflows", () => {
  it("requires the operations Queue before claiming a calendar lifecycle", async () => {
    const { testEnv, sessionId } = await scheduledSpeakerEnvironment();
    const idempotencyKey = `calendar-missing-queue-${crypto.randomUUID()}`;
    const unavailableEnvironment = {
      ...testEnv,
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;

    await expect(
      new CalendarService(unavailableEnvironment).queueLifecycle(viewer, {
        sessionId,
        personId: "person-demo-speaker",
        method: "REQUEST",
        provider: "email_ics",
        idempotencyKey,
      }),
    ).rejects.toThrow("Required OPERATIONS_QUEUE binding is unavailable");
    await expect(
      testEnv.DB.prepare(
        `SELECT
             (SELECT COUNT(*) FROM operation_jobs WHERE idempotency_key = ?) AS operationCount,
             (SELECT COUNT(*) FROM calendar_invitations
               WHERE event_id = ? AND session_id = ?) AS invitationCount`,
      )
        .bind(idempotencyKey, viewer.eventId, sessionId)
        .first(),
    ).resolves.toEqual({ operationCount: 0, invitationCount: 0 });
  });

  it("persists an email-ICS operation before queueing and records the provider result", async () => {
    const { testEnv, queued, realtime, sessionId } =
      await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const result = await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "email_ics",
      idempotencyKey: `calendar-request-${crypto.randomUUID()}`,
    });
    expect(result).toMatchObject({
      sequence: 0,
      status: "queued",
      duplicate: false,
    });
    expect(queued).toHaveLength(1);
    const before = await env.DB.prepare(
      `
        SELECT ci.status, c.status AS communicationStatus, d.status AS deliveryStatus,
               o.status AS operationStatus, o.cancellable
          FROM calendar_invitations ci
          JOIN communication_deliveries d ON d.id = ci.delivery_id
          JOIN communications c ON c.id = d.communication_id
          JOIN operation_jobs o ON o.id = c.operation_id
         WHERE ci.id = ?
      `,
    )
      .bind(result.invitationId)
      .first();
    expect(before).toEqual({
      status: "queued",
      communicationStatus: "queued",
      deliveryStatus: "queued",
      operationStatus: "queued",
      cancellable: 0,
    });

    let calendarAttachment = "";
    let calendarTags: unknown;
    const provider = new ResendEmailProvider(
      "calendar-provider-key",
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          attachments: Array<{ content: string }>;
          tags?: unknown;
        };
        calendarAttachment = atob(body.attachments[0].content);
        calendarTags = body.tags;
        return Response.json({ id: "resend-calendar-001" });
      },
    );
    await processCalendarSync(queued[0], testEnv, { email: provider });
    expect(calendarAttachment).toContain("METHOD:REQUEST");
    expect(calendarAttachment).toContain("SEQUENCE:0");
    expect(calendarTags).toEqual([
      { name: "program_cue_delivery", value: "tracked" },
    ]);
    expect(realtime).toHaveLength(1);
    expect(realtime[0]).toMatchObject({
      type: "event-change",
      entityType: "calendar_invitation",
      entityId: result.invitationId,
      changeType: "progress",
    });
    const after = await env.DB.prepare(
      `
        SELECT ci.status, ci.sequence_number AS sequenceNumber, c.status AS communicationStatus,
               d.provider_message_id AS providerMessageId, o.status AS operationStatus
          FROM calendar_invitations ci
          JOIN communication_deliveries d ON d.id = ci.delivery_id
          JOIN communications c ON c.id = d.communication_id
          JOIN operation_jobs o ON o.id = c.operation_id
         WHERE ci.id = ?
      `,
    )
      .bind(result.invitationId)
      .first();
    expect(after).toEqual({
      status: "sent",
      sequenceNumber: 0,
      communicationStatus: "sent",
      providerMessageId: "resend-calendar-001",
      operationStatus: "completed",
    });
  });

  it("rejects calendar email provider drift before claiming the delivery or sending", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const result = await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "email_ics",
      idempotencyKey: `calendar-provider-bound-${crypto.randomUUID()}`,
    });
    await testEnv.DB.prepare(
      `UPDATE communication_deliveries
            SET provider = 'mailpit'
          WHERE id = (
            SELECT delivery_id FROM calendar_invitations WHERE id = ?
          )`,
    )
      .bind(result.invitationId)
      .run();
    let providerCalls = 0;
    const provider = new ResendEmailProvider(
      "calendar-provider-drift-key",
      async () => {
        providerCalls += 1;
        return Response.json({ id: "must-not-send-calendar-provider-drift" });
      },
    );

    await processCalendarSync(queued[0], testEnv, { email: provider });

    expect(providerCalls).toBe(0);
    await expect(
      testEnv.DB.prepare(
        `SELECT invitation.status, attempt.status AS attemptStatus,
                  delivery.status AS deliveryStatus, delivery.provider,
                  operation.status AS operationStatus, operation.last_error AS lastError
             FROM calendar_invitations invitation
             JOIN calendar_sync_attempts attempt
               ON attempt.id = invitation.current_attempt_id
             JOIN communication_deliveries delivery
               ON delivery.id = invitation.delivery_id
             JOIN communications communication
               ON communication.id = delivery.communication_id
             JOIN operation_jobs operation
               ON operation.id = communication.operation_id
            WHERE invitation.id = ?`,
      )
        .bind(result.invitationId)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      attemptStatus: "failed",
      deliveryStatus: "failed",
      provider: "mailpit",
      operationStatus: "failed",
      lastError:
        "The calendar email delivery provider does not match its durable intent.",
    });
  });

  it("records a direct-calendar intent before refreshing an expiring provider token", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const connectionId = `calendar-expiring-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO calendar_connections (
           id, organisation_id, event_id, person_id, provider, account_reference,
           encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'person-demo-speaker', 'google', ?, ?, '[]',
                   'connected', unixepoch() + 60, unixepoch(), unixepoch())`,
    )
      .bind(
        connectionId,
        viewer.organisationId,
        viewer.eventId,
        `expiring-${crypto.randomUUID()}`,
        "encrypted-credentials-are-consumed-only-by-the-queue-worker",
      )
      .run();

    const result = await new CalendarService(testEnv).queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "google",
      connectionId,
      idempotencyKey: `calendar-expiring-intent-${crypto.randomUUID()}`,
    });

    expect(queued).toHaveLength(1);
    await expect(
      testEnv.DB.prepare(
        `SELECT operation.status AS operationStatus,
                  invitation.status AS invitationStatus,
                  attempt.status AS attemptStatus
             FROM operation_jobs operation
             JOIN calendar_invitations invitation
               ON invitation.current_attempt_id = ?
             JOIN calendar_sync_attempts attempt
               ON attempt.id = invitation.current_attempt_id
            WHERE operation.id = ? AND operation.event_id = ?`,
      )
        .bind(
          calendarQueueMessageSchema.parse(queued[0]).attemptId,
          result.operationId,
          viewer.eventId,
        )
        .first(),
    ).resolves.toEqual({
      operationStatus: "queued",
      invitationStatus: "queued",
      attemptStatus: "queued",
    });
  });

  it("requires an active invitation to be cancelled before changing its provider or connected account", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const googleConnection = `calendar-google-primary-${crypto.randomUUID()}`;
    const otherGoogleConnection = `calendar-google-other-${crypto.randomUUID()}`;
    const microsoftConnection = `calendar-microsoft-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO calendar_connections (
             id, organisation_id, event_id, person_id, provider, account_reference,
             encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'person-demo-speaker', 'google', ?, 'injected-test-provider',
                     '[]', 'connected', unixepoch() + 3600, unixepoch(), unixepoch())`,
      ).bind(
        googleConnection,
        viewer.organisationId,
        viewer.eventId,
        `google-primary-${crypto.randomUUID()}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO calendar_connections (
             id, organisation_id, event_id, person_id, provider, account_reference,
             encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'person-demo-speaker', 'google', ?, 'injected-test-provider',
                     '[]', 'connected', unixepoch() + 3600, unixepoch(), unixepoch())`,
      ).bind(
        otherGoogleConnection,
        viewer.organisationId,
        viewer.eventId,
        `google-other-${crypto.randomUUID()}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO calendar_connections (
             id, organisation_id, event_id, person_id, provider, account_reference,
             encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'person-demo-speaker', 'microsoft', ?, 'injected-test-provider',
                     '[]', 'connected', unixepoch() + 3600, unixepoch(), unixepoch())`,
      ).bind(
        microsoftConnection,
        viewer.organisationId,
        viewer.eventId,
        `microsoft-${crypto.randomUUID()}`,
      ),
    ]);
    const service = new CalendarService(testEnv);
    const initial = await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "google",
      connectionId: googleConnection,
      idempotencyKey: `calendar-provider-authority-${crypto.randomUUID()}`,
    });

    await expect(
      service.queueLifecycle(viewer, {
        sessionId,
        personId: "person-demo-speaker",
        method: "REQUEST",
        provider: "google",
        connectionId: otherGoogleConnection,
        idempotencyKey: `calendar-account-switch-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow("before changing its provider or connected account");
    await expect(
      service.queueLifecycle(viewer, {
        sessionId,
        personId: "person-demo-speaker",
        method: "REQUEST",
        provider: "microsoft",
        connectionId: microsoftConnection,
        idempotencyKey: `calendar-provider-switch-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow("before changing its provider or connected account");
    expect(queued).toHaveLength(1);
    await expect(
      testEnv.DB.prepare(
        `SELECT connection_id AS connectionId, sequence_number AS sequenceNumber,
                  current_attempt_id AS currentAttemptId
             FROM calendar_invitations WHERE id = ?`,
      )
        .bind(initial.invitationId)
        .first(),
    ).resolves.toEqual({
      connectionId: googleConnection,
      sequenceNumber: 0,
      currentAttemptId: calendarQueueMessageSchema.parse(queued[0]).attemptId,
    });
  });

  it("reclaims an expired calendar claim after a crash before provider delivery", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const result = await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "email_ics",
      idempotencyKey: `calendar-crash-${crypto.randomUUID()}`,
    });

    let committedClaim = false;
    const crashingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            if (!committedClaim) {
              committedClaim = true;
              throw new Error("Injected crash after calendar claim commit");
            }
            return results;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const crashEnv = { ...testEnv, DB: crashingDb } as CloudflareEnvironment;
    let providerCalls = 0;
    const provider = new ResendEmailProvider(
      "calendar-crash-provider-key",
      async () => {
        providerCalls += 1;
        return Response.json({ id: "resend-calendar-crash-recovery" });
      },
    );

    await expect(
      processCalendarSync(queued[0], crashEnv, { email: provider }),
    ).rejects.toThrow("Injected crash after calendar claim commit");
    expect(providerCalls).toBe(0);
    expect(
      await env.DB.prepare(
        `
        SELECT o.status AS operationStatus, o.claim_token IS NOT NULL AS hasClaim,
               o.claim_expires_at > unixepoch() AS leaseActive, csa.status AS attemptStatus
          FROM operation_jobs o
          JOIN calendar_sync_attempts csa ON csa.id = json_extract(o.payload_json, '$.attemptId')
         WHERE o.id = ?
      `,
      )
        .bind(result.operationId)
        .first(),
    ).toEqual({
      operationStatus: "running",
      hasClaim: 1,
      leaseActive: 1,
      attemptStatus: "running",
    });

    await env.DB.prepare(
      `UPDATE operation_jobs SET claim_expires_at = unixepoch() - 1 WHERE id = ?`,
    )
      .bind(result.operationId)
      .run();
    await processCalendarSync(queued[0], testEnv, { email: provider });
    expect(providerCalls).toBe(1);
    expect(
      await env.DB.prepare(
        `
        SELECT o.status AS operationStatus, o.claim_token AS claimToken,
               o.claim_expires_at AS claimExpiresAt, ci.status AS invitationStatus,
               csa.status AS attemptStatus
          FROM operation_jobs o
          JOIN calendar_sync_attempts csa ON csa.id = json_extract(o.payload_json, '$.attemptId')
          JOIN calendar_invitations ci ON ci.id = csa.invitation_id
         WHERE o.id = ?
      `,
      )
        .bind(result.operationId)
        .first(),
    ).toEqual({
      operationStatus: "completed",
      claimToken: null,
      claimExpiresAt: null,
      invitationStatus: "sent",
      attemptStatus: "succeeded",
    });
  });

  it("claims distinct monotonic sequences when lifecycle publications overlap", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const initial = await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "email_ics",
      idempotencyKey: `calendar-initial-${crypto.randomUUID()}`,
    });
    expect(initial.sequence).toBe(0);

    const overlapping = await Promise.all([
      service.queueLifecycle(viewer, {
        sessionId,
        personId: "person-demo-speaker",
        method: "REQUEST",
        provider: "email_ics",
        idempotencyKey: `calendar-overlap-request-${crypto.randomUUID()}`,
      }),
      service.queueLifecycle(viewer, {
        sessionId,
        personId: "person-demo-speaker",
        method: "CANCEL",
        provider: "email_ics",
        idempotencyKey: `calendar-overlap-cancel-${crypto.randomUUID()}`,
      }),
    ]);
    expect(overlapping.map((result) => result.sequence).sort()).toEqual([1, 2]);
    const messages = queued.map((message) =>
      calendarQueueMessageSchema.parse(message),
    );
    expect(messages.map((message) => message.payload.sequence).sort()).toEqual([
      0, 1, 2,
    ]);
    expect(new Set(messages.map((message) => message.attemptId)).size).toBe(3);

    const current = await env.DB.prepare(
      `
        SELECT sequence_number AS sequenceNumber, current_attempt_id AS currentAttemptId
          FROM calendar_invitations WHERE id = ?
      `,
    )
      .bind(initial.invitationId)
      .first<{ sequenceNumber: number; currentAttemptId: string }>();
    const latest = messages.find((message) => message.payload.sequence === 2);
    expect(current).toEqual({
      sequenceNumber: 2,
      currentAttemptId: latest?.attemptId,
    });
  });

  it("deduplicates concurrent requests with the same lifecycle idempotency key", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const idempotencyKey = `calendar-same-${crypto.randomUUID()}`;
    const input = {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST" as const,
      provider: "email_ics" as const,
      idempotencyKey,
    };
    const results = await Promise.all([
      service.queueLifecycle(viewer, input),
      service.queueLifecycle(viewer, input),
    ]);
    expect(results.map((result) => result.operationId)).toEqual([
      results[0].operationId,
      results[0].operationId,
    ]);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(queued).toHaveLength(1);
    const invitation = await env.DB.prepare(
      `
        SELECT sequence_number AS sequenceNumber,
               (SELECT COUNT(*) FROM calendar_sync_attempts WHERE invitation_id = ci.id) AS attemptCount
          FROM calendar_invitations ci WHERE session_id = ? AND person_id = 'person-demo-speaker'
      `,
    )
      .bind(sessionId)
      .first<{ sequenceNumber: number; attemptCount: number }>();
    expect(invitation).toEqual({ sequenceNumber: 0, attemptCount: 1 });
  });

  it("rejects a calendar idempotency key reused for another lifecycle request", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const idempotencyKey = `calendar-bound-${crypto.randomUUID()}`;
    await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "email_ics",
      idempotencyKey,
    });

    await expect(
      service.queueLifecycle(viewer, {
        sessionId,
        personId: "person-demo-speaker",
        method: "CANCEL",
        provider: "email_ics",
        idempotencyKey,
      }),
    ).rejects.toThrow(
      "idempotency key is already associated with a different calendar lifecycle request",
    );
    expect(queued).toHaveLength(1);
  });

  it("terminalizes a stale queued attempt without calling the provider", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const first = await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "email_ics",
      idempotencyKey: `calendar-stale-first-${crypto.randomUUID()}`,
    });
    const second = await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "CANCEL",
      provider: "email_ics",
      idempotencyKey: `calendar-stale-second-${crypto.randomUUID()}`,
    });
    let providerCalls = 0;
    const provider = new ResendEmailProvider(
      "calendar-provider-key",
      async () => {
        providerCalls += 1;
        return Response.json({ id: "must-not-send-stale" });
      },
    );
    await processCalendarSync(queued[0], testEnv, { email: provider });
    expect(providerCalls).toBe(0);

    const stale = await env.DB.prepare(
      `
        SELECT csa.status AS attemptStatus, o.status AS operationStatus, oi.status AS itemStatus,
               c.status AS communicationStatus, d.status AS deliveryStatus
          FROM calendar_sync_attempts csa
          JOIN operation_jobs o ON json_extract(o.payload_json, '$.attemptId') = csa.id
          JOIN operation_items oi ON oi.operation_id = o.id
          JOIN communications c ON c.operation_id = o.id
          JOIN communication_deliveries d ON d.communication_id = c.id
         WHERE csa.id = json_extract((SELECT payload_json FROM operation_jobs WHERE id = ?), '$.attemptId')
      `,
    )
      .bind(first.operationId)
      .first();
    expect(stale).toEqual({
      attemptStatus: "superseded",
      operationStatus: "cancelled",
      itemStatus: "skipped",
      communicationStatus: "cancelled",
      deliveryStatus: "cancelled",
    });
    const current = await env.DB.prepare(
      `
        SELECT sequence_number AS sequenceNumber, status, current_attempt_id AS currentAttemptId
          FROM calendar_invitations WHERE id = ?
      `,
    )
      .bind(first.invitationId)
      .first();
    expect(current).toEqual({
      sequenceNumber: 1,
      status: "queued",
      currentAttemptId: calendarQueueMessageSchema.parse(queued[1]).attemptId,
    });
    expect(second.sequence).toBe(1);
  });
});
