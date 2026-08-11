import { z } from "zod";

import { createEmailProvider } from "../../app/modules/communications/email-provider.server";
import { WebhookService } from "../../app/platform/operations/webhook-service.server";
import { sourceRevisionForLog } from "../../app/platform/observability/source-revision.server";
import {
  assertOperationClaim,
  errorDetails,
  loadOperationClaim,
  notifyRealtimeAfterCommit,
  QUEUE_CLAIM_LEASE_SECONDS,
  QueueClaimLeaseBusyError,
  QueueClaimLeaseLostError,
  renewOperationClaim,
  returnedChangeSequence,
} from "./claim-infrastructure";
import type { QueueProviderDependencies } from "./handler-types";
import {
  communicationContentSnapshotSchema,
  deliverCommunicationBatch,
} from "./communication-delivery-batch";

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
type ClaimedCommunication = {
  kind: "transactional" | "optional";
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
};
type CommunicationDelivery = {
  id: string;
  personId: string | null;
  address: string;
  name: string;
  idempotencyKey: string;
  sourceValuesJson: string;
};

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
  if (["completed", "cancelled"].includes(operation.status)) return;
  let recoverOwnedFailure = false;
  if (["failed", "partially_failed"].includes(operation.status)) {
    const completedAggregate = await env.DB.prepare(
      `SELECT 1
         FROM audit_events
        WHERE organisation_id = ? AND event_id = ?
          AND action = 'communication.delivery.finished'
          AND entity_type = 'communication' AND entity_id = ?
          AND json_extract(metadata_json, '$.operationId') = ?
        LIMIT 1`,
    )
      .bind(
        message.organisationId,
        message.eventId,
        message.communicationId,
        message.operationId,
      )
      .first();
    if (completedAggregate) return;
    recoverOwnedFailure = true;
  }
  const includeFailed =
    !recoverOwnedFailure &&
    (message.includeFailed === true ||
      ["retrying", "running"].includes(operation.status));

  const communication = await env.DB.prepare(
    `
    SELECT c.id, c.status, c.kind, c.recipient_count AS recipientCount,
           c.content_snapshot_json AS contentSnapshotJson
      FROM communications c
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
    }>();
  if (!communication)
    throw new Error(
      "Communication does not exist for this operation in the authorised event.",
    );
  if (communication.status === "cancelled") return;
  const snapshot = communicationContentSnapshotSchema.parse(
    JSON.parse(communication.contentSnapshotJson),
  );
  const provider = dependencies.email ?? createEmailProvider(env);
  const durableProviders = await env.DB.prepare(
    `SELECT DISTINCT provider
       FROM communication_deliveries
      WHERE communication_id = ? AND event_id = ?`,
  )
    .bind(message.communicationId, message.eventId)
    .all<{ provider: string | null }>();
  if (
    durableProviders.results.length !== 1 ||
    durableProviders.results[0]?.provider !== provider.name
  ) {
    throw new Error(
      "The communication delivery provider does not match its durable intent.",
    );
  }

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
                claim_operation.status IN ('queued','received','retrying','queue_failed')
                OR (? = 1 AND claim_operation.status IN ('failed','partially_failed'))
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
      recoverOwnedFailure ? 1 : 0,
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
           status IN ('queued','received','retrying','queue_failed')
           OR (? = 1 AND status IN ('failed','partially_failed'))
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
      recoverOwnedFailure ? 1 : 0,
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
    // Resolve mutable sender authority only after this worker owns the
    // operation. A sender disabled before the claim must never be used from a
    // stale pre-claim read.
    const claimedCommunication = await env.DB.prepare(
      `SELECT c.kind, sp.from_name AS fromName, sp.from_email AS fromEmail,
              sp.reply_to_email AS replyToEmail
         FROM communications c
         JOIN sender_profiles sp
           ON sp.id = c.sender_profile_id AND sp.event_id = c.event_id
          AND sp.status = 'verified' AND sp.provider = ?
         JOIN operation_jobs operation
           ON operation.id = c.operation_id AND operation.event_id = c.event_id
          AND operation.status = 'running' AND operation.claim_token = ?
        WHERE c.id = ? AND c.event_id = ? AND c.operation_id = ?
          AND c.idempotency_key = ? AND c.status = 'sending'`,
    )
      .bind(
        provider.name,
        claimToken,
        message.communicationId,
        message.eventId,
        message.operationId,
        message.idempotencyKey,
      )
      .first<ClaimedCommunication>();
    if (!claimedCommunication)
      throw new Error("A verified sender profile is unavailable.");
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
      .all<CommunicationDelivery>();
    await deliverCommunicationBatch({
      env,
      message,
      communication: claimedCommunication,
      snapshot,
      deliveries,
      claimToken,
      provider,
    });

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

    const completionAuditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      {
        organisationId: message.organisationId,
        eventId: message.eventId,
        personId: null,
        actorId: "system:communications-queue",
      },
      {
        eventType: "communication.completed",
        entityType: "communication",
        entityId: message.communicationId,
        idempotencyKey: `communication.completed:${message.communicationId}:${message.operationId}`,
        correlationId: message.operationId,
        data: {
          status: communicationStatus,
          total,
          succeeded,
          failed,
        },
      },
      completionAuditEventId,
    );

    const completionStatements: D1PreparedStatement[] = [
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
        completionAuditEventId,
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
    ];
    const completionChangeIndex = completionStatements.length - 1;
    completionStatements.push(...preparedWebhook.statements);
    const completionResults = await env.DB.batch(completionStatements);
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
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    await notifyRealtimeAfterCommit(
      env,
      { organisationId: message.organisationId, eventId: message.eventId },
      returnedChangeSequence(completionResults[completionChangeIndex]),
      message.operationId,
    );
  } catch (error) {
    try {
      await finishOwnedCommunicationFailure(env, message, claimToken, error);
    } catch (failureError) {
      console.error(
        JSON.stringify({
          level: "error",
          sourceRevision: sourceRevisionForLog(env),
          subsystem: "operations-queue",
          event: "owned-failure-persistence-failed",
          operationId: message.operationId,
          eventId: message.eventId,
          provider:
            env.EMAIL_PROVIDER === "resend" || env.EMAIL_PROVIDER === "mailpit"
              ? env.EMAIL_PROVIDER
              : "email-unconfigured",
          errorName:
            failureError instanceof Error ? failureError.name : "UnknownError",
          message: "The owned communication failure could not be persisted.",
        }),
      );
    }
    throw error;
  }
}
