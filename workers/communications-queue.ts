import { z } from "zod";

import {
  calendarQueueMessageSchema,
  scheduleCalendarFanoutMessageSchema,
  type CalendarQueueMessage,
} from "../app/modules/calendars/calendar-schema";
import {
  CalendarService,
  type PublishedScheduleCalendarDispatch,
} from "../app/modules/calendars/calendar-service.server";
import {
  decryptCalendarCredentials,
  GoogleCalendarProvider,
  MicrosoftCalendarProvider,
  type DirectCalendarProvider,
} from "../app/modules/calendars/calendar-providers.server";
import {
  generateInvitationIcs,
  hashCalendarLifecyclePayload,
} from "../app/modules/calendars/ics.server";
import { templateContentSchema } from "../app/modules/communications/communication-schema";
import { renderProgramCueEmail } from "../app/modules/communications/email-templates/render-email.server";
import {
  formatEventDateMarkers,
  renderMergeTemplate,
} from "../app/modules/communications/merge-template";
import { ResendEmailProvider } from "../app/modules/communications/resend.server";
import { createCommunicationUnsubscribeUrl } from "../app/modules/communications/unsubscribe.server";
import { EventRealtimeService } from "../app/platform/realtime/event-realtime.server";

const communicationQueueMessageSchema = z.object({
  type: z.literal("communication.send"),
  operationId: z.string().min(1),
  communicationId: z.string().min(1),
  eventId: z.string().min(1),
  organisationId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  includeFailed: z.boolean().optional(),
});

export const COMMUNICATION_SEND_BATCH_SIZE = 10;

function communicationQueuePayload(
  message: z.infer<typeof communicationQueueMessageSchema>,
  includeFailed: boolean,
) {
  return JSON.stringify({
    type: message.type,
    operationId: message.operationId,
    communicationId: message.communicationId,
    eventId: message.eventId,
    organisationId: message.organisationId,
    idempotencyKey: message.idempotencyKey,
    ...(includeFailed ? { includeFailed: true } : {}),
  });
}

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

const contentSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  category: z.string(),
  subjectTemplate: z.string(),
  content: templateContentSchema,
  event: z.object({
    eventName: z.string(),
    startsAt: z.number(),
    endsAt: z.number(),
  }),
});

const sourceMergeValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.null()]),
);

type QueueProviderDependencies = {
  resend?: ResendEmailProvider;
  directCalendar?: DirectCalendarProvider;
};

export const QUEUE_CLAIM_LEASE_SECONDS = 60;

export class QueueClaimLeaseBusyError extends Error {
  readonly retryAfterSeconds = QUEUE_CLAIM_LEASE_SECONDS;

  constructor() {
    super(
      "This operation is already being processed under an active Queue claim lease.",
    );
    this.name = "QueueClaimLeaseBusyError";
  }
}

class QueueClaimLeaseLostError extends Error {
  constructor() {
    super(
      "The Queue claim lease changed before the provider result could be recorded.",
    );
    this.name = "QueueClaimLeaseLostError";
  }
}

type OperationClaimState = {
  status: string;
  claimToken: string | null;
  claimExpiresAt: number | null;
};

async function loadOperationClaim(
  env: CloudflareEnvironment,
  operationId: string,
  eventId: string,
) {
  return env.DB.prepare(
    `
    SELECT status, claim_token AS claimToken, claim_expires_at AS claimExpiresAt
      FROM operation_jobs WHERE id = ? AND event_id = ?
  `,
  )
    .bind(operationId, eventId)
    .first<OperationClaimState>();
}

async function renewOperationClaim(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  operationId: string,
  claimToken: string,
) {
  const renewed = await env.DB.prepare(
    `
    UPDATE operation_jobs
       SET claim_expires_at = unixepoch() + ?, updated_at = unixepoch()
     WHERE id = ? AND event_id = ? AND organisation_id = ?
       AND status = 'running' AND claim_token = ?
  `,
  )
    .bind(
      QUEUE_CLAIM_LEASE_SECONDS,
      operationId,
      scope.eventId,
      scope.organisationId,
      claimToken,
    )
    .run();
  if ((renewed.meta.changes ?? 0) !== 1) throw new QueueClaimLeaseLostError();
}

async function assertOperationClaim(
  env: CloudflareEnvironment,
  operationId: string,
  eventId: string,
  claimToken: string,
) {
  const claim = await loadOperationClaim(env, operationId, eventId);
  if (claim?.status !== "running" || claim.claimToken !== claimToken) {
    throw new QueueClaimLeaseLostError();
  }
}

function errorDetails(error: unknown) {
  return {
    code:
      error instanceof Error
        ? error.name.slice(0, 120)
        : "UNKNOWN_PROVIDER_ERROR",
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      2_000,
    ),
  };
}

async function finishOwnedCommunicationFailure(
  env: CloudflareEnvironment,
  message: z.infer<typeof communicationQueueMessageSchema>,
  claimToken: string,
  error: unknown,
) {
  const failure = errorDetails(error);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE communication_deliveries
      SET status = 'failed', failure_code = ?, failure_message = ?, next_attempt_at = NULL,
          updated_at = unixepoch()
      WHERE communication_id = ? AND event_id = ? AND status IN ('queued','sending','failed')
        AND EXISTS (
          SELECT 1 FROM operation_jobs owned_operation
           WHERE owned_operation.id = ? AND owned_operation.event_id = ?
             AND owned_operation.status = 'running' AND owned_operation.claim_token = ?
        )`,
    ).bind(
      failure.code,
      failure.message,
      message.communicationId,
      message.eventId,
      message.operationId,
      message.eventId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = unixepoch(),
          updated_at = unixepoch()
      WHERE operation_id = ? AND status IN ('pending','running','failed')
        AND EXISTS (
          SELECT 1 FROM operation_jobs owned_operation
           WHERE owned_operation.id = operation_items.operation_id
             AND owned_operation.event_id = ?
             AND owned_operation.status = 'running' AND owned_operation.claim_token = ?
        )`,
    ).bind(
      failure.code,
      failure.message,
      message.operationId,
      message.eventId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE communications
      SET status = 'failed', updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND operation_id = ? AND status = 'sending'
        AND EXISTS (
          SELECT 1 FROM operation_jobs owned_operation
           WHERE owned_operation.id = communications.operation_id
             AND owned_operation.event_id = communications.event_id
             AND owned_operation.status = 'running' AND owned_operation.claim_token = ?
        )`,
    ).bind(
      message.communicationId,
      message.eventId,
      message.operationId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'failed',
          progress_total = (
            SELECT COUNT(*) FROM communication_deliveries
             WHERE communication_id = ? AND event_id = ?
          ),
          progress_completed = (
            SELECT COUNT(*) FROM communication_deliveries
             WHERE communication_id = ? AND event_id = ?
          ),
          progress_failed = (
            SELECT COUNT(*) FROM communication_deliveries
             WHERE communication_id = ? AND event_id = ?
               AND status NOT IN ('sent','delivered','opened','clicked')
          ),
          payload_json = ?, last_error = ?, completed_at = unixepoch(), claim_token = NULL,
          claim_expires_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND status = 'running' AND claim_token = ?
        AND EXISTS (
          SELECT 1 FROM communications failed_communication
           WHERE failed_communication.id = ?
             AND failed_communication.event_id = operation_jobs.event_id
             AND failed_communication.operation_id = operation_jobs.id
             AND failed_communication.status = 'failed'
        )`,
    ).bind(
      message.communicationId,
      message.eventId,
      message.communicationId,
      message.eventId,
      message.communicationId,
      message.eventId,
      communicationQueuePayload(message, true),
      failure.message,
      message.operationId,
      message.eventId,
      claimToken,
      message.communicationId,
    ),
  ]);
}

function returnedChangeSequence(result: { results?: unknown[] } | undefined) {
  const row = result?.results?.[0] as { sequence?: unknown } | undefined;
  return typeof row?.sequence === "number" && Number.isSafeInteger(row.sequence)
    ? row.sequence
    : null;
}

/**
 * Provider and D1 results are already committed at this boundary. A realtime
 * failure is recorded as an operation warning and logged, while authoritative
 * cursor polling remains available; it must never turn a successful provider
 * call into another delivery attempt.
 */
async function notifyRealtimeAfterCommit(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  sequence: number | null,
  operationId: string,
) {
  let warning: string | null =
    sequence === null
      ? "The committed event change did not return a sequence."
      : null;
  if (sequence !== null) {
    try {
      await new EventRealtimeService(env).notifyCommittedChange(
        scope,
        sequence,
      );
    } catch (error) {
      warning = `Realtime invalidation failed after commit: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!warning) return;
  const message = warning.slice(0, 2_000);
  try {
    await env.DB.prepare(
      `UPDATE operation_jobs
      SET result_json = json_set(COALESCE(result_json, '{}'), '$.realtimeWarning', ?), updated_at = unixepoch()
      WHERE id = ? AND event_id = ?`,
    )
      .bind(message, operationId, scope.eventId)
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        subsystem: "realtime-invalidation",
        operationId,
        message: `Could not persist realtime warning: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }
  console.warn(
    JSON.stringify({
      level: "warning",
      subsystem: "realtime-invalidation",
      operationId,
      eventId: scope.eventId,
      changeSequence: sequence,
      message,
    }),
  );
}

export async function processCommunicationSend(
  input: unknown,
  env: CloudflareEnvironment,
  dependencies: QueueProviderDependencies = {},
) {
  const message = communicationQueueMessageSchema.parse(input);
  const operation = await env.DB.prepare(
    `
    SELECT o.id, o.status
      FROM operation_jobs o
      JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
     WHERE o.id = ? AND o.event_id = ? AND o.type IN ('communication.send','decision.notification','submission.notification')
  `,
  )
    .bind(message.organisationId, message.operationId, message.eventId)
    .first<{ id: string; status: string }>();
  if (!operation)
    throw new Error(
      "Communication operation does not exist in the authorised event.",
    );
  if (operation.status === "completed" || operation.status === "cancelled")
    return;
  const includeFailed =
    message.includeFailed === true ||
    ["failed", "partially_failed", "retrying", "running"].includes(
      operation.status,
    );

  const communication = await env.DB.prepare(
    `
    SELECT c.id, c.status, c.kind, c.recipient_count AS recipientCount,
           c.content_snapshot_json AS contentSnapshotJson,
           sp.from_name AS fromName, sp.from_email AS fromEmail,
           sp.reply_to_email AS replyToEmail
      FROM communications c
      LEFT JOIN sender_profiles sp ON sp.id = c.sender_profile_id AND sp.event_id = c.event_id
        AND sp.status = 'verified' AND sp.provider = 'resend'
     WHERE c.id = ? AND c.event_id = ? AND c.operation_id = ? AND c.idempotency_key = ?
  `,
  )
    .bind(
      message.communicationId,
      message.eventId,
      message.operationId,
      message.idempotencyKey,
    )
    .first<{
      id: string;
      status: string;
      kind: "transactional" | "optional";
      recipientCount: number;
      contentSnapshotJson: string;
      fromName: string | null;
      fromEmail: string | null;
      replyToEmail: string | null;
    }>();
  if (!communication)
    throw new Error(
      "Communication does not exist for this operation in the authorised event.",
    );
  if (communication.status === "cancelled") return;
  if (!communication.fromName || !communication.fromEmail)
    throw new Error("A verified Resend sender is unavailable.");
  const snapshot = contentSnapshotSchema.parse(
    JSON.parse(communication.contentSnapshotJson),
  );
  const deliveries = await env.DB.prepare(
    `
    SELECT d.id, d.person_id AS personId, d.recipient_address AS address,
           COALESCE(d.recipient_name, d.recipient_address) AS name,
           d.idempotency_key AS idempotencyKey,
           d.source_values_json AS sourceValuesJson
      FROM communication_deliveries d
     WHERE d.communication_id = ? AND d.event_id = ?
       AND d.status IN ('queued','failed','sending')
       AND (? = 1 OR d.status <> 'failed')
     ORDER BY d.created_at, d.id
     LIMIT ?
  `,
  )
    .bind(
      message.communicationId,
      message.eventId,
      includeFailed ? 1 : 0,
      COMMUNICATION_SEND_BATCH_SIZE,
    )
    .all<{
      id: string;
      personId: string | null;
      address: string;
      name: string;
      idempotencyKey: string;
      sourceValuesJson: string;
    }>();

  // The immutable operation ID plus the queued/sending transition is the send
  // claim. This batch serialises against CommunicationService.cancel's batch.
  const claimToken = crypto.randomUUID();
  const claimResults = await env.DB.batch([
    env.DB.prepare(
      `
      UPDATE communications
         SET status = 'sending', updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND operation_id = ? AND idempotency_key = ?
         AND status IN ('queued','failed','partially_failed','sending')
         AND EXISTS (
           SELECT 1
             FROM operation_jobs claim_operation
             JOIN events claim_event ON claim_event.id = claim_operation.event_id
            WHERE claim_operation.id = communications.operation_id
              AND claim_operation.event_id = communications.event_id
              AND (
                claim_operation.status IN ('queued','received','retrying','queue_failed','failed','partially_failed')
                OR (
                  claim_operation.status = 'running'
                  AND COALESCE(claim_operation.claim_expires_at, 0) <= unixepoch()
                )
              )
              AND claim_event.organisation_id = ?
         )
    `,
    ).bind(
      message.communicationId,
      message.eventId,
      message.operationId,
      message.idempotencyKey,
      message.organisationId,
    ),
    env.DB.prepare(
      `
      UPDATE operation_jobs
         SET status = 'running', started_at = COALESCE(started_at, unixepoch()),
             attempt_count = attempt_count + 1, last_error = NULL, completed_at = NULL,
             claim_token = ?, claim_expires_at = unixepoch() + ?,
             updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND (
           status IN ('queued','received','retrying','queue_failed','failed','partially_failed')
           OR (status = 'running' AND COALESCE(claim_expires_at, 0) <= unixepoch())
         )
         AND EXISTS (
           SELECT 1
             FROM communications claimed_communication
            WHERE claimed_communication.id = ?
              AND claimed_communication.event_id = operation_jobs.event_id
              AND claimed_communication.operation_id = operation_jobs.id
              AND claimed_communication.idempotency_key = ?
              AND claimed_communication.status = 'sending'
         )
    `,
    ).bind(
      claimToken,
      QUEUE_CLAIM_LEASE_SECONDS,
      message.operationId,
      message.eventId,
      message.organisationId,
      message.communicationId,
      message.idempotencyKey,
    ),
  ]);
  const communicationClaimed = (claimResults[0].meta.changes ?? 0) === 1;
  const operationClaimed = (claimResults[1].meta.changes ?? 0) === 1;
  if (!communicationClaimed && !operationClaimed) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "cancelled")
      return;
    if (
      current?.status === "running" &&
      current.claimToken &&
      (current.claimExpiresAt ?? 0) > Math.floor(Date.now() / 1_000)
    ) {
      throw new QueueClaimLeaseBusyError();
    }
    throw new Error("The communication send claim could not be acquired.");
  }
  if (!communicationClaimed || !operationClaimed) {
    throw new Error(
      "The communication send claim could not be recorded consistently.",
    );
  }

  try {
    const provider =
      dependencies.resend ?? new ResendEmailProvider(env.RESEND_API_KEY);
    for (const delivery of deliveries.results) {
      await renewOperationClaim(
        env,
        { organisationId: message.organisationId, eventId: message.eventId },
        message.operationId,
        claimToken,
      );
      const deliveryClaimResults = await env.DB.batch([
        env.DB.prepare(
          `
        UPDATE communication_deliveries
           SET status = 'suppressed', failure_code = 'recipient_unsubscribed',
               failure_message = 'Recipient unsubscribed before provider delivery.',
               next_attempt_at = NULL, updated_at = unixepoch()
         WHERE id = ? AND communication_id = ? AND event_id = ? AND status IN ('queued','failed','sending')
           AND EXISTS (
             SELECT 1 FROM communication_unsubscribes u
              WHERE u.event_id = communication_deliveries.event_id
                AND lower(u.address) = lower(communication_deliveries.recipient_address)
                AND u.revoked_at IS NULL
                AND (u.category = '*' OR (? = 'optional' AND u.category = ?))
           )
           AND EXISTS (
             SELECT 1 FROM communications claimed_communication
             JOIN operation_jobs claimed_operation
               ON claimed_operation.id = claimed_communication.operation_id
              AND claimed_operation.event_id = claimed_communication.event_id
              WHERE claimed_communication.id = communication_deliveries.communication_id
                AND claimed_communication.event_id = communication_deliveries.event_id
                AND claimed_communication.operation_id = ?
                AND claimed_communication.status = 'sending'
                AND claimed_operation.status = 'running'
                AND claimed_operation.claim_token = ?
           )
      `,
        ).bind(
          delivery.id,
          message.communicationId,
          message.eventId,
          communication.kind,
          snapshot.category,
          message.operationId,
          claimToken,
        ),
        env.DB.prepare(
          `
        UPDATE operation_items
           SET status = 'skipped', result_json = json_object('reason', 'recipient_unsubscribed'),
               completed_at = unixepoch(), updated_at = unixepoch()
         WHERE operation_id = ? AND entity_id = ? AND status IN ('pending','failed','running')
           AND EXISTS (
             SELECT 1 FROM communication_deliveries suppressed_delivery
             JOIN operation_jobs claimed_operation ON claimed_operation.id = operation_items.operation_id
              WHERE suppressed_delivery.id = operation_items.entity_id
                AND suppressed_delivery.communication_id = ?
                AND suppressed_delivery.event_id = ?
                AND suppressed_delivery.status = 'suppressed'
                AND suppressed_delivery.failure_code = 'recipient_unsubscribed'
                AND claimed_operation.status = 'running'
                AND claimed_operation.claim_token = ?
           )
      `,
        ).bind(
          message.operationId,
          delivery.id,
          message.communicationId,
          message.eventId,
          claimToken,
        ),
        env.DB.prepare(
          `
        UPDATE communication_deliveries
           SET status = 'sending', attempt_count = attempt_count + 1,
               failure_code = NULL, failure_message = NULL, updated_at = unixepoch()
         WHERE id = ? AND communication_id = ? AND event_id = ? AND status IN ('queued','failed','sending')
           AND NOT EXISTS (
               SELECT 1 FROM communication_unsubscribes u
                WHERE u.event_id = communication_deliveries.event_id
                  AND lower(u.address) = lower(communication_deliveries.recipient_address)
                  AND u.revoked_at IS NULL
                  AND (u.category = '*' OR (? = 'optional' AND u.category = ?))
           )
           AND EXISTS (
             SELECT 1 FROM communications claimed_communication
             JOIN operation_jobs claimed_operation
               ON claimed_operation.id = claimed_communication.operation_id
              AND claimed_operation.event_id = claimed_communication.event_id
              WHERE claimed_communication.id = communication_deliveries.communication_id
                AND claimed_communication.event_id = communication_deliveries.event_id
                AND claimed_communication.operation_id = ?
                AND claimed_communication.status = 'sending'
                AND claimed_operation.status = 'running'
                AND claimed_operation.claim_token = ?
           )
      `,
        ).bind(
          delivery.id,
          message.communicationId,
          message.eventId,
          communication.kind,
          snapshot.category,
          message.operationId,
          claimToken,
        ),
        env.DB.prepare(
          `
        UPDATE operation_items
           SET status = 'running', attempt_count = attempt_count + 1,
               started_at = COALESCE(started_at, unixepoch()), completed_at = NULL,
               error_code = NULL, error_message = NULL, updated_at = unixepoch()
         WHERE operation_id = ? AND entity_id = ? AND status IN ('pending','failed','running')
           AND EXISTS (
             SELECT 1 FROM communication_deliveries claimed_delivery
             JOIN operation_jobs claimed_operation ON claimed_operation.id = operation_items.operation_id
              WHERE claimed_delivery.id = operation_items.entity_id
                AND claimed_delivery.communication_id = ?
                AND claimed_delivery.event_id = ?
                AND claimed_delivery.status = 'sending'
                AND claimed_operation.status = 'running'
                AND claimed_operation.claim_token = ?
           )
      `,
        ).bind(
          message.operationId,
          delivery.id,
          message.communicationId,
          message.eventId,
          claimToken,
        ),
      ]);
      if ((deliveryClaimResults[0].meta.changes ?? 0) === 1) {
        if ((deliveryClaimResults[1].meta.changes ?? 0) !== 1) {
          throw new Error(
            "The recipient suppression could not be recorded consistently.",
          );
        }
        continue;
      }
      if ((deliveryClaimResults[2].meta.changes ?? 0) !== 1) {
        await assertOperationClaim(
          env,
          message.operationId,
          message.eventId,
          claimToken,
        );
        throw new Error(
          "The communication delivery could not be claimed while its operation remained active.",
        );
      }
      if ((deliveryClaimResults[3].meta.changes ?? 0) !== 1) {
        throw new Error(
          "The communication operation item could not be claimed consistently with its delivery.",
        );
      }
      try {
        const values = {
          "recipient.name": delivery.name,
          "recipient.firstName":
            delivery.name.trim().split(/\s+/)[0] || delivery.name,
          "event.name": snapshot.event.eventName,
          "event.dates": formatEventDateMarkers(
            snapshot.event.startsAt,
            snapshot.event.endsAt,
          ),
          ...sourceMergeValuesSchema.parse(
            JSON.parse(delivery.sourceValuesJson),
          ),
        };
        const subject = renderMergeTemplate(snapshot.subjectTemplate, values);
        const body = renderMergeTemplate(snapshot.content.body, values);
        const rendered = await renderProgramCueEmail({
          preview: subject,
          heading: subject,
          body,
          eventName: snapshot.event.eventName,
          physicalAddress: snapshot.content.physicalAddress,
          buttonText: snapshot.content.buttonText,
          buttonUrl: snapshot.content.buttonUrl,
          unsubscribeUrl:
            communication.kind === "optional"
              ? await createCommunicationUnsubscribeUrl(env, delivery.id)
              : undefined,
        });
        const result = await provider.send({
          from: `${communication.fromName} <${communication.fromEmail}>`,
          replyTo: communication.replyToEmail,
          to: delivery.address,
          subject,
          html: rendered.html,
          text: rendered.text,
          idempotencyKey: delivery.idempotencyKey,
        });
        const deliveryCompletionResults = await env.DB.batch([
          env.DB.prepare(
            `UPDATE communication_deliveries SET status = 'sent', provider = ?, provider_message_id = ?,
          failure_code = NULL, failure_message = NULL, updated_at = unixepoch()
          WHERE id = ? AND communication_id = ? AND event_id = ? AND status = 'sending'
            AND EXISTS (
              SELECT 1 FROM communications claimed_communication
              JOIN operation_jobs claimed_operation
                ON claimed_operation.id = claimed_communication.operation_id
               AND claimed_operation.event_id = claimed_communication.event_id
               WHERE claimed_communication.id = communication_deliveries.communication_id
                 AND claimed_communication.event_id = communication_deliveries.event_id
                 AND claimed_communication.operation_id = ?
                 AND claimed_communication.status = 'sending'
                 AND claimed_operation.status = 'running'
                 AND claimed_operation.claim_token = ?
            )`,
          ).bind(
            result.provider,
            result.messageId,
            delivery.id,
            message.communicationId,
            message.eventId,
            message.operationId,
            claimToken,
          ),
          env.DB.prepare(
            `UPDATE operation_items SET status = 'completed', result_json = ?, completed_at = unixepoch(),
          updated_at = unixepoch() WHERE operation_id = ? AND entity_id = ? AND status = 'running'
            AND EXISTS (
              SELECT 1 FROM communication_deliveries completed_delivery
              JOIN operation_jobs claimed_operation ON claimed_operation.id = operation_items.operation_id
               WHERE completed_delivery.id = operation_items.entity_id
                 AND completed_delivery.communication_id = ?
                 AND completed_delivery.event_id = ?
                 AND completed_delivery.status = 'sent'
                 AND completed_delivery.provider_message_id = ?
                 AND claimed_operation.status = 'running'
                 AND claimed_operation.claim_token = ?
            )`,
          ).bind(
            JSON.stringify({
              provider: result.provider,
              providerMessageId: result.messageId,
            }),
            message.operationId,
            delivery.id,
            message.communicationId,
            message.eventId,
            result.messageId,
            claimToken,
          ),
        ]);
        if ((deliveryCompletionResults[0].meta.changes ?? 0) !== 1) {
          throw new Error(
            "The delivery send claim changed before the provider result could be recorded.",
          );
        }
        if ((deliveryCompletionResults[1].meta.changes ?? 0) !== 1) {
          throw new Error(
            "The communication operation item could not record the provider result consistently.",
          );
        }
      } catch (error) {
        const failure = errorDetails(error);
        const failureResults = await env.DB.batch([
          env.DB.prepare(
            `UPDATE communication_deliveries SET status = 'failed', failure_code = ?, failure_message = ?,
          next_attempt_at = unixepoch() + 60, updated_at = unixepoch()
          WHERE id = ? AND communication_id = ? AND event_id = ? AND status = 'sending'
            AND EXISTS (
              SELECT 1 FROM communications claimed_communication
              JOIN operation_jobs claimed_operation
                ON claimed_operation.id = claimed_communication.operation_id
               AND claimed_operation.event_id = claimed_communication.event_id
               WHERE claimed_communication.id = communication_deliveries.communication_id
                 AND claimed_communication.event_id = communication_deliveries.event_id
                 AND claimed_communication.operation_id = ?
                 AND claimed_communication.status = 'sending'
                 AND claimed_operation.status = 'running'
                 AND claimed_operation.claim_token = ?
            )`,
          ).bind(
            failure.code,
            failure.message,
            delivery.id,
            message.communicationId,
            message.eventId,
            message.operationId,
            claimToken,
          ),
          env.DB.prepare(
            `UPDATE operation_items SET status = 'failed', error_code = ?, error_message = ?,
          completed_at = unixepoch(), updated_at = unixepoch()
          WHERE operation_id = ? AND entity_id = ? AND status = 'running'
            AND EXISTS (
              SELECT 1 FROM communication_deliveries failed_delivery
              JOIN operation_jobs claimed_operation ON claimed_operation.id = operation_items.operation_id
               WHERE failed_delivery.id = operation_items.entity_id
                 AND failed_delivery.communication_id = ?
                 AND failed_delivery.event_id = ?
                 AND failed_delivery.status = 'failed'
                 AND claimed_operation.status = 'running'
                 AND claimed_operation.claim_token = ?
            )`,
          ).bind(
            failure.code,
            failure.message,
            message.operationId,
            delivery.id,
            message.communicationId,
            message.eventId,
            claimToken,
          ),
        ]);
        if ((failureResults[0].meta.changes ?? 0) !== 1) {
          await assertOperationClaim(
            env,
            message.operationId,
            message.eventId,
            claimToken,
          );
          throw error;
        }
        if ((failureResults[1].meta.changes ?? 0) !== 1) {
          throw new Error(
            "The communication operation item could not record the delivery failure consistently.",
          );
        }
      }
    }

    await renewOperationClaim(
      env,
      { organisationId: message.organisationId, eventId: message.eventId },
      message.operationId,
      claimToken,
    );
    const counts = await env.DB.prepare(
      `
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status IN ('sent','delivered','opened','clicked') THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status IN ('failed','bounced','suppressed') THEN 1 ELSE 0 END) AS failed,
           (SELECT COUNT(*)
              FROM operation_items oi
              JOIN communication_deliveries item_delivery ON item_delivery.id = oi.entity_id
             WHERE oi.operation_id = ? AND item_delivery.communication_id = ?) AS itemTotal,
           (SELECT COUNT(*)
              FROM operation_items oi
              JOIN communication_deliveries item_delivery ON item_delivery.id = oi.entity_id
             WHERE oi.operation_id = ? AND item_delivery.communication_id = ?
               AND oi.status IN ('completed','failed','skipped')) AS terminalItems
      FROM communication_deliveries WHERE communication_id = ?
  `,
    )
      .bind(
        message.operationId,
        message.communicationId,
        message.operationId,
        message.communicationId,
        message.communicationId,
      )
      .first<{
        total: number;
        succeeded: number | null;
        failed: number | null;
        itemTotal: number;
        terminalItems: number;
      }>();
    if (
      !counts ||
      !Number.isInteger(counts.total) ||
      counts.total < 1 ||
      counts.succeeded === null ||
      !Number.isInteger(counts.succeeded) ||
      counts.failed === null ||
      !Number.isInteger(counts.failed) ||
      counts.total !== communication.recipientCount ||
      counts.itemTotal !== counts.total
    ) {
      throw new Error(
        "The communication delivery totals do not match its durable recipient intent.",
      );
    }
    const { total, succeeded, failed } = counts;
    if (succeeded + failed !== total || counts.terminalItems !== total) {
      if (deliveries.results.length === 0) {
        throw new Error(
          "The communication has non-terminal deliveries but none can be processed by this Queue pass.",
        );
      }
      await assertOperationClaim(
        env,
        message.operationId,
        message.eventId,
        claimToken,
      );
      const continuationPayload = communicationQueuePayload(
        message,
        includeFailed,
      );
      const continuationMessage = communicationQueueMessageSchema.parse(
        JSON.parse(continuationPayload),
      );
      const continuationResults = await env.DB.batch([
        env.DB.prepare(
          `UPDATE communications SET status = 'queued', updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND operation_id = ? AND status = 'sending'
              AND EXISTS (
                SELECT 1 FROM operation_jobs claimed_operation
                 WHERE claimed_operation.id = communications.operation_id
                   AND claimed_operation.event_id = communications.event_id
                   AND claimed_operation.status = 'running'
                   AND claimed_operation.claim_token = ?
              )`,
        ).bind(
          message.communicationId,
          message.eventId,
          message.operationId,
          claimToken,
        ),
        env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'queued', progress_total = ?, progress_completed = ?,
                  progress_failed = ?, payload_json = ?, last_error = NULL,
                  claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND status = 'running' AND claim_token = ?`,
        ).bind(
          total,
          counts.terminalItems,
          failed,
          continuationPayload,
          message.operationId,
          message.eventId,
          claimToken,
        ),
        env.DB.prepare(
          `INSERT INTO event_changes (
             event_id, entity_type, entity_id, change_type, correlation_id, created_at
           )
           SELECT event_id, 'communication', ?, 'progress', correlation_id, unixepoch()
             FROM operation_jobs
            WHERE id = ? AND event_id = ? AND status = 'queued' AND payload_json = ?
           RETURNING sequence`,
        ).bind(
          message.communicationId,
          message.operationId,
          message.eventId,
          continuationPayload,
        ),
      ]);
      if (
        (continuationResults[0].meta.changes ?? 0) !== 1 ||
        (continuationResults[1].meta.changes ?? 0) !== 1
      ) {
        throw new QueueClaimLeaseLostError();
      }
      try {
        if (!env.OPERATIONS_QUEUE)
          throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
        await env.OPERATIONS_QUEUE.send(continuationMessage);
      } catch (error) {
        const failure = errorDetails(error);
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE operation_jobs
                SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
              WHERE id = ? AND event_id = ? AND status = 'queued' AND payload_json = ?`,
          ).bind(
            failure.message,
            message.operationId,
            message.eventId,
            continuationPayload,
          ),
          env.DB.prepare(
            `UPDATE communications SET status = 'failed', updated_at = unixepoch()
              WHERE id = ? AND event_id = ? AND operation_id = ? AND status = 'queued'
                AND EXISTS (
                  SELECT 1 FROM operation_jobs failed_operation
                   WHERE failed_operation.id = communications.operation_id
                     AND failed_operation.event_id = communications.event_id
                     AND failed_operation.status = 'queue_failed'
                )`,
          ).bind(message.communicationId, message.eventId, message.operationId),
        ]);
      }
      await notifyRealtimeAfterCommit(
        env,
        { organisationId: message.organisationId, eventId: message.eventId },
        returnedChangeSequence(continuationResults.at(-1)),
        message.operationId,
      );
      return;
    }
    const operationStatus =
      failed === 0 ? "completed" : succeeded ? "partially_failed" : "failed";
    const communicationStatus =
      failed === 0 ? "sent" : succeeded ? "partially_failed" : "failed";
    const completionResults = await env.DB.batch([
      env.DB.prepare(
        `UPDATE communications SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN unixepoch() ELSE sent_at END,
      updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND operation_id = ? AND status = 'sending'
        AND EXISTS (
          SELECT 1 FROM operation_jobs claimed_operation
           WHERE claimed_operation.id = communications.operation_id
             AND claimed_operation.event_id = communications.event_id
             AND claimed_operation.status = 'running'
             AND claimed_operation.claim_token = ?
        )`,
      ).bind(
        communicationStatus,
        communicationStatus,
        message.communicationId,
        message.eventId,
        message.operationId,
        claimToken,
      ),
      env.DB.prepare(
        `UPDATE operation_jobs SET status = ?, progress_total = ?, progress_completed = ?, progress_failed = ?,
      payload_json = ?, last_error = CASE WHEN ? > 0 THEN ? ELSE NULL END, completed_at = unixepoch(),
      claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND status = 'running' AND claim_token = ?
        AND EXISTS (
          SELECT 1 FROM communications completed_communication
           WHERE completed_communication.id = ?
             AND completed_communication.event_id = operation_jobs.event_id
             AND completed_communication.operation_id = operation_jobs.id
             AND completed_communication.status = ?
        )`,
      ).bind(
        operationStatus,
        total,
        succeeded + failed,
        failed,
        communicationQueuePayload(message, failed > 0),
        failed,
        failed ? `${failed} of ${total} deliveries failed.` : null,
        message.operationId,
        message.eventId,
        claimToken,
        message.communicationId,
        communicationStatus,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (
      id, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
    ) SELECT ?, ?, ?, 'communication.delivery.finished', 'communication', ?, ?, unixepoch()
       WHERE EXISTS (
         SELECT 1 FROM operation_jobs completed_operation
         WHERE completed_operation.id = ? AND completed_operation.event_id = ?
            AND completed_operation.status = ?
            AND changes() = 1
       )`,
      ).bind(
        crypto.randomUUID(),
        message.organisationId,
        message.eventId,
        message.communicationId,
        JSON.stringify({
          operationId: message.operationId,
          total,
          succeeded,
          failed,
        }),
        message.operationId,
        message.eventId,
        operationStatus,
      ),
      env.DB.prepare(
        `INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
      SELECT ?, 'communication', ?, 'progress', correlation_id, unixepoch()
        FROM operation_jobs WHERE id = ? AND event_id = ? AND status = ? AND changes() = 1
      RETURNING sequence`,
      ).bind(
        message.eventId,
        message.communicationId,
        message.operationId,
        message.eventId,
        operationStatus,
      ),
    ]);
    const communicationCompleted =
      (completionResults[0].meta.changes ?? 0) === 1;
    const operationCompleted = (completionResults[1].meta.changes ?? 0) === 1;
    if (!communicationCompleted && !operationCompleted) {
      const current = await loadOperationClaim(
        env,
        message.operationId,
        message.eventId,
      );
      if (current?.status === "completed" || current?.status === "cancelled")
        return;
      throw new QueueClaimLeaseLostError();
    }
    if (!communicationCompleted || !operationCompleted) {
      throw new Error(
        "The communication completion could not be recorded consistently.",
      );
    }
    await notifyRealtimeAfterCommit(
      env,
      { organisationId: message.organisationId, eventId: message.eventId },
      returnedChangeSequence(completionResults.at(-1)),
      message.operationId,
    );
  } catch (error) {
    try {
      await finishOwnedCommunicationFailure(env, message, claimToken, error);
    } catch (failureError) {
      console.error(
        JSON.stringify({
          level: "error",
          subsystem: "communications-queue",
          operationId: message.operationId,
          message: `Could not persist the owned communication failure: ${failureError instanceof Error ? failureError.message : String(failureError)}`,
        }),
      );
    }
    throw error;
  }
}

const decisionNotificationMessageSchema = z.object({
  type: z.literal("decision.notification"),
  operationId: z.string().min(1),
  eventId: z.string().min(1),
  organisationId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  payload: z.object({ decisionId: z.string().min(1) }),
});

const submissionNotificationMessageSchema = z.object({
  type: z.literal("submission.notification"),
  operationId: z.string().min(1),
  communicationId: z.string().min(1),
  submissionId: z.string().min(1),
  eventId: z.string().min(1),
  organisationId: z.string().min(1),
  idempotencyKey: z.string().min(8),
});

/** Materialises the evaluation trigger into the same durable per-recipient email path. */
export async function processDecisionNotification(
  input: unknown,
  env: CloudflareEnvironment,
  dependencies: QueueProviderDependencies = {},
) {
  const message = decisionNotificationMessageSchema.parse(input);
  const operation = await env.DB.prepare(
    `
    SELECT o.id, o.status, o.requested_by_person_id AS requestedByPersonId
      FROM operation_jobs o
      JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
     WHERE o.id = ? AND o.event_id = ? AND o.type = 'decision.notification'
  `,
  )
    .bind(message.organisationId, message.operationId, message.eventId)
    .first<{
      id: string;
      status: string;
      requestedByPersonId: string | null;
    }>();
  if (!operation)
    throw new Error(
      "Decision notification operation does not exist in the authorised event.",
    );
  if (operation.status === "completed" || operation.status === "cancelled")
    return;

  const decision = await env.DB.prepare(
    `
    SELECT sd.id AS decisionId, sd.decision, s.id AS submissionId, s.title AS submissionTitle,
           s.submitter_person_id AS personId, COALESCE(p.email, s.submitter_email) AS address,
           COALESCE(p.display_name, s.submitter_email) AS recipientName,
           e.name AS eventName, e.starts_at AS startsAt, e.ends_at AS endsAt
      FROM submission_decisions sd
      JOIN submissions s ON s.id = sd.submission_id AND s.event_id = sd.event_id
      JOIN events e ON e.id = sd.event_id AND e.organisation_id = ?
      LEFT JOIN people p ON p.id = s.submitter_person_id
     WHERE sd.id = ? AND sd.event_id = ? AND sd.status = 'published'
  `,
  )
    .bind(message.organisationId, message.payload.decisionId, message.eventId)
    .first<{
      decisionId: string;
      decision: string;
      submissionId: string;
      submissionTitle: string;
      personId: string | null;
      address: string | null;
      recipientName: string | null;
      eventName: string;
      startsAt: number;
      endsAt: number;
    }>();
  if (!decision) {
    await markTriggerFailure(
      env,
      message,
      "The published decision no longer exists in the authorised event.",
    );
    return;
  }
  const [template, sender] = await Promise.all([
    env.DB.prepare(
      `
      SELECT tv.id, tv.subject_template AS subjectTemplate, tv.content_json AS contentJson
        FROM communication_template_versions tv
        JOIN communication_templates t ON t.id = tv.template_id AND t.event_id = tv.event_id
       WHERE tv.event_id = ? AND tv.status = 'published' AND tv.channel = 'email'
         AND tv.category = 'decision' AND t.status = 'active'
       ORDER BY tv.published_at DESC LIMIT 1
    `,
    )
      .bind(message.eventId)
      .first<{
        id: string;
        subjectTemplate: string | null;
        contentJson: string;
      }>(),
    env.DB.prepare(
      `
      SELECT id, from_name AS fromName, from_email AS fromEmail
        FROM sender_profiles WHERE event_id = ? AND provider = 'resend' AND status = 'verified'
       ORDER BY updated_at DESC LIMIT 1
    `,
    )
      .bind(message.eventId)
      .first<{ id: string; fromName: string; fromEmail: string }>(),
  ]);

  let configurationError: string | null = null;
  let content: z.infer<typeof templateContentSchema> | null = null;
  if (!decision.address || !z.email().safeParse(decision.address).success)
    configurationError =
      "The decision recipient does not have a valid verified email address.";
  else if (!template)
    configurationError =
      "Publish an active decision email template before releasing decisions.";
  else if (
    template.subjectTemplate === null ||
    template.subjectTemplate !== template.subjectTemplate.trim() ||
    template.subjectTemplate.length < 1 ||
    template.subjectTemplate.length > 200
  )
    configurationError =
      "The published decision email template has an invalid subject.";
  else {
    try {
      content = templateContentSchema.parse(JSON.parse(template.contentJson));
    } catch {
      configurationError =
        "The published decision email template contains invalid content.";
    }
  }
  if (!configurationError && !sender)
    configurationError =
      "A verified Resend sender profile is required for decision notifications.";
  if (!configurationError && !env.RESEND_API_KEY?.trim())
    configurationError =
      "RESEND_API_KEY is required for decision notifications.";

  const existing = await env.DB.prepare(
    "SELECT id FROM communications WHERE event_id = ? AND idempotency_key = ?",
  )
    .bind(message.eventId, message.idempotencyKey)
    .first<{ id: string }>();
  // A stable first-write ID lets concurrent deliveries of the same trigger
  // converge on one row before the provider-send claim is acquired.
  const communicationId =
    existing?.id ?? `decision-communication:${message.operationId}`;
  const deliveryId = `decision-delivery:${message.operationId}`;
  const deliveryKey = `${message.idempotencyKey}:${decision.address ?? "unavailable"}`;
  const contentSnapshot =
    content && template
      ? {
          schemaVersion: 1,
          category: "decision",
          subjectTemplate: template.subjectTemplate,
          content,
          event: {
            eventName: decision.eventName,
            startsAt: decision.startsAt,
            endsAt: decision.endsAt,
          },
        }
      : {
          schemaVersion: 1,
          category: "decision",
          configurationError,
          decisionId: decision.decisionId,
        };
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `
      INSERT INTO communications (
        id, event_id, template_version_id, sender_profile_id, operation_id, idempotency_key,
        kind, channel, status, audience_json, content_snapshot_json, recipient_count,
        queued_at, created_by_person_id, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, 'transactional', 'email', ?, ?, ?, ?, unixepoch(), ?, unixepoch(), unixepoch()
          FROM operation_jobs trigger_operation
         WHERE trigger_operation.id = ? AND trigger_operation.event_id = ?
           AND trigger_operation.organisation_id = ?
           AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
           AND trigger_operation.claim_token IS NULL
      ON CONFLICT(event_id, idempotency_key) DO UPDATE SET
        template_version_id = excluded.template_version_id, sender_profile_id = excluded.sender_profile_id,
        operation_id = excluded.operation_id, status = excluded.status,
        audience_json = excluded.audience_json, content_snapshot_json = excluded.content_snapshot_json,
        recipient_count = excluded.recipient_count, updated_at = unixepoch()
      WHERE communications.status IN ('queued','failed')
        AND EXISTS (
          SELECT 1 FROM operation_jobs trigger_operation
           WHERE trigger_operation.id = excluded.operation_id
             AND trigger_operation.event_id = excluded.event_id
             AND trigger_operation.organisation_id = ?
             AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
             AND trigger_operation.claim_token IS NULL
        )
    `,
    ).bind(
      communicationId,
      message.eventId,
      template?.id ?? null,
      sender?.id ?? null,
      message.operationId,
      message.idempotencyKey,
      configurationError ? "failed" : "queued",
      JSON.stringify({
        type: "decision",
        decisionId: decision.decisionId,
        submissionId: decision.submissionId,
      }),
      JSON.stringify(contentSnapshot),
      decision.address ? 1 : 0,
      operation.requestedByPersonId,
      message.operationId,
      message.eventId,
      message.organisationId,
      message.organisationId,
    ),
  ];
  if (decision.address) {
    statements.push(
      env.DB.prepare(
        `
        INSERT INTO communication_deliveries (
          id, event_id, communication_id, person_id, recipient_address, recipient_name,
          source_id, source_values_json, channel, provider, idempotency_key, status,
          failure_code, failure_message, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'email', 'resend', ?, ?, ?, ?, unixepoch(), unixepoch()
            FROM operation_jobs trigger_operation
           WHERE trigger_operation.id = ? AND trigger_operation.event_id = ?
             AND trigger_operation.organisation_id = ?
             AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
             AND trigger_operation.claim_token IS NULL
             AND EXISTS (
               SELECT 1 FROM communications materialised_communication
                WHERE materialised_communication.id = ? AND materialised_communication.event_id = ?
                  AND materialised_communication.operation_id = ?
             )
        ON CONFLICT(communication_id, idempotency_key) DO UPDATE SET
          recipient_address = excluded.recipient_address, recipient_name = excluded.recipient_name,
          source_id = excluded.source_id, source_values_json = excluded.source_values_json,
          status = excluded.status, failure_code = excluded.failure_code,
          failure_message = excluded.failure_message, updated_at = unixepoch()
        WHERE communication_deliveries.status IN ('queued','failed')
          AND EXISTS (
            SELECT 1 FROM operation_jobs trigger_operation
             WHERE trigger_operation.id = ? AND trigger_operation.event_id = ?
               AND trigger_operation.organisation_id = ?
               AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
               AND trigger_operation.claim_token IS NULL
          )
      `,
      ).bind(
        deliveryId,
        message.eventId,
        communicationId,
        decision.personId,
        decision.address,
        decision.recipientName ?? decision.address,
        decision.submissionId,
        JSON.stringify({
          "submission.title": decision.submissionTitle,
          "decision.outcome": decision.decision,
        }),
        deliveryKey,
        configurationError ? "failed" : "queued",
        configurationError ? "CONFIGURATION_ERROR" : null,
        configurationError,
        message.operationId,
        message.eventId,
        message.organisationId,
        communicationId,
        message.eventId,
        message.operationId,
        message.operationId,
        message.eventId,
        message.organisationId,
      ),
      env.DB.prepare(
        `
        INSERT INTO operation_items (
          id, operation_id, item_key, entity_type, entity_id, status, result_json,
          error_code, error_message, completed_at, updated_at
        ) SELECT ?, ?, ?, 'communication_delivery', d.id, ?, ?, ?, ?,
                 CASE WHEN ? IS NOT NULL THEN unixepoch() END, unixepoch()
            FROM communication_deliveries d
           WHERE d.communication_id = ? AND d.idempotency_key = ?
             AND EXISTS (
               SELECT 1 FROM operation_jobs trigger_operation
                WHERE trigger_operation.id = ? AND trigger_operation.event_id = ?
                  AND trigger_operation.organisation_id = ?
                  AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
                  AND trigger_operation.claim_token IS NULL
             )
        ON CONFLICT(operation_id, item_key) DO UPDATE SET
          entity_id = excluded.entity_id, status = excluded.status, result_json = excluded.result_json,
          error_code = excluded.error_code, error_message = excluded.error_message,
          completed_at = excluded.completed_at, updated_at = unixepoch()
        WHERE operation_items.status IN ('pending','failed')
          AND EXISTS (
            SELECT 1 FROM operation_jobs trigger_operation
             WHERE trigger_operation.id = operation_items.operation_id
               AND trigger_operation.event_id = ? AND trigger_operation.organisation_id = ?
               AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
               AND trigger_operation.claim_token IS NULL
          )
      `,
      ).bind(
        crypto.randomUUID(),
        message.operationId,
        deliveryKey,
        configurationError ? "failed" : "pending",
        JSON.stringify({ sourceId: decision.submissionId }),
        configurationError ? "CONFIGURATION_ERROR" : null,
        configurationError,
        configurationError,
        communicationId,
        deliveryKey,
        message.operationId,
        message.eventId,
        message.organisationId,
        message.eventId,
        message.organisationId,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `
    INSERT INTO audit_events (
      id, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
    ) SELECT ?, ?, ?, ?, 'communication', ?, ?, unixepoch()
        FROM operation_jobs trigger_operation
       WHERE trigger_operation.id = ? AND trigger_operation.event_id = ?
         AND trigger_operation.organisation_id = ?
         AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
         AND trigger_operation.claim_token IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM audit_events existing_audit
            WHERE existing_audit.event_id = ? AND existing_audit.action = ?
              AND existing_audit.entity_type = 'communication' AND existing_audit.entity_id = ?
         )
  `,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      configurationError
        ? "decision.notification.failed"
        : "decision.notification.prepared",
      communicationId,
      JSON.stringify({
        decisionId: decision.decisionId,
        operationId: message.operationId,
        configurationError,
      }),
      message.operationId,
      message.eventId,
      message.organisationId,
      message.eventId,
      configurationError
        ? "decision.notification.failed"
        : "decision.notification.prepared",
      communicationId,
    ),
  );
  await env.DB.batch(statements);
  if (configurationError) {
    await markTriggerFailure(env, message, configurationError);
    return;
  }
  await processCommunicationSend(
    {
      type: "communication.send",
      operationId: message.operationId,
      communicationId,
      eventId: message.eventId,
      organisationId: message.organisationId,
      idempotencyKey: message.idempotencyKey,
    },
    env,
    dependencies,
  );
}

/** Materialises the durable public-submission confirmation intent. */
export async function processSubmissionNotification(
  input: unknown,
  env: CloudflareEnvironment,
  dependencies: QueueProviderDependencies = {},
) {
  const message = submissionNotificationMessageSchema.parse(input);
  const operation = await env.DB.prepare(
    `
    SELECT o.id, o.status, o.requested_by_person_id AS requestedByPersonId
      FROM operation_jobs o
      JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
     WHERE o.id = ? AND o.event_id = ? AND o.type = 'submission.notification'
  `,
  )
    .bind(message.organisationId, message.operationId, message.eventId)
    .first<{
      id: string;
      status: string;
      requestedByPersonId: string | null;
    }>();
  if (!operation)
    throw new Error(
      "Submission confirmation operation does not exist in the authorised event.",
    );
  if (operation.status === "completed" || operation.status === "cancelled")
    return;

  const durableIntent = await env.DB.prepare(
    `
    SELECT id FROM communications
     WHERE id = ? AND event_id = ? AND operation_id = ? AND idempotency_key = ?
  `,
  )
    .bind(
      message.communicationId,
      message.eventId,
      message.operationId,
      message.idempotencyKey,
    )
    .first<{ id: string }>();
  if (!durableIntent)
    throw new Error(
      "The durable submission confirmation intent is unavailable.",
    );

  const submission = await env.DB.prepare(
    `
    SELECT s.id AS submissionId, s.title AS submissionTitle,
           s.submitter_person_id AS personId, COALESCE(p.email, s.submitter_email) AS address,
           COALESCE(p.display_name, s.submitter_email) AS recipientName,
           e.name AS eventName, e.starts_at AS startsAt, e.ends_at AS endsAt
      FROM submissions s
      JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
      LEFT JOIN people p ON p.id = s.submitter_person_id
     WHERE s.id = ? AND s.event_id = ? AND s.status <> 'draft'
  `,
  )
    .bind(message.organisationId, message.submissionId, message.eventId)
    .first<{
      submissionId: string;
      submissionTitle: string;
      personId: string | null;
      address: string | null;
      recipientName: string | null;
      eventName: string;
      startsAt: number;
      endsAt: number;
    }>();
  if (!submission) {
    await markTriggerFailure(
      env,
      message,
      "The submitted application no longer exists in the authorised event.",
      message.communicationId,
    );
    return;
  }

  const [template, sender] = await Promise.all([
    env.DB.prepare(
      `
      SELECT tv.id, tv.subject_template AS subjectTemplate, tv.content_json AS contentJson
        FROM communication_template_versions tv
        JOIN communication_templates t ON t.id = tv.template_id AND t.event_id = tv.event_id
       WHERE tv.event_id = ? AND tv.status = 'published' AND tv.channel = 'email'
         AND tv.category = 'submission_confirmation' AND t.status = 'active'
       ORDER BY tv.published_at DESC LIMIT 1
    `,
    )
      .bind(message.eventId)
      .first<{
        id: string;
        subjectTemplate: string | null;
        contentJson: string;
      }>(),
    env.DB.prepare(
      `
      SELECT id FROM sender_profiles
       WHERE event_id = ? AND provider = 'resend' AND status = 'verified'
       ORDER BY updated_at DESC LIMIT 1
    `,
    )
      .bind(message.eventId)
      .first<{ id: string }>(),
  ]);

  let configurationError: string | null = null;
  let content: z.infer<typeof templateContentSchema> | null = null;
  if (!submission.address || !z.email().safeParse(submission.address).success) {
    configurationError =
      "The submission recipient does not have a valid verified email address.";
  } else if (!template) {
    configurationError =
      "Publish an active submission confirmation email template before accepting applications.";
  } else if (
    template.subjectTemplate === null ||
    template.subjectTemplate !== template.subjectTemplate.trim() ||
    template.subjectTemplate.length < 1 ||
    template.subjectTemplate.length > 200
  ) {
    configurationError =
      "The published submission confirmation email template has an invalid subject.";
  } else {
    try {
      content = templateContentSchema.parse(JSON.parse(template.contentJson));
    } catch {
      configurationError =
        "The published submission confirmation template contains invalid content.";
    }
  }
  if (!configurationError && !sender)
    configurationError =
      "A verified Resend sender profile is required for submission confirmations.";
  if (!configurationError && !env.RESEND_API_KEY?.trim())
    configurationError =
      "RESEND_API_KEY is required for submission confirmations.";

  const deliveryKey = `${message.idempotencyKey}:${submission.address ?? "unavailable"}`;
  const contentSnapshot =
    content && template
      ? {
          schemaVersion: 1,
          category: "submission_confirmation",
          subjectTemplate: template.subjectTemplate,
          content,
          event: {
            eventName: submission.eventName,
            startsAt: submission.startsAt,
            endsAt: submission.endsAt,
          },
        }
      : {
          schemaVersion: 1,
          category: "submission_confirmation",
          configurationError,
          submissionId: submission.submissionId,
        };
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE communications
      SET template_version_id = ?, sender_profile_id = ?, status = ?, audience_json = ?,
          content_snapshot_json = ?, recipient_count = ?, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND operation_id = ?
        AND status IN ('queued','failed')
        AND EXISTS (
          SELECT 1 FROM operation_jobs trigger_operation
           WHERE trigger_operation.id = communications.operation_id
             AND trigger_operation.event_id = communications.event_id
             AND trigger_operation.organisation_id = ?
             AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
             AND trigger_operation.claim_token IS NULL
        )`,
    ).bind(
      template?.id ?? null,
      sender?.id ?? null,
      configurationError ? "failed" : "queued",
      JSON.stringify({
        type: "submission_confirmation",
        submissionId: submission.submissionId,
      }),
      JSON.stringify(contentSnapshot),
      submission.address ? 1 : 0,
      message.communicationId,
      message.eventId,
      message.operationId,
      message.organisationId,
    ),
  ];
  if (submission.address) {
    statements.push(
      env.DB.prepare(
        `
        INSERT INTO communication_deliveries (
          id, event_id, communication_id, person_id, recipient_address, recipient_name,
          source_id, source_values_json, channel, provider, idempotency_key, status,
          failure_code, failure_message, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'email', 'resend', ?, ?, ?, ?, unixepoch(), unixepoch()
            FROM operation_jobs trigger_operation
           WHERE trigger_operation.id = ? AND trigger_operation.event_id = ?
             AND trigger_operation.organisation_id = ?
             AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
             AND trigger_operation.claim_token IS NULL
        ON CONFLICT(communication_id, idempotency_key) DO UPDATE SET
          recipient_address = excluded.recipient_address, recipient_name = excluded.recipient_name,
          source_id = excluded.source_id, source_values_json = excluded.source_values_json,
          status = excluded.status, failure_code = excluded.failure_code,
          failure_message = excluded.failure_message, updated_at = unixepoch()
        WHERE communication_deliveries.status IN ('queued','failed')
          AND EXISTS (
            SELECT 1 FROM operation_jobs trigger_operation
             WHERE trigger_operation.id = ? AND trigger_operation.event_id = ?
               AND trigger_operation.organisation_id = ?
               AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
               AND trigger_operation.claim_token IS NULL
          )
      `,
      ).bind(
        crypto.randomUUID(),
        message.eventId,
        message.communicationId,
        submission.personId,
        submission.address,
        submission.recipientName ?? submission.address,
        submission.submissionId,
        JSON.stringify({ "submission.title": submission.submissionTitle }),
        deliveryKey,
        configurationError ? "failed" : "queued",
        configurationError ? "CONFIGURATION_ERROR" : null,
        configurationError,
        message.operationId,
        message.eventId,
        message.organisationId,
        message.operationId,
        message.eventId,
        message.organisationId,
      ),
      env.DB.prepare(
        `
        INSERT INTO operation_items (
          id, operation_id, item_key, entity_type, entity_id, status, result_json,
          error_code, error_message, completed_at, updated_at
        ) SELECT ?, ?, ?, 'communication_delivery', d.id, ?, ?, ?, ?,
                 CASE WHEN ? IS NOT NULL THEN unixepoch() END, unixepoch()
            FROM communication_deliveries d
           WHERE d.communication_id = ? AND d.idempotency_key = ?
             AND EXISTS (
               SELECT 1 FROM operation_jobs trigger_operation
                WHERE trigger_operation.id = ? AND trigger_operation.event_id = ?
                  AND trigger_operation.organisation_id = ?
                  AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
                  AND trigger_operation.claim_token IS NULL
             )
        ON CONFLICT(operation_id, item_key) DO UPDATE SET
          entity_id = excluded.entity_id, status = excluded.status, result_json = excluded.result_json,
          error_code = excluded.error_code, error_message = excluded.error_message,
          completed_at = excluded.completed_at, updated_at = unixepoch()
        WHERE operation_items.status IN ('pending','failed')
          AND EXISTS (
            SELECT 1 FROM operation_jobs trigger_operation
             WHERE trigger_operation.id = operation_items.operation_id
               AND trigger_operation.event_id = ? AND trigger_operation.organisation_id = ?
               AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
               AND trigger_operation.claim_token IS NULL
          )
      `,
      ).bind(
        crypto.randomUUID(),
        message.operationId,
        deliveryKey,
        configurationError ? "failed" : "pending",
        JSON.stringify({ sourceId: submission.submissionId }),
        configurationError ? "CONFIGURATION_ERROR" : null,
        configurationError,
        configurationError,
        message.communicationId,
        deliveryKey,
        message.operationId,
        message.eventId,
        message.organisationId,
        message.eventId,
        message.organisationId,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `
    INSERT INTO audit_events (
      id, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
    ) SELECT ?, ?, ?, ?, 'communication', ?, ?, unixepoch()
        FROM operation_jobs trigger_operation
       WHERE trigger_operation.id = ? AND trigger_operation.event_id = ?
         AND trigger_operation.organisation_id = ?
         AND trigger_operation.status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
         AND trigger_operation.claim_token IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM audit_events existing_audit
            WHERE existing_audit.event_id = ? AND existing_audit.action = ?
              AND existing_audit.entity_type = 'communication' AND existing_audit.entity_id = ?
         )
  `,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      configurationError
        ? "submission.notification.failed"
        : "submission.notification.prepared",
      message.communicationId,
      JSON.stringify({
        submissionId: submission.submissionId,
        operationId: message.operationId,
        configurationError,
      }),
      message.operationId,
      message.eventId,
      message.organisationId,
      message.eventId,
      configurationError
        ? "submission.notification.failed"
        : "submission.notification.prepared",
      message.communicationId,
    ),
  );
  await env.DB.batch(statements);
  if (configurationError) {
    await markTriggerFailure(
      env,
      message,
      configurationError,
      message.communicationId,
    );
    return;
  }
  await processCommunicationSend(
    {
      type: "communication.send",
      operationId: message.operationId,
      communicationId: message.communicationId,
      eventId: message.eventId,
      organisationId: message.organisationId,
      idempotencyKey: message.idempotencyKey,
    },
    env,
    dependencies,
  );
}

async function markTriggerFailure(
  env: CloudflareEnvironment,
  message: { operationId: string; eventId: string; organisationId: string },
  reason: string,
  entityId: string | null = null,
) {
  const failure = reason.slice(0, 2_000);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `
      UPDATE operation_jobs SET status = 'failed', progress_total = 1, progress_completed = 1,
        progress_failed = 1, last_error = ?, completed_at = unixepoch(),
        claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND (
           (
             status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
             AND claim_token IS NULL
           )
           OR (
             status IN ('running','received')
             AND COALESCE(claim_expires_at, 0) <= unixepoch()
           )
         )
    `,
    ).bind(
      failure,
      message.operationId,
      message.eventId,
      message.organisationId,
    ),
  ];
  if (entityId) {
    statements.push(
      env.DB.prepare(
        `UPDATE communications
      SET status = 'failed', updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND operation_id = ? AND status IN ('queued','failed')
        AND changes() = 1
        AND EXISTS (
          SELECT 1 FROM operation_jobs failed_operation
           WHERE failed_operation.id = communications.operation_id
             AND failed_operation.event_id = communications.event_id
             AND failed_operation.organisation_id = ?
             AND failed_operation.status = 'failed' AND failed_operation.last_error = ?
             AND failed_operation.claim_token IS NULL
        )`,
      ).bind(
        entityId,
        message.eventId,
        message.operationId,
        message.organisationId,
        failure,
      ),
    );
  }
  const results = await env.DB.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "cancelled")
      return;
    if (
      (current?.status === "running" || current?.status === "received") &&
      current.claimToken &&
      (current.claimExpiresAt ?? 0) > Math.floor(Date.now() / 1_000)
    ) {
      throw new QueueClaimLeaseBusyError();
    }
    throw new Error(
      "The notification trigger failure could not claim the operation.",
    );
  }
  const change = await env.DB.prepare(
    `INSERT INTO event_changes (
    event_id, entity_type, entity_id, change_type, correlation_id, created_at
  ) SELECT event_id, 'communication', ?, 'progress', correlation_id, unixepoch()
      FROM operation_jobs WHERE id = ? AND event_id = ?
    RETURNING sequence`,
  )
    .bind(entityId, message.operationId, message.eventId)
    .run();
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(change),
    message.operationId,
  );
}

type CalendarAttemptRow = {
  id: string;
  sequenceNumber: number;
  method: "REQUEST" | "CANCEL";
  status: "queued" | "running" | "succeeded" | "failed" | "superseded" | null;
  attemptSequence: number | null;
  attemptMethod: "REQUEST" | "CANCEL" | null;
  attemptProvider: "email_ics" | "google" | "microsoft" | null;
  currentAttemptId: string | null;
  lastPayloadHash: string | null;
  providerEventId: string | null;
  deliveryId: string | null;
  communicationId: string | null;
  connectionId: string | null;
  encryptedCredentials: string | null;
  connectionProvider: "google" | "microsoft" | null;
  connectionStatus: string | null;
  connectionExpiresAt: number | null;
};

async function loadCalendarAttempt(
  env: CloudflareEnvironment,
  message: CalendarQueueMessage,
) {
  return env.DB.prepare(
    `
    SELECT ci.id, ci.sequence_number AS sequenceNumber, ci.method,
           ci.current_attempt_id AS currentAttemptId, ci.last_payload_hash AS lastPayloadHash,
           ci.provider_event_id AS providerEventId, ci.delivery_id AS deliveryId,
           d.communication_id AS communicationId, ci.connection_id AS connectionId,
           cc.encrypted_credentials AS encryptedCredentials, cc.provider AS connectionProvider,
           cc.status AS connectionStatus, cc.expires_at AS connectionExpiresAt,
           csa.status, csa.sequence_number AS attemptSequence,
           csa.method AS attemptMethod, csa.provider AS attemptProvider
      FROM calendar_invitations ci
      LEFT JOIN calendar_sync_attempts csa
        ON csa.id = ? AND csa.invitation_id = ci.id
      LEFT JOIN communication_deliveries d
        ON d.id = ci.delivery_id AND d.event_id = ci.event_id
      LEFT JOIN calendar_connections cc ON cc.id = ci.connection_id
     WHERE ci.id = ? AND ci.event_id = ?
  `,
  )
    .bind(message.attemptId, message.invitationId, message.eventId)
    .first<CalendarAttemptRow>();
}

function isExactCalendarAttempt(
  row: CalendarAttemptRow | null,
  message: CalendarQueueMessage,
  payloadHash: string,
) {
  return (
    row?.currentAttemptId === message.attemptId &&
    row.sequenceNumber === message.payload.sequence &&
    row.method === message.payload.method &&
    row.lastPayloadHash === payloadHash &&
    row.attemptSequence === message.payload.sequence &&
    row.attemptMethod === message.payload.method &&
    row.attemptProvider === message.provider
  );
}

async function finishSupersededCalendarAttempt(
  env: CloudflareEnvironment,
  message: CalendarQueueMessage,
  reason: string,
  providerEventId: string | null = null,
  claimToken?: string,
) {
  const claimGuard = claimToken
    ? `AND EXISTS (
    SELECT 1 FROM operation_jobs claimed_operation
     WHERE claimed_operation.id = ? AND claimed_operation.event_id = ?
       AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
  )`
    : "";
  const claimBindings = claimToken
    ? [message.operationId, message.eventId, claimToken]
    : [];
  const resultJson = JSON.stringify({
    invitationId: message.invitationId,
    attemptId: message.attemptId,
    sequence: message.payload.sequence,
    provider: message.provider,
    outcome: "superseded",
    providerApplied: providerEventId !== null,
    ...(providerEventId ? { providerEventId } : {}),
    reason,
  });
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE calendar_sync_attempts
      SET status = 'superseded', provider_event_id = COALESCE(?, provider_event_id),
          error_code = 'SUPERSEDED', error_message = ?, completed_at = unixepoch()
      WHERE id = ? AND invitation_id = ? AND sequence_number = ? AND method = ? AND provider = ?
        AND status IN ('queued','running','failed') ${claimGuard}`,
    ).bind(
      providerEventId,
      reason.slice(0, 2_000),
      message.attemptId,
      message.invitationId,
      message.payload.sequence,
      message.payload.method,
      message.provider,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communication_deliveries
      SET status = 'cancelled', failure_code = 'SUPERSEDED', failure_message = ?, updated_at = unixepoch()
      WHERE communication_id IN (SELECT id FROM communications WHERE operation_id = ? AND event_id = ?)
        AND status IN ('queued','sending','failed') ${claimGuard}`,
    ).bind(
      reason.slice(0, 2_000),
      message.operationId,
      message.eventId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communications
      SET status = 'cancelled', cancelled_at = unixepoch(), updated_at = unixepoch()
      WHERE operation_id = ? AND event_id = ? AND status IN ('queued','sending','failed','partially_failed')
        ${claimGuard}`,
    ).bind(message.operationId, message.eventId, ...claimBindings),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'skipped', result_json = ?, error_code = 'SUPERSEDED', error_message = ?,
          completed_at = unixepoch(), updated_at = unixepoch()
      WHERE operation_id = ? AND status IN ('pending','running','failed') ${claimGuard}`,
    ).bind(
      resultJson,
      reason.slice(0, 2_000),
      message.operationId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'cancelled', progress_total = 1, progress_completed = 1, progress_failed = 0,
          result_json = ?, last_error = NULL, completed_at = unixepoch(),
          claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND status NOT IN ('completed','cancelled')
        ${claimToken ? "AND status = 'running' AND claim_token = ?" : ""}`,
    ).bind(
      resultJson,
      message.operationId,
      message.eventId,
      ...(claimToken ? [claimToken] : []),
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
      id, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
    ) SELECT ?, ?, ?, 'calendar.lifecycle.superseded', 'calendar_invitation', ?, ?, unixepoch()
       WHERE changes() = 1
         AND EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'cancelled')`,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      message.invitationId,
      resultJson,
      message.operationId,
      message.eventId,
    ),
    env.DB.prepare(
      `INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
      SELECT event_id, 'calendar_invitation', ?, 'progress', correlation_id, unixepoch()
        FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'cancelled' AND changes() = 1
      RETURNING sequence`,
    ).bind(message.invitationId, message.operationId, message.eventId),
  ]);
  const operationFinished = (results[4]?.meta.changes ?? 0) === 1;
  if (!operationFinished) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "cancelled")
      return;
    if (current?.status === "running") {
      if (claimToken && current.claimToken !== claimToken)
        throw new QueueClaimLeaseLostError();
      throw new QueueClaimLeaseBusyError();
    }
  }
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(results.at(-1)),
    message.operationId,
  );
}

async function finishCalendarAttemptFailure(
  env: CloudflareEnvironment,
  message: CalendarQueueMessage,
  payloadHash: string,
  failure: { code: string; message: string },
  claimToken?: string,
) {
  const claimGuard = claimToken
    ? `AND EXISTS (
    SELECT 1 FROM operation_jobs claimed_operation
     WHERE claimed_operation.id = ? AND claimed_operation.event_id = ?
       AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
  )`
    : "";
  const claimBindings = claimToken
    ? [message.operationId, message.eventId, claimToken]
    : [];
  const failureResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE calendar_sync_attempts
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = unixepoch()
      WHERE id = ? AND invitation_id = ? AND sequence_number = ? AND method = ? AND provider = ?
        AND status IN ('queued','running','failed') ${claimGuard}`,
    ).bind(
      failure.code,
      failure.message,
      message.attemptId,
      message.invitationId,
      message.payload.sequence,
      message.payload.method,
      message.provider,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE calendar_invitations SET status = 'failed', updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND current_attempt_id = ? AND sequence_number = ?
        AND method = ? AND last_payload_hash = ? ${claimGuard}`,
    ).bind(
      message.invitationId,
      message.eventId,
      message.attemptId,
      message.payload.sequence,
      message.payload.method,
      payloadHash,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = unixepoch(), updated_at = unixepoch()
      WHERE operation_id = ? AND status <> 'completed' ${claimGuard}`,
    ).bind(
      failure.code,
      failure.message,
      message.operationId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communication_deliveries
      SET status = 'failed', failure_code = ?, failure_message = ?, next_attempt_at = unixepoch() + 60,
          updated_at = unixepoch()
      WHERE communication_id IN (SELECT id FROM communications WHERE operation_id = ? AND event_id = ?)
        AND status IN ('queued','sending','failed') ${claimGuard}`,
    ).bind(
      failure.code,
      failure.message,
      message.operationId,
      message.eventId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communications SET status = 'failed', updated_at = unixepoch()
      WHERE operation_id = ? AND event_id = ? AND status NOT IN ('sent','cancelled') ${claimGuard}`,
    ).bind(message.operationId, message.eventId, ...claimBindings),
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'failed', progress_total = 1, progress_completed = 1, progress_failed = 1,
          last_error = ?, completed_at = unixepoch(), claim_token = NULL,
          claim_expires_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND status NOT IN ('completed','cancelled')
        ${claimToken ? "AND status = 'running' AND claim_token = ?" : ""}`,
    ).bind(
      failure.message,
      message.operationId,
      message.eventId,
      ...(claimToken ? [claimToken] : []),
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
      id, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
    ) SELECT ?, ?, ?, 'calendar.lifecycle.failed', 'calendar_invitation', ?, ?, unixepoch()
       WHERE changes() = 1`,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      message.invitationId,
      JSON.stringify({
        attemptId: message.attemptId,
        provider: message.provider,
        method: message.payload.method,
        sequence: message.payload.sequence,
        errorCode: failure.code,
        errorMessage: failure.message,
      }),
    ),
    env.DB.prepare(
      `INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
      SELECT event_id, 'calendar_invitation', ?, 'progress', correlation_id, unixepoch()
        FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'failed' AND changes() = 1
      RETURNING sequence`,
    ).bind(message.invitationId, message.operationId, message.eventId),
  ]);
  const operationFinished = (failureResults[5]?.meta.changes ?? 0) === 1;
  if (!operationFinished) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "cancelled")
      return;
    if (current?.status === "running") {
      if (claimToken && current.claimToken !== claimToken)
        throw new QueueClaimLeaseLostError();
      throw new QueueClaimLeaseBusyError();
    }
  }
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(failureResults.at(-1)),
    message.operationId,
  );
}

export async function processCalendarSync(
  input: unknown,
  env: CloudflareEnvironment,
  dependencies: QueueProviderDependencies = {},
) {
  const message = calendarQueueMessageSchema.parse(input);
  const operation = await env.DB.prepare(
    `
    SELECT o.id, o.status, o.payload_json AS payloadJson
      FROM operation_jobs o
      JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
     WHERE o.id = ? AND o.event_id = ? AND o.type = 'calendar.sync'
  `,
  )
    .bind(message.organisationId, message.operationId, message.eventId)
    .first<{
      id: string;
      status: string;
      payloadJson: string;
    }>();
  if (!operation)
    throw new Error(
      "Calendar operation does not exist in the authorised event.",
    );
  if (operation.status === "completed") return;

  const savedMessage = calendarQueueMessageSchema.safeParse(
    JSON.parse(operation.payloadJson),
  );
  if (!savedMessage.success) {
    const payloadHash = await hashCalendarLifecyclePayload(
      message.provider,
      message.payload,
    );
    await finishCalendarAttemptFailure(env, message, payloadHash, {
      code: "INVALID_SAVED_PAYLOAD",
      message: "The saved calendar operation payload is invalid.",
    });
    return;
  }
  const canonicalMessage = savedMessage.data;
  if (operation.status === "cancelled") {
    await finishSupersededCalendarAttempt(
      env,
      canonicalMessage,
      "The calendar operation was cancelled before delivery.",
    );
    return;
  }
  if (JSON.stringify(canonicalMessage) !== JSON.stringify(message)) {
    const payloadHash = await hashCalendarLifecyclePayload(
      canonicalMessage.provider,
      canonicalMessage.payload,
    );
    await finishCalendarAttemptFailure(env, canonicalMessage, payloadHash, {
      code: "QUEUE_PAYLOAD_MISMATCH",
      message:
        "The calendar Queue message did not match its durable operation payload.",
    });
    return;
  }
  const payloadHash = await hashCalendarLifecyclePayload(
    message.provider,
    message.payload,
  );
  let invitation = await loadCalendarAttempt(env, message);
  if (!invitation || invitation.currentAttemptId !== message.attemptId) {
    await finishSupersededCalendarAttempt(
      env,
      message,
      "A newer calendar lifecycle attempt replaced this queued work.",
    );
    return;
  }
  if (!isExactCalendarAttempt(invitation, message, payloadHash)) {
    await finishCalendarAttemptFailure(env, message, payloadHash, {
      code: "CALENDAR_ATTEMPT_MISMATCH",
      message:
        "The current calendar attempt does not match its durable sequence, method, provider and payload hash.",
    });
    return;
  }
  if (invitation.status === "succeeded") return;
  if (invitation.status === "superseded") {
    await finishSupersededCalendarAttempt(
      env,
      message,
      "The calendar lifecycle attempt was already superseded.",
    );
    return;
  }

  const claimToken = crypto.randomUUID();
  const startResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE calendar_sync_attempts
      SET status = 'running', started_at = unixepoch(), completed_at = NULL,
          error_code = NULL, error_message = NULL
      WHERE id = ? AND invitation_id = ? AND sequence_number = ? AND method = ? AND provider = ?
        AND status IN ('queued','failed','running')
        AND EXISTS (
          SELECT 1 FROM calendar_invitations ci
           WHERE ci.id = ? AND ci.event_id = ? AND ci.current_attempt_id = ?
             AND ci.sequence_number = ? AND ci.method = ? AND ci.last_payload_hash = ?
        )
        AND EXISTS (
           SELECT 1 FROM operation_jobs o
           WHERE o.id = ? AND o.event_id = ?
             AND (
               o.status IN ('queued','received','retrying','queue_failed','failed','partially_failed')
               OR (o.status = 'running' AND COALESCE(o.claim_expires_at, 0) <= unixepoch())
             )
        )`,
    ).bind(
      message.attemptId,
      message.invitationId,
      message.payload.sequence,
      message.payload.method,
      message.provider,
      message.invitationId,
      message.eventId,
      message.attemptId,
      message.payload.sequence,
      message.payload.method,
      payloadHash,
      message.operationId,
      message.eventId,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'running', started_at = COALESCE(started_at, unixepoch()),
          attempt_count = attempt_count + 1, last_error = NULL, completed_at = NULL,
          claim_token = ?, claim_expires_at = unixepoch() + ?, updated_at = unixepoch()
      WHERE id = ? AND event_id = ?
        AND (
          status IN ('queued','received','retrying','queue_failed','failed','partially_failed')
          OR (status = 'running' AND COALESCE(claim_expires_at, 0) <= unixepoch())
        )
        AND EXISTS (SELECT 1 FROM calendar_sync_attempts WHERE id = ? AND status = 'running')`,
    ).bind(
      claimToken,
      QUEUE_CLAIM_LEASE_SECONDS,
      message.operationId,
      message.eventId,
      message.attemptId,
    ),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'running', attempt_count = attempt_count + 1,
          started_at = COALESCE(started_at, unixepoch()), completed_at = NULL,
          error_code = NULL, error_message = NULL, updated_at = unixepoch()
      WHERE operation_id = ? AND entity_id = ? AND status IN ('pending','failed','running')
        AND EXISTS (
          SELECT 1 FROM calendar_sync_attempts
          JOIN operation_jobs claimed_operation ON claimed_operation.id = operation_items.operation_id
           WHERE calendar_sync_attempts.id = ? AND calendar_sync_attempts.status = 'running'
             AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
        )`,
    ).bind(
      message.operationId,
      message.invitationId,
      message.attemptId,
      claimToken,
    ),
  ]);
  if (
    (startResults[0]?.meta.changes ?? 0) !== 1 ||
    (startResults[1]?.meta.changes ?? 0) !== 1
  ) {
    invitation = await loadCalendarAttempt(env, message);
    const currentOperation = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (
      currentOperation?.status === "completed" ||
      currentOperation?.status === "cancelled"
    )
      return;
    if (
      isExactCalendarAttempt(invitation, message, payloadHash) &&
      invitation?.status === "running" &&
      currentOperation?.status === "running" &&
      currentOperation.claimToken &&
      (currentOperation.claimExpiresAt ?? 0) > Math.floor(Date.now() / 1_000)
    ) {
      throw new QueueClaimLeaseBusyError();
    }
    if (!isExactCalendarAttempt(invitation, message, payloadHash)) {
      await finishSupersededCalendarAttempt(
        env,
        message,
        "A newer calendar lifecycle attempt replaced this queued work before provider delivery.",
      );
      return;
    }
    await finishCalendarAttemptFailure(env, message, payloadHash, {
      code: "CALENDAR_ATTEMPT_CLAIM_FAILED",
      message:
        "The exact calendar attempt could not be claimed for provider delivery.",
    });
    return;
  }

  invitation = await loadCalendarAttempt(env, message);
  if (
    !isExactCalendarAttempt(invitation, message, payloadHash) ||
    invitation?.status !== "running"
  ) {
    await finishSupersededCalendarAttempt(
      env,
      message,
      "A newer calendar lifecycle attempt replaced this work before provider delivery.",
      null,
      claimToken,
    );
    return;
  }
  await assertOperationClaim(
    env,
    message.operationId,
    message.eventId,
    claimToken,
  );

  let providerEventId: string;
  try {
    if (message.provider === "email_ics") {
      if (!invitation.deliveryId)
        throw new Error("Calendar email delivery record is missing.");
      const delivery = await env.DB.prepare(
        `
        SELECT d.id, d.recipient_address AS address, d.idempotency_key AS idempotencyKey,
               d.status, d.provider_message_id AS providerMessageId,
               c.id AS communicationId, sp.from_name AS fromName, sp.from_email AS fromEmail,
               sp.reply_to_email AS replyToEmail
          FROM communication_deliveries d
          JOIN communications c ON c.id = d.communication_id AND c.event_id = d.event_id
          JOIN sender_profiles sp ON sp.id = c.sender_profile_id AND sp.event_id = c.event_id
         WHERE d.id = ? AND d.event_id = ? AND c.operation_id = ?
           AND c.status <> 'cancelled' AND sp.status = 'verified'
      `,
      )
        .bind(invitation.deliveryId, message.eventId, message.operationId)
        .first<{
          id: string;
          address: string;
          idempotencyKey: string;
          status: string;
          providerMessageId: string | null;
          communicationId: string;
          fromName: string;
          fromEmail: string;
          replyToEmail: string | null;
        }>();
      if (!delivery)
        throw new Error("Calendar email sender or delivery is unavailable.");
      if (delivery.status === "sent" && delivery.providerMessageId) {
        providerEventId = delivery.providerMessageId;
      } else {
        const methodLabel =
          message.payload.method === "CANCEL"
            ? "Cancelled"
            : "Calendar invitation";
        const subject = `${methodLabel}: ${message.payload.title}`;
        const rendered = await renderProgramCueEmail({
          preview: subject,
          heading: subject,
          body:
            message.payload.method === "CANCEL"
              ? "This session has been cancelled. The attached calendar update removes it from your calendar."
              : `Your session is scheduled at ${message.payload.location}. The invitation is attached for Gmail, Outlook and other iCalendar-compatible calendars.`,
          eventName: message.payload.organizerName,
          physicalAddress:
            "This operational calendar message was sent by the event organiser.",
        });
        await renewOperationClaim(
          env,
          { organisationId: message.organisationId, eventId: message.eventId },
          message.operationId,
          claimToken,
        );
        const deliveryClaim = await env.DB.prepare(
          `UPDATE communication_deliveries
          SET status = 'sending', attempt_count = attempt_count + 1,
              failure_code = NULL, failure_message = NULL, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND status IN ('queued','failed','sending')
            AND EXISTS (
              SELECT 1 FROM calendar_invitations ci
              JOIN calendar_sync_attempts csa ON csa.id = ? AND csa.invitation_id = ci.id
              JOIN operation_jobs claimed_operation ON claimed_operation.id = ? AND claimed_operation.event_id = ci.event_id
               WHERE ci.id = ? AND ci.event_id = ? AND ci.current_attempt_id = ?
                 AND ci.sequence_number = ? AND ci.method = ? AND ci.last_payload_hash = ?
                 AND csa.status = 'running' AND csa.sequence_number = ?
                 AND csa.method = ? AND csa.provider = ?
                 AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
            )`,
        )
          .bind(
            delivery.id,
            message.eventId,
            message.attemptId,
            message.operationId,
            message.invitationId,
            message.eventId,
            message.attemptId,
            message.payload.sequence,
            message.payload.method,
            payloadHash,
            message.payload.sequence,
            message.payload.method,
            message.provider,
            claimToken,
          )
          .run();
        if ((deliveryClaim.meta.changes ?? 0) !== 1)
          throw new Error("Calendar email delivery could not be claimed.");
        const result = await (
          dependencies.resend ?? new ResendEmailProvider(env.RESEND_API_KEY)
        ).send({
          from: `${delivery.fromName} <${delivery.fromEmail}>`,
          replyTo: delivery.replyToEmail,
          to: delivery.address,
          subject,
          html: rendered.html,
          text: rendered.text,
          idempotencyKey: delivery.idempotencyKey,
          attachments: [
            {
              filename: "program-cue-invitation.ics",
              content: generateInvitationIcs(message.payload),
              contentType: `text/calendar; charset=utf-8; method=${message.payload.method}`,
            },
          ],
        });
        providerEventId = result.messageId;
        const emailCompletionResults = await env.DB.batch([
          env.DB.prepare(
            `UPDATE communication_deliveries
            SET status = 'sent', provider = 'resend', provider_message_id = ?,
                failure_code = NULL, failure_message = NULL, updated_at = unixepoch()
            WHERE id = ? AND event_id = ?
              AND EXISTS (
                SELECT 1 FROM operation_jobs claimed_operation
                 WHERE claimed_operation.id = ? AND claimed_operation.event_id = ?
                   AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
              )`,
          ).bind(
            providerEventId,
            delivery.id,
            message.eventId,
            message.operationId,
            message.eventId,
            claimToken,
          ),
          env.DB.prepare(
            `UPDATE communications SET status = 'sent', sent_at = unixepoch(), updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND operation_id = ?
              AND EXISTS (
                SELECT 1 FROM operation_jobs claimed_operation
                 WHERE claimed_operation.id = communications.operation_id
                   AND claimed_operation.event_id = communications.event_id
                   AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
              )`,
          ).bind(
            delivery.communicationId,
            message.eventId,
            message.operationId,
            claimToken,
          ),
        ]);
        if (
          (emailCompletionResults[0].meta.changes ?? 0) !== 1 ||
          (emailCompletionResults[1].meta.changes ?? 0) !== 1
        ) {
          throw new QueueClaimLeaseLostError();
        }
      }
    } else {
      if (
        invitation.connectionProvider !== message.provider ||
        !invitation.encryptedCredentials ||
        invitation.connectionStatus !== "connected" ||
        (invitation.connectionExpiresAt !== null &&
          invitation.connectionExpiresAt <= Math.floor(Date.now() / 1_000))
      ) {
        throw new Error(
          `The ${message.provider} calendar connection is missing or no longer active.`,
        );
      }
      let provider = dependencies.directCalendar;
      if (!provider) {
        const credentials = await decryptCalendarCredentials(
          invitation.encryptedCredentials,
          env.CALENDAR_CREDENTIALS_KEY,
        );
        provider =
          message.provider === "google"
            ? new GoogleCalendarProvider(
                credentials.accessToken,
                credentials.calendarId,
              )
            : new MicrosoftCalendarProvider(credentials.accessToken);
      }
      if (provider.name !== message.provider)
        throw new Error(
          `The injected ${provider.name} adapter cannot process a ${message.provider} operation.`,
        );
      await renewOperationClaim(
        env,
        { organisationId: message.organisationId, eventId: message.eventId },
        message.operationId,
        claimToken,
      );
      const beforeProvider = await loadCalendarAttempt(env, message);
      if (
        !isExactCalendarAttempt(beforeProvider, message, payloadHash) ||
        beforeProvider?.status !== "running"
      ) {
        await finishSupersededCalendarAttempt(
          env,
          message,
          "A newer calendar lifecycle attempt replaced this work before provider delivery.",
          null,
          claimToken,
        );
        return;
      }
      const result = await provider.apply({
        uid: message.payload.uid,
        title: message.payload.title,
        description: message.payload.description,
        location: message.payload.location,
        startsAtIso: new Date(message.payload.startsAt * 1_000).toISOString(),
        endsAtIso: new Date(message.payload.endsAt * 1_000).toISOString(),
        timezone: message.payload.timezone,
        attendeeEmail: message.payload.attendeeEmail,
        attendeeName: message.payload.attendeeName,
        sequence: message.payload.sequence,
        method: message.payload.method,
        externalEventId: beforeProvider.providerEventId,
      });
      providerEventId = result.providerEventId;
    }
  } catch (error) {
    await assertOperationClaim(
      env,
      message.operationId,
      message.eventId,
      claimToken,
    );
    const current = await loadCalendarAttempt(env, message);
    if (!isExactCalendarAttempt(current, message, payloadHash)) {
      await finishSupersededCalendarAttempt(
        env,
        message,
        `The attempt was superseded while provider delivery was in progress: ${error instanceof Error ? error.message : String(error)}`,
        null,
        claimToken,
      );
      return;
    }
    await finishCalendarAttemptFailure(
      env,
      message,
      payloadHash,
      errorDetails(error),
      claimToken,
    );
    return;
  }

  const invitationStatus =
    message.payload.method === "CANCEL" ? "cancelled" : "sent";
  let completionResults: D1Result[];
  try {
    completionResults = await env.DB.batch([
      env.DB.prepare(
        `UPDATE calendar_invitations
        SET status = ?, provider_event_id = COALESCE(?, provider_event_id), updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND current_attempt_id = ? AND sequence_number = ?
          AND method = ? AND last_payload_hash = ?
          AND EXISTS (
            SELECT 1 FROM operation_jobs claimed_operation
             WHERE claimed_operation.id = ? AND claimed_operation.event_id = ?
               AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
          )`,
      ).bind(
        invitationStatus,
        message.provider === "email_ics" ? null : providerEventId,
        message.invitationId,
        message.eventId,
        message.attemptId,
        message.payload.sequence,
        message.payload.method,
        payloadHash,
        message.operationId,
        message.eventId,
        claimToken,
      ),
      env.DB.prepare(
        `UPDATE calendar_sync_attempts
        SET status = 'succeeded', provider_event_id = ?, error_code = NULL, error_message = NULL,
            completed_at = unixepoch()
        WHERE id = ? AND invitation_id = ? AND sequence_number = ? AND method = ? AND provider = ?
          AND status = 'running'
          AND EXISTS (
            SELECT 1 FROM calendar_invitations ci
            JOIN operation_jobs claimed_operation ON claimed_operation.id = ? AND claimed_operation.event_id = ci.event_id
             WHERE ci.id = ? AND ci.event_id = ? AND ci.current_attempt_id = ?
               AND ci.sequence_number = ? AND ci.method = ? AND ci.last_payload_hash = ?
               AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
          )`,
      ).bind(
        providerEventId,
        message.attemptId,
        message.invitationId,
        message.payload.sequence,
        message.payload.method,
        message.provider,
        message.operationId,
        message.invitationId,
        message.eventId,
        message.attemptId,
        message.payload.sequence,
        message.payload.method,
        payloadHash,
        claimToken,
      ),
      env.DB.prepare(
        `UPDATE operation_items
        SET status = 'completed', result_json = ?, error_code = NULL, error_message = NULL,
            completed_at = unixepoch(), updated_at = unixepoch()
        WHERE operation_id = ? AND entity_id = ?
          AND EXISTS (
            SELECT 1 FROM operation_jobs claimed_operation
             WHERE claimed_operation.id = operation_items.operation_id
               AND claimed_operation.event_id = ? AND claimed_operation.status = 'running'
               AND claimed_operation.claim_token = ?
          )`,
      ).bind(
        JSON.stringify({
          provider: message.provider,
          providerEventId,
          sequence: message.payload.sequence,
        }),
        message.operationId,
        message.invitationId,
        message.eventId,
        claimToken,
      ),
      env.DB.prepare(
        `UPDATE operation_jobs
        SET status = 'completed', progress_total = 1, progress_completed = 1, progress_failed = 0,
            result_json = ?, last_error = NULL, completed_at = unixepoch(),
            claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status = 'running' AND claim_token = ?`,
      ).bind(
        JSON.stringify({
          invitationId: message.invitationId,
          provider: message.provider,
          providerEventId,
          sequence: message.payload.sequence,
        }),
        message.operationId,
        message.eventId,
        claimToken,
      ),
      // action is NOT NULL. If the invitation/attempt CAS above did not win,
      // this scalar subquery returns NULL and rolls the entire D1 batch back.
      env.DB.prepare(
        `INSERT INTO audit_events (
        id, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
      ) VALUES (?, ?, ?, (
        SELECT 'calendar.lifecycle.completed'
          FROM calendar_invitations ci
          JOIN calendar_sync_attempts csa ON csa.id = ? AND csa.invitation_id = ci.id
         WHERE ci.id = ? AND ci.event_id = ? AND ci.current_attempt_id = ?
           AND ci.sequence_number = ? AND ci.method = ? AND ci.last_payload_hash = ?
           AND csa.status = 'succeeded' AND csa.sequence_number = ?
           AND csa.method = ? AND csa.provider = ?
           AND changes() = 1
      ), 'calendar_invitation', ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        message.organisationId,
        message.eventId,
        message.attemptId,
        message.invitationId,
        message.eventId,
        message.attemptId,
        message.payload.sequence,
        message.payload.method,
        payloadHash,
        message.payload.sequence,
        message.payload.method,
        message.provider,
        message.invitationId,
        JSON.stringify({
          attemptId: message.attemptId,
          provider: message.provider,
          method: message.payload.method,
          sequence: message.payload.sequence,
          providerEventId,
        }),
      ),
      env.DB.prepare(
        `INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
        SELECT event_id, 'calendar_invitation', ?, 'progress', correlation_id, unixepoch()
          FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'completed' AND changes() = 1
        RETURNING sequence`,
      ).bind(message.invitationId, message.operationId, message.eventId),
    ]);
  } catch (error) {
    await assertOperationClaim(
      env,
      message.operationId,
      message.eventId,
      claimToken,
    );
    const current = await loadCalendarAttempt(env, message);
    if (!isExactCalendarAttempt(current, message, payloadHash)) {
      await finishSupersededCalendarAttempt(
        env,
        message,
        "A newer calendar lifecycle attempt replaced this work before its provider result could be committed.",
        providerEventId,
        claimToken,
      );
      return;
    }
    await finishCalendarAttemptFailure(
      env,
      message,
      payloadHash,
      {
        code: "CALENDAR_RESULT_COMMIT_FAILED",
        message:
          `The provider result could not be committed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            2_000,
          ),
      },
      claimToken,
    );
    throw error;
  }
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(completionResults.at(-1)),
    message.operationId,
  );
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
  if (operation.status === "completed" || operation.status === "cancelled")
    return;
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
        AND (
          status IN ('queued','received','retrying','queue_failed','failed','partially_failed')
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
    )
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "cancelled")
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

const queueFailureIdentitySchema = z
  .object({
    type: z.enum([
      "communication.send",
      "calendar.sync",
      "decision.notification",
      "submission.notification",
      "schedule.calendar_fanout",
    ]),
    operationId: z.string().min(1),
    eventId: z.string().min(1),
    organisationId: z.string().min(1),
  })
  .passthrough();

async function finishUnclaimedQueueFailure(
  env: CloudflareEnvironment,
  input: unknown,
  queueMessageId: string,
  error: unknown,
) {
  const identity = queueFailureIdentitySchema.safeParse(input);
  if (!identity.success) return;
  const details = errorDetails(error);
  const failure = `${details.message} (Queue message ${queueMessageId})`.slice(
    0,
    2_000,
  );
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'failed', progress_completed = progress_total,
          progress_failed = progress_total, attempt_count = attempt_count + 1,
          last_error = ?, completed_at = unixepoch(), claim_token = NULL,
          claim_expires_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ? AND type = ?
        AND status IN ('queued','queue_failed','received','retrying')
        AND claim_token IS NULL`,
    ).bind(
      failure,
      identity.data.operationId,
      identity.data.eventId,
      identity.data.organisationId,
      identity.data.type,
    ),
    env.DB.prepare(
      `UPDATE communication_deliveries
      SET status = 'failed', failure_code = ?, failure_message = ?, next_attempt_at = NULL,
          updated_at = unixepoch()
      WHERE event_id = ? AND status IN ('queued','sending','failed')
        AND EXISTS (
          SELECT 1 FROM communications c
          JOIN operation_jobs failed_operation ON failed_operation.id = c.operation_id
           WHERE c.id = communication_deliveries.communication_id
             AND c.operation_id = ? AND c.event_id = ?
             AND failed_operation.organisation_id = ?
             AND failed_operation.type = ? AND failed_operation.status = 'failed'
             AND failed_operation.last_error = ?
        )`,
    ).bind(
      details.code,
      details.message,
      identity.data.eventId,
      identity.data.operationId,
      identity.data.eventId,
      identity.data.organisationId,
      identity.data.type,
      failure,
    ),
    env.DB.prepare(
      `UPDATE communications
      SET status = 'failed', updated_at = unixepoch()
      WHERE operation_id = ? AND event_id = ? AND status IN ('queued','sending','failed')
        AND EXISTS (
          SELECT 1 FROM operation_jobs failed_operation
           WHERE failed_operation.id = communications.operation_id
             AND failed_operation.organisation_id = ?
             AND failed_operation.type = ? AND failed_operation.status = 'failed'
             AND failed_operation.last_error = ?
        )`,
    ).bind(
      identity.data.operationId,
      identity.data.eventId,
      identity.data.organisationId,
      identity.data.type,
      failure,
    ),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = unixepoch(),
          updated_at = unixepoch()
      WHERE operation_id = ? AND status IN ('pending','running','failed')
        AND EXISTS (
          SELECT 1 FROM operation_jobs failed_operation
           WHERE failed_operation.id = operation_items.operation_id
             AND failed_operation.event_id = ? AND failed_operation.organisation_id = ?
             AND failed_operation.type = ? AND failed_operation.status = 'failed'
             AND failed_operation.last_error = ?
        )`,
    ).bind(
      details.code,
      details.message,
      identity.data.operationId,
      identity.data.eventId,
      identity.data.organisationId,
      identity.data.type,
      failure,
    ),
  ]);
}

export async function handleProgramCueQueueMessage(
  message: Message,
  env: CloudflareEnvironment,
) {
  const body = message.body as { type?: unknown } | null;
  if (
    body?.type !== "communication.send" &&
    body?.type !== "calendar.sync" &&
    body?.type !== "decision.notification" &&
    body?.type !== "submission.notification" &&
    body?.type !== "schedule.calendar_fanout"
  )
    return false;
  try {
    if (body.type === "communication.send")
      await processCommunicationSend(body, env);
    else if (body.type === "calendar.sync")
      await processCalendarSync(body, env);
    else if (body.type === "decision.notification")
      await processDecisionNotification(body, env);
    else if (body.type === "submission.notification")
      await processSubmissionNotification(body, env);
    else await processScheduleCalendarFanout(body, env);
    message.ack();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        subsystem: "communications-queue",
        type: body.type,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    if (error instanceof QueueClaimLeaseBusyError) {
      message.retry({ delaySeconds: error.retryAfterSeconds });
    } else {
      try {
        await finishUnclaimedQueueFailure(env, body, message.id, error);
      } catch (failureError) {
        console.error(
          JSON.stringify({
            level: "error",
            subsystem: "communications-queue",
            type: body.type,
            message: `Could not persist the Queue failure: ${failureError instanceof Error ? failureError.message : String(failureError)}`,
          }),
        );
      }
      message.retry();
    }
  }
  return true;
}
