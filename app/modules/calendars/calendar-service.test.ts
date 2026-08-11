import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  processCalendarSync,
  processScheduleCalendarFanout,
} from "../../../workers/communications-queue";
import {
  CalendarService,
  publishedScheduleCalendarIdempotencyKey,
  scheduleCalendarFanoutSnapshotStatements,
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
import { generateInvitationIcs, stableCalendarUid } from "./ics.server";
import { ResendEmailProvider } from "~/modules/communications/resend.server";
import { OperationService } from "~/platform/operations/operation-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function scheduledSpeakerEnvironment() {
  const queued: unknown[] = [];
  const realtime: unknown[] = [];
  const eventChannel = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          realtime.push(JSON.parse(String(init?.body)));
          return Response.json({ accepted: true });
        },
      };
    },
  };
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    DB: env.DB,
    RESEND_API_KEY: "test-resend-key",
    OPERATIONS_QUEUE: {
      send: async (message: unknown) => {
        queued.push(message);
      },
    },
    EVENT_CHANNEL: eventChannel,
  } as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await env.DB.prepare("DELETE FROM calendar_invitations WHERE event_id = ?")
    .bind(viewer.eventId)
    .run();
  await env.DB.prepare(
    `
    INSERT OR IGNORE INTO sender_profiles (
      id, event_id, name, from_name, from_email, provider, status, created_at, updated_at
    ) VALUES ('sender-calendar-tests', ?, 'Calendar test', 'Future of Events', 'calendar@example.com',
              'resend', 'verified', unixepoch(), unixepoch())
  `,
  )
    .bind(viewer.eventId)
    .run();
  const token = crypto.randomUUID().slice(0, 8);
  const sessionId = `session-calendar-${token}`;
  const version = await env.DB.prepare(
    "SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM schedule_versions WHERE event_id = ?",
  )
    .bind(viewer.eventId)
    .first<{ value: number }>();
  const scheduleVersionId = `schedule-calendar-${token}`;
  const startsAt = Math.floor(Date.parse("2025-05-20T14:00:00Z") / 1_000);
  const endsAt = Math.floor(Date.parse("2025-05-20T15:00:00Z") / 1_000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE schedule_versions SET status = 'archived'
      WHERE event_id = ? AND status = 'published'`,
    ).bind(viewer.eventId),
    env.DB.prepare(
      `INSERT INTO sessions (
      id, event_id, title, slug, description, format, duration_minutes, status, visibility, created_at, updated_at
    ) VALUES (?, ?, 'Calendar lifecycle session', ?, 'A reliable lifecycle test.', 'presentation', 60, 'published', 'public', unixepoch(), unixepoch())`,
    ).bind(sessionId, viewer.eventId, `calendar-lifecycle-${token}`),
    env.DB.prepare(
      `INSERT INTO session_speakers (session_id, event_id, person_id, position, visibility)
      VALUES (?, ?, 'person-demo-speaker', 0, 'public')`,
    ).bind(sessionId, viewer.eventId),
    env.DB.prepare(
      `INSERT INTO schedule_versions (
      id, event_id, version_number, name, status, created_by_person_id, created_at, published_at
    ) VALUES (?, ?, ?, 'Calendar tests', 'published', ?, unixepoch(), unixepoch())`,
    ).bind(
      scheduleVersionId,
      viewer.eventId,
      version?.value ?? 1,
      viewer.personId,
    ),
    env.DB.prepare(
      `INSERT INTO schedule_entries (
      id, event_id, schedule_version_id, session_id, room_id, starts_at, ends_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'main', ?, ?, unixepoch(), unixepoch())`,
    ).bind(
      `entry-calendar-${token}`,
      viewer.eventId,
      scheduleVersionId,
      sessionId,
      startsAt,
      endsAt,
    ),
  ]);
  return {
    testEnv,
    queued,
    realtime,
    sessionId,
    scheduleVersionId,
    startsAt,
    endsAt,
  };
}

describe("calendar lifecycle", () => {
  it("heartbeats before every published-schedule fan-out target", async () => {
    const { testEnv, scheduleVersionId } = await scheduledSpeakerEnvironment();
    let heartbeatCount = 0;
    const dispatch = await new CalendarService(testEnv).queuePublishedSchedule(
      viewer,
      scheduleVersionId,
      {
        beforeTarget: async () => {
          heartbeatCount += 1;
        },
      },
    );
    expect(dispatch.targetCount).toBeGreaterThan(0);
    expect(heartbeatCount).toBe(dispatch.targetCount);
  });

  it("continues published-schedule fan-out in bounded durable Queue passes", async () => {
    const { testEnv, queued, sessionId, scheduleVersionId } =
      await scheduledSpeakerEnvironment();
    const extraSpeakerStatements: D1PreparedStatement[] = [];
    for (let index = 0; index < 11; index += 1) {
      const personId = `calendar-batch-speaker-${index}-${crypto.randomUUID()}`;
      extraSpeakerStatements.push(
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status, created_at, updated_at
           ) VALUES (?, ?, ?, 1, 'published', unixepoch(), unixepoch())`,
        ).bind(
          personId,
          `${personId}@example.com`,
          `Calendar batch speaker ${index}`,
        ),
        testEnv.DB.prepare(
          `INSERT INTO session_speakers (
             session_id, event_id, person_id, position, visibility
           ) VALUES (?, ?, ?, ?, 'public')`,
        ).bind(sessionId, viewer.eventId, personId, index + 1),
      );
    }
    await testEnv.DB.batch(extraSpeakerStatements);
    const operationId = `calendar-fanout-${crypto.randomUUID()}`;
    const message = {
      type: "schedule.calendar_fanout" as const,
      operationId,
      scheduleVersionId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
      idempotencyKey: `calendar-fanout-${crypto.randomUUID()}`,
    };
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, progress_completed, progress_failed, cancellable,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'schedule.calendar_fanout', ?, ?, 'queued', ?,
                   0, 0, 0, 0, unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        message.idempotencyKey,
        message.idempotencyKey,
        JSON.stringify(message),
      ),
      ...scheduleCalendarFanoutSnapshotStatements(
        testEnv,
        viewer,
        scheduleVersionId,
        operationId,
      ),
    ]);

    const first = await processScheduleCalendarFanout(message, testEnv);
    expect(first).toMatchObject({
      targetCount: 12,
      processedCount: 10,
      queuedCount: 10,
      failureCount: 0,
    });
    expect(first?.nextTarget).toEqual(expect.any(String));
    const continuation = queued.find(
      (item) => (item as { type?: string }).type === "schedule.calendar_fanout",
    );
    expect(continuation).toMatchObject({
      operationId,
      afterTarget: first?.nextTarget,
    });
    expect(
      await testEnv.DB.prepare(
        `SELECT status, progress_total AS progressTotal,
                progress_completed AS progressCompleted
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).toEqual({ status: "queued", progressTotal: 12, progressCompleted: 10 });
    expect(
      await testEnv.DB.prepare(
        `SELECT status, COUNT(*) AS count
           FROM operation_items
          WHERE operation_id = ? AND entity_type = 'schedule_calendar_target'
          GROUP BY status ORDER BY status`,
      )
        .bind(operationId)
        .all(),
    ).toMatchObject({
      results: [
        { status: "completed", count: 10 },
        { status: "pending", count: 2 },
      ],
    });

    const completed = await processScheduleCalendarFanout(
      continuation,
      testEnv,
    );
    expect(completed).toMatchObject({
      targetCount: 12,
      processedCount: 12,
      queuedCount: 12,
      failureCount: 0,
      nextTarget: null,
    });
    expect(
      queued.filter(
        (item) => (item as { type?: string }).type === "calendar.sync",
      ),
    ).toHaveLength(12);
    expect(
      await testEnv.DB.prepare(
        `SELECT status, progress_total AS progressTotal,
                progress_completed AS progressCompleted,
                progress_failed AS progressFailed
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).toEqual({
      status: "completed",
      progressTotal: 12,
      progressCompleted: 12,
      progressFailed: 0,
    });
    expect(
      await testEnv.DB.prepare(
        `SELECT status, COUNT(*) AS count
           FROM operation_items
          WHERE operation_id = ? AND entity_type = 'schedule_calendar_target'
          GROUP BY status`,
      )
        .bind(operationId)
        .all(),
    ).toMatchObject({ results: [{ status: "completed", count: 12 }] });
  });

  it("does not rewind a durable fan-out cursor from a delayed stale claim", async () => {
    const { testEnv, queued, sessionId, scheduleVersionId } =
      await scheduledSpeakerEnvironment();
    const extraSpeakerStatements: D1PreparedStatement[] = [];
    for (let index = 0; index < 21; index += 1) {
      const personId = `calendar-stale-speaker-${index}-${crypto.randomUUID()}`;
      extraSpeakerStatements.push(
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status, created_at, updated_at
           ) VALUES (?, ?, ?, 1, 'published', unixepoch(), unixepoch())`,
        ).bind(
          personId,
          `${personId}@example.com`,
          `Calendar stale speaker ${index}`,
        ),
        testEnv.DB.prepare(
          `INSERT INTO session_speakers (
             session_id, event_id, person_id, position, visibility
           ) VALUES (?, ?, ?, ?, 'public')`,
        ).bind(sessionId, viewer.eventId, personId, index + 1),
      );
    }
    await testEnv.DB.batch(extraSpeakerStatements);
    const operationId = `calendar-stale-fanout-${crypto.randomUUID()}`;
    const message = {
      type: "schedule.calendar_fanout" as const,
      operationId,
      scheduleVersionId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
      idempotencyKey: `calendar-stale-fanout-${crypto.randomUUID()}`,
    };
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, progress_completed, progress_failed, cancellable,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'schedule.calendar_fanout', ?, ?, 'queued', ?,
                   0, 0, 0, 0, unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        message.idempotencyKey,
        message.idempotencyKey,
        JSON.stringify(message),
      ),
      ...scheduleCalendarFanoutSnapshotStatements(
        testEnv,
        viewer,
        scheduleVersionId,
        operationId,
      ),
    ]);

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
        if (property === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            if (
              !query.includes("UPDATE operation_jobs") ||
              !query.includes("type = 'schedule.calendar_fanout'") ||
              !query.includes("claim_token = ?")
            ) {
              return statement;
            }
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === "bind") {
                  return (...values: unknown[]) => {
                    const bound = statementTarget.bind(...values);
                    return new Proxy(bound, {
                      get(boundTarget, boundProperty) {
                        if (boundProperty === "run") {
                          return async () => {
                            if (!interceptedClaim) {
                              interceptedClaim = true;
                              claimReachedResolve();
                              await claimReleased;
                            }
                            return boundTarget.run();
                          };
                        }
                        const value = Reflect.get(
                          boundTarget,
                          boundProperty,
                          boundTarget,
                        ) as unknown;
                        return typeof value === "function"
                          ? value.bind(boundTarget)
                          : value;
                      },
                    });
                  };
                }
                const value = Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementTarget,
                ) as unknown;
                return typeof value === "function"
                  ? value.bind(statementTarget)
                  : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const staleEnv = { ...testEnv, DB: delayedDb } as CloudflareEnvironment;
    const staleWorker = processScheduleCalendarFanout(message, staleEnv);
    await claimReached;

    let stateAfterTwoPasses: {
      status: string;
      payloadJson: string;
      resultJson: string | null;
      progressTotal: number;
      progressCompleted: number;
    } | null = null;
    try {
      await processScheduleCalendarFanout(message, testEnv);
      const firstContinuation = queued.find(
        (item) =>
          (item as { type?: string }).type === "schedule.calendar_fanout",
      );
      expect(firstContinuation).toBeDefined();
      await processScheduleCalendarFanout(firstContinuation, testEnv);
      stateAfterTwoPasses = await testEnv.DB.prepare(
        `SELECT status, payload_json AS payloadJson, result_json AS resultJson,
                progress_total AS progressTotal,
                progress_completed AS progressCompleted
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first();
    } finally {
      releaseClaim();
    }
    const staleResult = await staleWorker;
    const finalState = await testEnv.DB.prepare(
      `SELECT status, payload_json AS payloadJson, result_json AS resultJson,
              progress_total AS progressTotal,
              progress_completed AS progressCompleted
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(operationId)
      .first();

    expect(stateAfterTwoPasses).toMatchObject({
      status: "queued",
      progressTotal: 22,
      progressCompleted: 20,
    });
    expect(staleResult).toBeUndefined();
    expect(finalState).toEqual(stateAfterTwoPasses);
    expect(
      queued.filter(
        (item) => (item as { type?: string }).type === "calendar.sync",
      ),
    ).toHaveLength(20);
  });

  it("restarts a terminal fan-out retry with a fresh progress aggregate", async () => {
    const { testEnv, queued, scheduleVersionId } =
      await scheduledSpeakerEnvironment();
    const operationId = `calendar-fanout-retry-${crypto.randomUUID()}`;
    const message = {
      type: "schedule.calendar_fanout" as const,
      operationId,
      scheduleVersionId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
      idempotencyKey: `calendar-fanout-retry-${crypto.randomUUID()}`,
    };
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, result_json,
           progress_total, progress_completed, progress_failed, cancellable,
           completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'schedule.calendar_fanout', ?, ?,
                   'partially_failed', ?, ?, 1, 1, 1, 0, unixepoch(),
                   unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        message.idempotencyKey,
        message.idempotencyKey,
        JSON.stringify(message),
        JSON.stringify({
          targetCount: 1,
          processedCount: 1,
          queuedCount: 0,
          duplicateCount: 0,
          failureCount: 1,
          nextTarget: null,
          dispatchError: null,
          failures: [
            {
              sessionId: "previous-session",
              personId: "previous-person",
              method: "REQUEST",
              provider: "email_ics",
              message: "Previous attempt failed.",
            },
          ],
        }),
      ),
      ...scheduleCalendarFanoutSnapshotStatements(
        testEnv,
        viewer,
        scheduleVersionId,
        operationId,
      ),
    ]);

    const queuedBeforeRedelivery = queued.length;
    await expect(
      processScheduleCalendarFanout(message, testEnv),
    ).resolves.toBeUndefined();
    expect(queued).toHaveLength(queuedBeforeRedelivery);
    await expect(
      testEnv.DB.prepare(
        `SELECT status, progress_completed AS completed, progress_failed AS failed
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({
      status: "partially_failed",
      completed: 1,
      failed: 1,
    });

    await new OperationService(testEnv).retry(viewer, operationId);
    expect(
      await testEnv.DB.prepare(
        `SELECT status, progress_total AS progressTotal,
                progress_completed AS progressCompleted,
                progress_failed AS progressFailed, result_json AS resultJson,
                completed_at AS completedAt
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).toEqual({
      status: "queued",
      progressTotal: 0,
      progressCompleted: 0,
      progressFailed: 0,
      resultJson: null,
      completedAt: null,
    });

    const retryMessage = queued.find(
      (item) =>
        (item as { type?: string; operationId?: string }).type ===
          "schedule.calendar_fanout" &&
        (item as { operationId?: string }).operationId === operationId,
    );
    const completed = await processScheduleCalendarFanout(
      retryMessage,
      testEnv,
    );
    expect(completed).toMatchObject({
      targetCount: 1,
      processedCount: 1,
      failureCount: 0,
      nextTarget: null,
    });
    expect(
      await testEnv.DB.prepare(
        `SELECT status, progress_total AS progressTotal,
                progress_completed AS progressCompleted,
                progress_failed AS progressFailed
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).toEqual({
      status: "completed",
      progressTotal: 1,
      progressCompleted: 1,
      progressFailed: 0,
    });
  });

  it("continues from the published cancellation snapshot after earlier cancellations complete", async () => {
    const { testEnv, queued, sessionId, scheduleVersionId } =
      await scheduledSpeakerEnvironment();
    const people = ["person-demo-speaker"];
    const setup: D1PreparedStatement[] = [];
    for (let index = 0; index < 11; index += 1) {
      const personId = `calendar-cancel-speaker-${index}-${crypto.randomUUID()}`;
      people.push(personId);
      setup.push(
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status, created_at, updated_at
           ) VALUES (?, ?, ?, 1, 'published', unixepoch(), unixepoch())`,
        ).bind(
          personId,
          `${personId}@example.com`,
          `Cancellation speaker ${index}`,
        ),
        testEnv.DB.prepare(
          `INSERT INTO session_speakers (
             session_id, event_id, person_id, position, visibility
           ) VALUES (?, ?, ?, ?, 'public')`,
        ).bind(sessionId, viewer.eventId, personId, index + 1),
      );
    }
    for (const [index, personId] of people.entries()) {
      setup.push(
        testEnv.DB.prepare(
          `INSERT INTO calendar_invitations (
             id, event_id, session_id, person_id, ical_uid, sequence_number,
             method, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 0, 'REQUEST', 'sent', unixepoch(), unixepoch())`,
        ).bind(
          `calendar-cancel-invitation-${index}-${crypto.randomUUID()}`,
          viewer.eventId,
          sessionId,
          personId,
          `calendar-cancel-${index}-${crypto.randomUUID()}@programcue`,
        ),
      );
    }
    await testEnv.DB.batch(setup);

    const nextVersion = await testEnv.DB.prepare(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM schedule_versions WHERE event_id = ?",
    )
      .bind(viewer.eventId)
      .first<{ value: number }>();
    const replacementVersionId = `calendar-empty-${crypto.randomUUID()}`;
    const operationId = `calendar-cancel-fanout-${crypto.randomUUID()}`;
    const message = {
      type: "schedule.calendar_fanout" as const,
      operationId,
      scheduleVersionId: replacementVersionId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
      idempotencyKey: `calendar-cancel-fanout-${crypto.randomUUID()}`,
    };
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "UPDATE schedule_versions SET status = 'archived' WHERE id = ? AND event_id = ?",
      ).bind(scheduleVersionId, viewer.eventId),
      testEnv.DB.prepare(
        `INSERT INTO schedule_versions (
           id, event_id, version_number, name, status, created_by_person_id,
           created_at, published_at
         ) VALUES (?, ?, ?, 'Empty cancellation schedule', 'published', ?,
                   unixepoch(), unixepoch())`,
      ).bind(
        replacementVersionId,
        viewer.eventId,
        nextVersion?.value ?? 1,
        viewer.personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, progress_completed, progress_failed, cancellable,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'schedule.calendar_fanout', ?, ?, 'queued', ?,
                   0, 0, 0, 0, unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        message.idempotencyKey,
        message.idempotencyKey,
        JSON.stringify(message),
      ),
      ...scheduleCalendarFanoutSnapshotStatements(
        testEnv,
        viewer,
        replacementVersionId,
        operationId,
      ),
    ]);

    const first = await processScheduleCalendarFanout(message, testEnv);
    expect(first).toMatchObject({
      targetCount: 12,
      processedCount: 10,
      queuedCount: 10,
    });
    const firstChildren = queued.filter(
      (item): item is CalendarQueueMessage =>
        (item as { type?: string }).type === "calendar.sync",
    );
    expect(firstChildren).toHaveLength(10);
    await testEnv.DB.prepare(
      `UPDATE calendar_invitations SET status = 'cancelled'
        WHERE id IN (${firstChildren.map(() => "?").join(",")})`,
    )
      .bind(...firstChildren.map((child) => child.invitationId))
      .run();

    const continuation = queued.find(
      (item) => (item as { type?: string }).type === "schedule.calendar_fanout",
    );
    const completed = await processScheduleCalendarFanout(
      continuation,
      testEnv,
    );
    expect(completed).toMatchObject({
      targetCount: 12,
      processedCount: 12,
      queuedCount: 12,
      nextTarget: null,
    });
    expect(
      queued.filter(
        (item) => (item as { type?: string }).type === "calendar.sync",
      ),
    ).toHaveLength(12);
  });

  it("supersedes a queued request when a republish removes its session", async () => {
    const { testEnv, queued, sessionId, scheduleVersionId } =
      await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    const firstDispatch = await service.queuePublishedSchedule(
      viewer,
      scheduleVersionId,
    );
    expect(firstDispatch.failures).toEqual([]);
    const invitation = await env.DB.prepare(
      "SELECT id FROM calendar_invitations WHERE event_id = ? AND session_id = ? AND person_id = 'person-demo-speaker'",
    )
      .bind(viewer.eventId, sessionId)
      .first<{ id: string }>();
    expect(invitation).toBeDefined();
    const firstRequest = queued
      .map((message) => calendarQueueMessageSchema.parse(message))
      .find(
        (message) =>
          message.invitationId === invitation?.id &&
          message.payload.method === "REQUEST",
      );
    expect(firstRequest).toBeDefined();

    const nextVersion = await env.DB.prepare(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM schedule_versions WHERE event_id = ?",
    )
      .bind(viewer.eventId)
      .first<{ value: number }>();
    const replacementVersionId = `schedule-calendar-empty-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE schedule_versions SET status = 'archived' WHERE id = ? AND event_id = ?",
      ).bind(scheduleVersionId, viewer.eventId),
      env.DB.prepare(
        `INSERT INTO schedule_versions (
          id, event_id, version_number, name, status, created_by_person_id,
          created_at, published_at
        ) VALUES (?, ?, ?, 'Empty replacement', 'published', ?, unixepoch(), unixepoch())`,
      ).bind(
        replacementVersionId,
        viewer.eventId,
        nextVersion?.value ?? 1,
        viewer.personId,
      ),
    ]);

    const replacementDispatch = await service.queuePublishedSchedule(
      viewer,
      replacementVersionId,
    );
    expect(replacementDispatch.failures).toEqual([]);
    const cancellation = queued
      .map((message) => calendarQueueMessageSchema.parse(message))
      .find(
        (message) =>
          message.invitationId === invitation?.id &&
          message.payload.method === "CANCEL",
      );
    expect(cancellation).toMatchObject({
      payload: { method: "CANCEL", sequence: 1 },
    });

    let providerCalls = 0;
    const provider = new ResendEmailProvider(
      "calendar-provider-key",
      async () => {
        providerCalls += 1;
        return Response.json({ id: "must-not-send-removed-session" });
      },
    );
    await processCalendarSync(firstRequest!, testEnv, { email: provider });
    expect(providerCalls).toBe(0);
  });

  it("cancels an earlier delivered request after a later update fails", async () => {
    const { testEnv, queued, sessionId, scheduleVersionId } =
      await scheduledSpeakerEnvironment();
    const service = new CalendarService(testEnv);
    await service.queuePublishedSchedule(viewer, scheduleVersionId);
    const deliveredRequest = calendarQueueMessageSchema.parse(queued[0]);
    await processCalendarSync(deliveredRequest, testEnv, {
      email: new ResendEmailProvider("calendar-provider-key", async () =>
        Response.json({ id: "calendar-delivered-before-failure" }),
      ),
    });

    await service.queueLifecycle(viewer, {
      sessionId,
      personId: "person-demo-speaker",
      method: "REQUEST",
      provider: "email_ics",
      idempotencyKey: `calendar-failed-update-${crypto.randomUUID()}`,
    });
    const failedUpdate = calendarQueueMessageSchema.parse(queued.at(-1));
    await processCalendarSync(failedUpdate, testEnv, {
      email: new ResendEmailProvider("calendar-provider-key", async () =>
        Response.json({ message: "provider rejected update" }, { status: 500 }),
      ),
    });
    expect(
      await env.DB.prepare(
        `SELECT ci.status,
                (SELECT COUNT(*) FROM calendar_sync_attempts csa
                  WHERE csa.invitation_id = ci.id AND csa.method = 'REQUEST'
                    AND csa.status = 'succeeded') AS deliveredRequests
           FROM calendar_invitations ci WHERE ci.id = ?`,
      )
        .bind(failedUpdate.invitationId)
        .first(),
    ).toEqual({ status: "failed", deliveredRequests: 1 });

    const nextVersion = await env.DB.prepare(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM schedule_versions WHERE event_id = ?",
    )
      .bind(viewer.eventId)
      .first<{ value: number }>();
    const replacementVersionId = `schedule-calendar-empty-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE schedule_versions SET status = 'archived' WHERE id = ? AND event_id = ?",
      ).bind(scheduleVersionId, viewer.eventId),
      env.DB.prepare(
        `INSERT INTO schedule_versions (
          id, event_id, version_number, name, status, created_by_person_id,
          created_at, published_at
        ) VALUES (?, ?, ?, 'Empty after failed update', 'published', ?, unixepoch(), unixepoch())`,
      ).bind(
        replacementVersionId,
        viewer.eventId,
        nextVersion?.value ?? 1,
        viewer.personId,
      ),
    ]);

    const replacement = await service.queuePublishedSchedule(
      viewer,
      replacementVersionId,
    );
    expect(replacement.failures).toEqual([]);
    expect(
      queued
        .map((message) => calendarQueueMessageSchema.parse(message))
        .find(
          (message) =>
            message.invitationId === failedUpdate.invitationId &&
            message.payload.method === "CANCEL",
        ),
    ).toMatchObject({ payload: { sequence: 2, method: "CANCEL" } });
  });

  it("generates standards-compatible REQUEST and CANCEL payloads with a stable UID and sequence", () => {
    const uid = stableCalendarUid("event", "session", "person");
    const base = {
      uid,
      sequence: 2,
      title: "A useful session",
      description: "Session details",
      location: "Room 301A",
      startsAt: 1_747_747_600,
      endsAt: 1_747_751_200,
      organizerName: "Program Cue",
      organizerEmail: "events@example.com",
      attendeeName: "Priya Shah",
      attendeeEmail: "priya@example.com",
    };
    const request = generateInvitationIcs({ ...base, method: "REQUEST" });
    const cancel = generateInvitationIcs({
      ...base,
      sequence: 3,
      method: "CANCEL",
    });
    expect(request).toContain("METHOD:REQUEST");
    expect(request).toContain(`UID:${uid}`);
    expect(request).toContain("SEQUENCE:2");
    expect(cancel).toContain("METHOD:CANCEL");
    expect(cancel).toContain("STATUS:CANCELLED");
    expect(cancel).toContain("SEQUENCE:3");
  });

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
    const provider = new ResendEmailProvider(
      "calendar-provider-key",
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          attachments: Array<{ content: string }>;
        };
        calendarAttachment = atob(body.attachments[0].content);
        return Response.json({ id: "resend-calendar-001" });
      },
    );
    await processCalendarSync(queued[0], testEnv, { email: provider });
    expect(calendarAttachment).toContain("METHOD:REQUEST");
    expect(calendarAttachment).toContain("SEQUENCE:0");
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
