import { z } from "zod";

import { scheduleCalendarFanoutMessageSchema } from "../../app/modules/calendars/calendar-schema";
import {
  CalendarService,
  type PublishedScheduleCalendarDispatch,
} from "../../app/modules/calendars/calendar-service.server";
import {
  errorDetails,
  loadOperationClaim,
  notifyRealtimeAfterCommit,
  QUEUE_CLAIM_LEASE_SECONDS,
  QueueClaimLeaseBusyError,
  QueueClaimLeaseLostError,
  renewOperationClaim,
  returnedChangeSequence,
} from "./claim-infrastructure";

function scheduleFanoutQueuePayload(
  message: z.infer<typeof scheduleCalendarFanoutMessageSchema>,
  afterTarget?: string,
) {
  return JSON.stringify({
    type: message.type,
    operationId: message.operationId,
    scheduleVersionId: message.scheduleVersionId,
    eventId: message.eventId,
    organisationId: message.organisationId,
    idempotencyKey: message.idempotencyKey,
    ...(afterTarget ? { afterTarget } : {}),
  });
}

const persistedCalendarFanoutResultSchema = z.object({
  targetCount: z.number().int().nonnegative(),
  processedCount: z.number().int().nonnegative(),
  queuedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  nextTarget: z.string().nullable(),
  dispatchError: z.string().nullable(),
  failures: z.array(
    z.object({
      sessionId: z.string(),
      personId: z.string(),
      method: z.enum(["REQUEST", "CANCEL"]),
      provider: z.enum(["email_ics", "google", "microsoft"]),
      message: z.string(),
    }),
  ),
});

type PersistedCalendarFanoutResult = z.infer<
  typeof persistedCalendarFanoutResultSchema
>;

function accumulateCalendarFanoutResult(
  previous: PersistedCalendarFanoutResult | null,
  current: PublishedScheduleCalendarDispatch,
): PersistedCalendarFanoutResult {
  if (previous && previous.targetCount !== current.targetCount) {
    throw new Error(
      "The published schedule calendar target set changed during durable fan-out.",
    );
  }
  return {
    targetCount: current.targetCount,
    processedCount: (previous?.processedCount ?? 0) + current.processedCount,
    queuedCount: (previous?.queuedCount ?? 0) + current.queuedCount,
    duplicateCount: (previous?.duplicateCount ?? 0) + current.duplicateCount,
    failureCount: (previous?.failureCount ?? 0) + current.failures.length,
    nextTarget: current.nextTarget,
    dispatchError: current.dispatchError ?? previous?.dispatchError ?? null,
    failures: [...(previous?.failures ?? []), ...current.failures].slice(0, 50),
  };
}
export async function processScheduleCalendarFanout(
  input: unknown,
  env: CloudflareEnvironment,
) {
  const message = scheduleCalendarFanoutMessageSchema.parse(input);
  const operation = await env.DB.prepare(
    `SELECT status, payload_json AS payloadJson, result_json AS resultJson,
            progress_completed AS progressCompleted, progress_failed AS progressFailed
       FROM operation_jobs
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'schedule.calendar_fanout' AND idempotency_key = ?`,
  )
    .bind(
      message.operationId,
      message.eventId,
      message.organisationId,
      message.idempotencyKey,
    )
    .first<{
      status: string;
      payloadJson: string;
      resultJson: string | null;
      progressCompleted: number;
      progressFailed: number;
    }>();
  if (!operation)
    throw new Error(
      "Schedule calendar fan-out operation does not exist in the authorised event.",
    );
  if (
    ["completed", "cancelled", "failed", "partially_failed"].includes(
      operation.status,
    )
  ) {
    return;
  }
  const saved = scheduleCalendarFanoutMessageSchema.safeParse(
    JSON.parse(operation.payloadJson),
  );
  if (!saved.success) {
    throw new Error(
      "The durable schedule calendar fan-out payload is invalid.",
    );
  }
  const sameIdentity =
    saved.data.type === message.type &&
    saved.data.operationId === message.operationId &&
    saved.data.scheduleVersionId === message.scheduleVersionId &&
    saved.data.eventId === message.eventId &&
    saved.data.organisationId === message.organisationId &&
    saved.data.idempotencyKey === message.idempotencyKey;
  if (!sameIdentity) {
    throw new Error(
      "The schedule calendar fan-out message does not match its durable operation identity.",
    );
  }
  if (saved.data.afterTarget !== message.afterTarget) {
    if (operation.status === "queued") {
      if (!env.OPERATIONS_QUEUE)
        throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
      await env.OPERATIONS_QUEUE.send(saved.data);
      return;
    }
    if (operation.status === "queue_failed") return;
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (
      current?.status === "running" &&
      current.claimToken &&
      (current.claimExpiresAt ?? 0) > Math.floor(Date.now() / 1_000)
    ) {
      throw new QueueClaimLeaseBusyError();
    }
    throw new Error(
      "The schedule calendar fan-out cursor does not match its durable operation payload.",
    );
  }

  const claimToken = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'running', started_at = COALESCE(started_at, unixepoch()),
            attempt_count = attempt_count + 1, last_error = NULL, completed_at = NULL,
            claim_token = ?, claim_expires_at = unixepoch() + ?, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'schedule.calendar_fanout' AND idempotency_key = ?
        AND payload_json = ?
        AND (
          status IN ('queued','received','retrying','queue_failed')
          OR (status = 'running' AND COALESCE(claim_expires_at, 0) <= unixepoch())
        )`,
  )
    .bind(
      claimToken,
      QUEUE_CLAIM_LEASE_SECONDS,
      message.operationId,
      message.eventId,
      message.organisationId,
      message.idempotencyKey,
      operation.payloadJson,
    )
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    const current = await env.DB.prepare(
      `SELECT status, payload_json AS payloadJson,
              claim_token AS claimToken, claim_expires_at AS claimExpiresAt
         FROM operation_jobs
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'schedule.calendar_fanout' AND idempotency_key = ?`,
    )
      .bind(
        message.operationId,
        message.eventId,
        message.organisationId,
        message.idempotencyKey,
      )
      .first<{
        status: string;
        payloadJson: string;
        claimToken: string | null;
        claimExpiresAt: number | null;
      }>();
    if (
      current &&
      ["completed", "cancelled", "failed", "partially_failed"].includes(
        current.status,
      )
    ) {
      return;
    }
    if (
      current?.status === "queued" &&
      current.payloadJson !== operation.payloadJson
    ) {
      const currentSaved = scheduleCalendarFanoutMessageSchema.safeParse(
        JSON.parse(current.payloadJson),
      );
      if (!currentSaved.success) {
        throw new Error(
          "The durable schedule calendar fan-out payload is invalid.",
        );
      }
      const currentHasSameIdentity =
        currentSaved.data.type === message.type &&
        currentSaved.data.operationId === message.operationId &&
        currentSaved.data.scheduleVersionId === message.scheduleVersionId &&
        currentSaved.data.eventId === message.eventId &&
        currentSaved.data.organisationId === message.organisationId &&
        currentSaved.data.idempotencyKey === message.idempotencyKey;
      if (!currentHasSameIdentity) {
        throw new Error(
          "The schedule calendar fan-out message does not match its durable operation identity.",
        );
      }
      if (!env.OPERATIONS_QUEUE)
        throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
      await env.OPERATIONS_QUEUE.send(currentSaved.data);
      return;
    }
    if (
      current?.status === "queue_failed" &&
      current.payloadJson !== operation.payloadJson
    )
      return;
    if (
      current?.status === "running" &&
      current.claimToken &&
      (current.claimExpiresAt ?? 0) > Math.floor(Date.now() / 1_000)
    ) {
      throw new QueueClaimLeaseBusyError();
    }
    throw new Error(
      "The schedule calendar fan-out claim could not be acquired.",
    );
  }

  try {
    const dispatch = await new CalendarService(env).queuePublishedSchedule(
      {
        organisationId: message.organisationId,
        eventId: message.eventId,
        personId: null,
      },
      message.scheduleVersionId,
      {
        operationId: message.operationId,
        afterTarget: message.afterTarget,
        beforeTarget: () =>
          renewOperationClaim(
            env,
            {
              organisationId: message.organisationId,
              eventId: message.eventId,
            },
            message.operationId,
            claimToken,
          ),
      },
    );
    const previousResult = operation.resultJson
      ? persistedCalendarFanoutResultSchema.parse(
          JSON.parse(operation.resultJson),
        )
      : null;
    if (
      (previousResult === null) !== (operation.progressCompleted === 0) ||
      (previousResult &&
        (previousResult.processedCount !== operation.progressCompleted ||
          previousResult.failureCount !== operation.progressFailed))
    ) {
      throw new Error(
        "The durable calendar fan-out result does not match its operation progress.",
      );
    }
    const cumulative = accumulateCalendarFanoutResult(previousResult, dispatch);
    const resultJson = JSON.stringify(cumulative);
    if (dispatch.nextTarget) {
      const continuationPayload = scheduleFanoutQueuePayload(
        message,
        dispatch.nextTarget,
      );
      const continuationMessage = scheduleCalendarFanoutMessageSchema.parse(
        JSON.parse(continuationPayload),
      );
      const [checkpointed, change, released] = await env.DB.batch([
        env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'queued', progress_total = ?, progress_completed = ?,
                  progress_failed = ?, payload_json = ?, result_json = ?,
                  last_error = NULL, claim_expires_at = NULL, updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND status = 'running' AND claim_token = ?`,
        ).bind(
          cumulative.targetCount,
          cumulative.processedCount,
          cumulative.failureCount,
          continuationPayload,
          resultJson,
          message.operationId,
          message.eventId,
          claimToken,
        ),
        env.DB.prepare(
          `INSERT INTO event_changes (
             event_id, entity_type, entity_id, change_type, correlation_id, created_at
           )
           SELECT event_id, 'operation_job', id, 'progress', ?, unixepoch()
             FROM operation_jobs
            WHERE id = ? AND event_id = ? AND status = 'queued'
              AND payload_json = ? AND claim_token = ?
           RETURNING sequence`,
        ).bind(
          message.idempotencyKey,
          message.operationId,
          message.eventId,
          continuationPayload,
          claimToken,
        ),
        env.DB.prepare(
          `UPDATE operation_jobs
              SET claim_token = NULL, updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND status = 'queued'
              AND payload_json = ? AND claim_token = ?`,
        ).bind(
          message.operationId,
          message.eventId,
          continuationPayload,
          claimToken,
        ),
      ]);
      if (
        (checkpointed.meta.changes ?? 0) !== 1 ||
        (released.meta.changes ?? 0) !== 1
      ) {
        throw new QueueClaimLeaseLostError();
      }
      try {
        if (!env.OPERATIONS_QUEUE)
          throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
        await env.OPERATIONS_QUEUE.send(continuationMessage);
      } catch (error) {
        const failure = errorDetails(error);
        await env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND status = 'queued' AND payload_json = ?`,
        )
          .bind(
            failure.message,
            message.operationId,
            message.eventId,
            continuationPayload,
          )
          .run();
      }
      await notifyRealtimeAfterCommit(
        env,
        {
          organisationId: message.organisationId,
          eventId: message.eventId,
        },
        returnedChangeSequence(change),
        message.operationId,
      );
      return cumulative;
    }
    if (cumulative.processedCount !== cumulative.targetCount) {
      throw new Error(
        "The calendar fan-out ended before every durable target was processed.",
      );
    }
    const successfulCount = cumulative.queuedCount + cumulative.duplicateCount;
    const status = cumulative.dispatchError
      ? "failed"
      : cumulative.failureCount === 0
        ? "completed"
        : successfulCount > 0
          ? "partially_failed"
          : "failed";
    const lastError =
      cumulative.dispatchError ??
      (cumulative.failureCount
        ? `${cumulative.failureCount} of ${cumulative.targetCount} calendar lifecycle operations could not be queued.`
        : null);
    const [completed, change, released] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE operation_jobs
          SET status = ?, progress_total = ?, progress_completed = ?, progress_failed = ?,
              payload_json = ?, result_json = ?, last_error = ?, completed_at = unixepoch(),
              claim_expires_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status = 'running' AND claim_token = ?`,
      ).bind(
        status,
        cumulative.targetCount,
        cumulative.processedCount,
        cumulative.failureCount,
        scheduleFanoutQueuePayload(message),
        resultJson,
        lastError,
        message.operationId,
        message.eventId,
        claimToken,
      ),
      env.DB.prepare(
        `INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, correlation_id, created_at
        )
        SELECT event_id, 'operation_job', id, 'progress', ?, unixepoch()
          FROM operation_jobs
         WHERE id = ? AND event_id = ? AND status = ? AND claim_token = ?
        RETURNING sequence`,
      ).bind(
        message.idempotencyKey,
        message.operationId,
        message.eventId,
        status,
        claimToken,
      ),
      env.DB.prepare(
        `UPDATE operation_jobs
            SET claim_token = NULL, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND status = ? AND claim_token = ?`,
      ).bind(message.operationId, message.eventId, status, claimToken),
    ]);
    if (
      (completed.meta.changes ?? 0) !== 1 ||
      (released.meta.changes ?? 0) !== 1
    )
      throw new QueueClaimLeaseLostError();
    await notifyRealtimeAfterCommit(
      env,
      {
        organisationId: message.organisationId,
        eventId: message.eventId,
      },
      returnedChangeSequence(change),
      message.operationId,
    );
    return cumulative;
  } catch (error) {
    const failure = errorDetails(error);
    const [failed, change, released] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'failed', last_error = ?, completed_at = unixepoch(),
                claim_expires_at = NULL, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND status = 'running' AND claim_token = ?`,
      ).bind(failure.message, message.operationId, message.eventId, claimToken),
      env.DB.prepare(
        `INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, correlation_id, created_at
        )
        SELECT event_id, 'operation_job', id, 'progress', ?, unixepoch()
          FROM operation_jobs
         WHERE id = ? AND event_id = ? AND status = 'failed' AND claim_token = ?
        RETURNING sequence`,
      ).bind(
        message.idempotencyKey,
        message.operationId,
        message.eventId,
        claimToken,
      ),
      env.DB.prepare(
        `UPDATE operation_jobs
            SET claim_token = NULL, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND status = 'failed' AND claim_token = ?`,
      ).bind(message.operationId, message.eventId, claimToken),
    ]);
    if (
      (failed.meta.changes ?? 0) === 1 &&
      (released.meta.changes ?? 0) === 1
    ) {
      await notifyRealtimeAfterCommit(
        env,
        {
          organisationId: message.organisationId,
          eventId: message.eventId,
        },
        returnedChangeSequence(change),
        message.operationId,
      );
    }
    throw error;
  }
}
