import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  processCalendarSync,
  processScheduleCalendarFanout,
} from "../../../workers/communications-queue";
import {
  CalendarService,
  scheduleCalendarFanoutSnapshotStatements,
} from "./calendar-service.server";
import {
  calendarQueueMessageSchema,
  type CalendarQueueMessage,
} from "./calendar-schema";
import { generateInvitationIcs, stableCalendarUid } from "./ics.server";
import { ResendEmailProvider } from "~/modules/communications/resend.server";
import { OperationService } from "~/platform/operations/operation-service.server";
import {
  calendarTestViewer as viewer,
  scheduledSpeakerEnvironment,
} from "./calendar-service-test-fixture";

describe("calendar fan-out workflows", () => {
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
               session_id, event_id, person_id, position,
               participation_status, participation_confirmed_at, visibility
             ) VALUES (?, ?, ?, ?, 'confirmed', unixepoch(), 'public')`,
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
               session_id, event_id, person_id, position,
               participation_status, participation_confirmed_at, visibility
             ) VALUES (?, ?, ?, ?, 'confirmed', unixepoch(), 'public')`,
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
               session_id, event_id, person_id, position,
               participation_status, participation_confirmed_at, visibility
             ) VALUES (?, ?, ?, ?, 'confirmed', unixepoch(), 'public')`,
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
});
