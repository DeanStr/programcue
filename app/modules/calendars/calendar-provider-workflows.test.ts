import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { processCalendarSync } from "../../../workers/communications-queue";
import {
  CalendarService,
  publishedScheduleCalendarIdempotencyKey,
} from "./calendar-service.server";
import {
  GoogleCalendarProvider,
  MicrosoftCalendarProvider,
  type DirectCalendarProvider,
} from "./calendar-providers.server";
import {
  calendarQueueMessageSchema,
  queueCalendarLifecycleSchema,
  type CalendarQueueMessage,
} from "./calendar-schema";
import { ResendEmailProvider } from "~/modules/communications/resend.server";
import {
  calendarTestViewer as viewer,
  scheduledSpeakerEnvironment,
} from "./calendar-service-test-fixture";

describe("calendar provider workflows", () => {
  it("rejects a payload that differs from the durable exact attempt before provider delivery", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const result = await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "email_ics",
      idempotencyKey: `calendar-payload-gate-${crypto.randomUUID()}`,
    });
    const queuedMessage = calendarQueueMessageSchema.parse(queued[0]);
    const changedMessage: CalendarQueueMessage = {
      ...queuedMessage,
      payload: { ...queuedMessage.payload, title: "A queue-tampered title" },
    };
    let providerCalls = 0;
    const provider = new ResendEmailProvider(
      "calendar-provider-key",
      async () => {
        providerCalls += 1;
        return Response.json({ id: "must-not-send-mismatch" });
      },
    );
    await processCalendarSync(changedMessage, testEnv, { email: provider });
    expect(providerCalls).toBe(0);
    const state = await env.DB.prepare(
      `
        SELECT ci.status AS invitationStatus, csa.status AS attemptStatus,
               csa.error_code AS errorCode, o.status AS operationStatus, oi.status AS itemStatus
          FROM calendar_invitations ci
          JOIN calendar_sync_attempts csa ON csa.id = ci.current_attempt_id
          JOIN operation_jobs o ON o.id = ?
          JOIN operation_items oi ON oi.operation_id = o.id
         WHERE ci.id = ?
      `,
    )
      .bind(result.operationId, result.invitationId)
      .first();
    expect(state).toEqual({
      invitationStatus: "failed",
      attemptStatus: "failed",
      errorCode: "QUEUE_PAYLOAD_MISMATCH",
      operationStatus: "failed",
      itemStatus: "failed",
    });
    await processCalendarSync(queued[0], testEnv, { email: provider });
    expect(providerCalls).toBe(0);
  });

  it("serializes a direct-provider create before allowing the replacement update", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const connectionId = `calendar-connection-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `
        INSERT INTO calendar_connections (
          id, organisation_id, event_id, person_id, provider, account_reference,
          encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'person-demo-speaker', 'google', ?, 'injected-test-provider', '[]',
                  'connected', unixepoch() + 3600, unixepoch(), unixepoch())
      `,
    )
      .bind(
        connectionId,
        viewer.organisationId,
        viewer.eventId,
        `account-${crypto.randomUUID()}`,
      )
      .run();
    const first = await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "google",
      connectionId,
      idempotencyKey: `calendar-inflight-first-${crypto.randomUUID()}`,
    });
    let markProviderStarted!: () => void;
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const providerCalls: Array<{
      sequence: number;
      externalEventId: string | null | undefined;
    }> = [];
    const provider: DirectCalendarProvider = {
      name: "google",
      async apply(input) {
        providerCalls.push({
          sequence: input.sequence,
          externalEventId: input.externalEventId,
        });
        if (providerCalls.length === 1) {
          markProviderStarted();
          await providerRelease;
        }
        return { providerEventId: "google-serialized-event" };
      },
    };
    const processing = processCalendarSync(queued[0], testEnv, {
      directCalendar: provider,
    });
    await providerStarted;
    const replacementKey = `calendar-inflight-second-${crypto.randomUUID()}`;
    await expect(
      service.queueLifecycle(viewer, {
        sessionId,
        personId: "person-demo-speaker",
        method: "REQUEST",
        provider: "google",
        connectionId,
        idempotencyKey: replacementKey,
      }),
    ).rejects.toThrow("currently being delivered");
    expect(queued).toHaveLength(1);

    releaseProvider();
    await processing;
    const replacement = await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "google",
      connectionId,
      idempotencyKey: replacementKey,
    });
    expect(replacement.sequence).toBe(1);
    await processCalendarSync(queued[1], testEnv, { directCalendar: provider });
    const state = await env.DB.prepare(
      `
        SELECT ci.status AS invitationStatus, ci.sequence_number AS sequenceNumber,
               ci.current_attempt_id AS currentAttemptId, ci.provider_event_id AS providerEventId,
               current.status AS currentAttemptStatus
          FROM calendar_invitations ci
          JOIN calendar_sync_attempts current ON current.id = ci.current_attempt_id
         WHERE ci.id = ?
      `,
    )
      .bind(first.invitationId)
      .first();
    expect(state).toEqual({
      invitationStatus: "sent",
      sequenceNumber: 1,
      currentAttemptId: calendarQueueMessageSchema.parse(queued[1]).attemptId,
      providerEventId: "google-serialized-event",
      currentAttemptStatus: "succeeded",
    });
    expect(providerCalls).toEqual([
      { sequence: 0, externalEventId: null },
      { sequence: 1, externalEventId: "google-serialized-event" },
    ]);
  });

  it("creates a new direct-provider event when a cancelled invitation is requested again", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const connectionId = `calendar-recreate-connection-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `
        INSERT INTO calendar_connections (
          id, organisation_id, event_id, person_id, provider, account_reference,
          encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'person-demo-speaker', 'google', ?, 'injected-test-provider', '[]',
                  'connected', unixepoch() + 3600, unixepoch(), unixepoch())
      `,
    )
      .bind(
        connectionId,
        viewer.organisationId,
        viewer.eventId,
        `account-${crypto.randomUUID()}`,
      )
      .run();

    const providerCalls: Array<{
      method: "REQUEST" | "CANCEL";
      sequence: number;
      externalEventId: string | null | undefined;
    }> = [];
    const provider: DirectCalendarProvider = {
      name: "google",
      async apply(input) {
        providerCalls.push({
          method: input.method,
          sequence: input.sequence,
          externalEventId: input.externalEventId,
        });
        return {
          providerEventId:
            input.method === "CANCEL"
              ? (input.externalEventId ?? "missing-provider-event")
              : `google-recreated-event-${input.sequence}`,
        };
      },
    };
    const queue = async (method: "REQUEST" | "CANCEL") => {
      const result = await service.queueLifecycle(viewer, {
        sessionId,
        personId: "person-demo-speaker",
        method,
        provider: "google",
        connectionId,
        idempotencyKey: `calendar-recreate-${method}-${crypto.randomUUID()}`,
      });
      await processCalendarSync(queued.at(-1), testEnv, {
        directCalendar: provider,
      });
      return result;
    };

    const initial = await queue("REQUEST");
    await queue("CANCEL");
    await queue("REQUEST");

    expect(providerCalls).toEqual([
      { method: "REQUEST", sequence: 0, externalEventId: null },
      {
        method: "CANCEL",
        sequence: 1,
        externalEventId: "google-recreated-event-0",
      },
      { method: "REQUEST", sequence: 2, externalEventId: null },
    ]);
    await expect(
      env.DB.prepare(
        `SELECT status, provider_event_id AS providerEventId
             FROM calendar_invitations WHERE id = ?`,
      )
        .bind(initial.invitationId)
        .first(),
    ).resolves.toEqual({
      status: "sent",
      providerEventId: "google-recreated-event-2",
    });
  });

  it("clears the old direct-provider identity when a cancelled invitation switches to email", async () => {
    const { testEnv, queued, sessionId } = await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const connectionId = `calendar-email-switch-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO calendar_connections (
           id, organisation_id, event_id, person_id, provider, account_reference,
           encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'person-demo-speaker', 'google', ?, 'injected-test-provider',
                   '[]', 'connected', unixepoch() + 3600, unixepoch(), unixepoch())`,
    )
      .bind(
        connectionId,
        viewer.organisationId,
        viewer.eventId,
        `email-switch-${crypto.randomUUID()}`,
      )
      .run();
    const provider: DirectCalendarProvider = {
      name: "google",
      async apply(input) {
        return {
          providerEventId:
            input.externalEventId ?? "google-event-before-email-switch",
        };
      },
    };
    const queueDirect = async (method: "REQUEST" | "CANCEL") => {
      const result = await service.queueLifecycle(viewer, {
        sessionId,
        personId: "person-demo-speaker",
        method,
        provider: "google",
        connectionId,
        idempotencyKey: `calendar-email-switch-${method}-${crypto.randomUUID()}`,
      });
      await processCalendarSync(queued.at(-1), testEnv, {
        directCalendar: provider,
      });
      return result;
    };
    const initial = await queueDirect("REQUEST");
    await queueDirect("CANCEL");

    await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "email_ics",
      idempotencyKey: `calendar-email-switch-request-${crypto.randomUUID()}`,
    });

    await expect(
      testEnv.DB.prepare(
        `SELECT provider_event_id AS providerEventId, connection_id AS connectionId,
                  sequence_number AS sequenceNumber
             FROM calendar_invitations WHERE id = ?`,
      )
        .bind(initial.invitationId)
        .first(),
    ).resolves.toEqual({
      providerEventId: null,
      connectionId: null,
      sequenceNumber: 2,
    });
  });

  it("uses a fixed-length valid idempotency key for UUID-sized publication targets", async () => {
    const input = {
      scheduleVersionId: crypto.randomUUID(),
      method: "REQUEST" as const,
      sessionId: crypto.randomUUID(),
      personId: crypto.randomUUID(),
      provider: "microsoft" as const,
    };
    const key = await publishedScheduleCalendarIdempotencyKey(input);
    expect(key).toHaveLength(82);
    expect(key).toBe(await publishedScheduleCalendarIdempotencyKey(input));
    expect(
      queueCalendarLifecycleSchema.safeParse({ ...input, idempotencyKey: key })
        .success,
    ).toBe(true);
  });

  it("uses explicit Google and Microsoft create/update/cancel boundaries and fails when credentials are absent", async () => {
    await expect(
      new GoogleCalendarProvider(undefined).apply({
        uid: "event.session.speaker@calendar.programcue.app",
        title: "Session",
        description: "",
        location: "Room",
        startsAtIso: "2025-05-20T14:00:00Z",
        endsAtIso: "2025-05-20T15:00:00Z",
        timezone: "America/Toronto",
        attendeeEmail: "speaker@example.com",
        attendeeName: "Speaker",
        sequence: 0,
        method: "REQUEST",
      }),
    ).rejects.toThrow("OAuth access token");
    await expect(
      new MicrosoftCalendarProvider(undefined).apply({
        uid: "event.session.speaker@calendar.programcue.app",
        title: "Session",
        description: "",
        location: "Room",
        startsAtIso: "2025-05-20T14:00:00Z",
        endsAtIso: "2025-05-20T15:00:00Z",
        timezone: "America/Toronto",
        attendeeEmail: "speaker@example.com",
        attendeeName: "Speaker",
        sequence: 0,
        method: "REQUEST",
      }),
    ).rejects.toThrow("OAuth access token");

    const requests: Array<{
      url: string;
      method: string;
      body: string | null;
    }> = [];
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: "google-event-1" });
    };
    const google = new GoogleCalendarProvider(
      "token",
      "primary",
      fetcher as typeof fetch,
      "https://google.test",
    );
    const common = {
      uid: "event.session.speaker@calendar.programcue.app",
      title: "Session",
      description: "",
      location: "Room",
      startsAtIso: "2025-05-20T14:00:00Z",
      endsAtIso: "2025-05-20T15:00:00Z",
      timezone: "America/Toronto",
      attendeeEmail: "speaker@example.com",
      attendeeName: "Speaker",
    };
    await google.apply({ ...common, sequence: 0, method: "REQUEST" });
    await google.apply({
      ...common,
      sequence: 1,
      method: "REQUEST",
      externalEventId: "google-event-1",
    });
    await google.apply({
      ...common,
      sequence: 2,
      method: "CANCEL",
      externalEventId: "google-event-1",
    });
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "PUT",
      "DELETE",
    ]);
    const firstInsert = JSON.parse(requests[0].body ?? "{}") as { id?: string };
    expect(firstInsert.id).toMatch(/^[0-9a-f]{64}$/);

    const microsoftRequests: Array<{ method: string; body: string | null }> =
      [];
    const microsoft = new MicrosoftCalendarProvider(
      "token",
      async (_input, init) => {
        microsoftRequests.push({
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return Response.json({ id: "microsoft-event-1" });
      },
      "https://microsoft.test/events",
    );
    await microsoft.apply({
      ...common,
      startsAtIso: "2025-07-15T13:00:00.000Z",
      endsAtIso: "2025-07-15T14:30:00.000Z",
      timezone: "America/Toronto",
      sequence: 0,
      method: "REQUEST",
    });
    await microsoft.apply({
      ...common,
      startsAtIso: "2025-07-15T14:00:00.000Z",
      endsAtIso: "2025-07-15T15:30:00.000Z",
      timezone: "America/Toronto",
      sequence: 1,
      method: "REQUEST",
      externalEventId: "microsoft-event-1",
    });
    const microsoftBody = JSON.parse(microsoftRequests[0].body ?? "{}") as {
      start?: { dateTime?: string; timeZone?: string };
      end?: { dateTime?: string; timeZone?: string };
      transactionId?: string;
    };
    expect(microsoftBody.start).toEqual({
      dateTime: "2025-07-15T09:00:00",
      timeZone: "America/Toronto",
    });
    expect(microsoftBody.end).toEqual({
      dateTime: "2025-07-15T10:30:00",
      timeZone: "America/Toronto",
    });
    expect(microsoftBody.transactionId).toMatch(/^programcue-[0-9a-f]{64}$/);
    const microsoftUpdateBody = JSON.parse(
      microsoftRequests[1].body ?? "{}",
    ) as { transactionId?: string };
    expect(microsoftRequests.map((request) => request.method)).toEqual([
      "POST",
      "PATCH",
    ]);
    expect(microsoftUpdateBody).not.toHaveProperty("transactionId");

    await expect(
      new GoogleCalendarProvider(
        "token",
        "primary",
        async () => new Response(null, { status: 410 }),
        "https://google.test",
      ).apply({
        ...common,
        sequence: 3,
        method: "CANCEL",
        externalEventId: "already-absent-google-event",
      }),
    ).resolves.toEqual({ providerEventId: "already-absent-google-event" });
    await expect(
      new MicrosoftCalendarProvider(
        "token",
        async () => new Response(null, { status: 404 }),
        "https://microsoft.test/events",
      ).apply({
        ...common,
        sequence: 3,
        method: "CANCEL",
        externalEventId: "already-absent-microsoft-event",
      }),
    ).resolves.toEqual({
      providerEventId: "already-absent-microsoft-event",
    });
  });

  it("reconciles provider events when a create result was not persisted", async () => {
    const common = {
      uid: "event.session.speaker@calendar.programcue.app",
      title: "Updated session",
      description: "Current lifecycle content",
      location: "Room 2",
      startsAtIso: "2025-07-15T14:00:00.000Z",
      endsAtIso: "2025-07-15T15:30:00.000Z",
      timezone: "America/Toronto",
      attendeeEmail: "speaker@example.com",
      attendeeName: "Speaker",
      sequence: 1,
      method: "REQUEST" as const,
    };

    const googleRequests: Array<{ method: string; body: string | null }> = [];
    const google = new GoogleCalendarProvider(
      "token",
      "primary",
      async (_input, init) => {
        googleRequests.push({
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return init?.method === "POST"
          ? new Response(null, { status: 409 })
          : Response.json({ id: "recovered-google-event" });
      },
      "https://google.test",
    );
    await expect(google.apply(common)).resolves.toEqual({
      providerEventId: "recovered-google-event",
    });
    expect(googleRequests.map((request) => request.method)).toEqual([
      "POST",
      "PUT",
    ]);
    expect(JSON.parse(googleRequests[1].body ?? "{}")).toMatchObject({
      summary: "Updated session",
      extendedProperties: {
        private: { programCueSequence: "1" },
      },
    });

    const microsoftRequests: Array<{ method: string; body: string | null }> =
      [];
    const microsoft = new MicrosoftCalendarProvider(
      "token",
      async (_input, init) => {
        microsoftRequests.push({
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return Response.json({ id: "recovered-microsoft-event" });
      },
      "https://microsoft.test/events",
    );
    await microsoft.apply({
      ...common,
      sequence: 0,
      title: "Original session",
    });
    await expect(microsoft.apply(common)).resolves.toEqual({
      providerEventId: "recovered-microsoft-event",
    });
    expect(microsoftRequests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "PATCH",
    ]);
    const firstCreate = JSON.parse(microsoftRequests[0].body ?? "{}") as {
      transactionId?: string;
    };
    const recoveringCreate = JSON.parse(microsoftRequests[1].body ?? "{}") as {
      transactionId?: string;
    };
    const reconciliation = JSON.parse(microsoftRequests[2].body ?? "{}") as {
      transactionId?: string;
      subject?: string;
    };
    expect(recoveringCreate.transactionId).not.toBe(firstCreate.transactionId);
    expect(reconciliation).toMatchObject({ subject: "Updated session" });
    expect(reconciliation).not.toHaveProperty("transactionId");
  });

  it("reads attendee responses from Google and Microsoft without inventing acceptance", async () => {
    const google = new GoogleCalendarProvider(
      "token",
      "primary",
      async () =>
        Response.json({
          attendees: [
            {
              email: "speaker@example.com",
              responseStatus: "tentative",
            },
          ],
        }),
      "https://google.test",
    );
    await expect(
      google.attendance("google-event", "speaker@example.com"),
    ).resolves.toBe("tentative");

    const microsoft = new MicrosoftCalendarProvider(
      "token",
      async () =>
        Response.json({
          attendees: [
            {
              emailAddress: { address: "speaker@example.com" },
              status: { response: "notResponded" },
            },
          ],
        }),
      "https://microsoft.test/events",
    );
    await expect(
      microsoft.attendance("microsoft-event", "speaker@example.com"),
    ).resolves.toBe("needs_action");
  });
});
