import { z } from "zod";

import { templateContentSchema } from "../../app/modules/communications/communication-schema";
import { communicationDeliveryIdempotencyKey } from "../../app/modules/communications/communication-service-shared";
import { requireEmailProviderConfiguration } from "../../app/modules/communications/email-provider.server";
import { processCommunicationSend } from "./communication-send";
import type { QueueProviderDependencies } from "./handler-types";
import { markTriggerFailure } from "./notification-failure";

const INVALID_SUBMISSION_NOTIFICATION_FAILURE =
  "The durable submission notification snapshot is invalid and cannot be delivered safely. Ask the applicant to submit again or contact them through an explicitly reviewed communication.";

const submissionNotificationMessageSchema = z.object({
  type: z.literal("submission.notification"),
  operationId: z.string().min(1),
  communicationId: z.string().min(1),
  submissionId: z.string().min(1),
  eventId: z.string().min(1),
  organisationId: z.string().min(1),
  idempotencyKey: z.string().min(8),
});
/** Materialises the durable public-submission confirmation intent. */
export async function processSubmissionNotification(
  input: unknown,
  env: CloudflareEnvironment,
  dependencies: QueueProviderDependencies = {},
) {
  const message = submissionNotificationMessageSchema.parse(input);
  const operation = await env.DB.prepare(
    `
    SELECT o.id, o.status, o.requested_by_person_id AS requestedByPersonId,
           o.last_error AS lastError,
           o.payload_json AS payloadJson
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
      lastError: string | null;
      payloadJson: string;
    }>();
  if (!operation)
    throw new Error(
      "Submission confirmation operation does not exist in the authorised event.",
    );
  if (operation.status === "completed" || operation.status === "cancelled")
    return;
  if (
    ["failed", "partially_failed"].includes(operation.status) &&
    operation.lastError === INVALID_SUBMISSION_NOTIFICATION_FAILURE
  ) {
    return;
  }
  let savedMessage: ReturnType<
    typeof submissionNotificationMessageSchema.parse
  >;
  try {
    savedMessage = submissionNotificationMessageSchema.parse(
      JSON.parse(operation.payloadJson),
    );
  } catch {
    await markTriggerFailure(
      env,
      message,
      INVALID_SUBMISSION_NOTIFICATION_FAILURE,
      message.communicationId,
    );
    return;
  }
  if (JSON.stringify(savedMessage) !== JSON.stringify(message)) {
    throw new Error(
      "The submission notification Queue message does not match its durable operation payload.",
    );
  }
  if (["failed", "partially_failed"].includes(operation.status)) {
    const terminal = await env.DB.prepare(
      `SELECT communication.id,
              EXISTS (
                SELECT 1 FROM audit_events failed_audit
                 WHERE failed_audit.event_id = communication.event_id
                   AND failed_audit.action = 'submission.notification.failed'
                   AND failed_audit.entity_type = 'communication'
                   AND failed_audit.entity_id = communication.id
              ) AS configurationFailed
         FROM communications communication
        WHERE communication.id = ? AND communication.event_id = ?
          AND communication.operation_id = ? AND communication.idempotency_key = ?
        LIMIT 1`,
    )
      .bind(
        message.communicationId,
        message.eventId,
        message.operationId,
        message.idempotencyKey,
      )
      .first<{ id: string; configurationFailed: number }>();
    if (!terminal || terminal.configurationFailed === 1) return;
    await processCommunicationSend(
      {
        type: "communication.send",
        operationId: message.operationId,
        communicationId: terminal.id,
        eventId: message.eventId,
        organisationId: message.organisationId,
        idempotencyKey: message.idempotencyKey,
      },
      env,
      dependencies,
    );
    return;
  }

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
           e.name AS eventName, e.brand_accent AS brandAccent,
           e.starts_at AS startsAt, e.ends_at AS endsAt
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
      brandAccent: string;
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

  let emailProvider: ReturnType<
    typeof requireEmailProviderConfiguration
  > | null = null;
  let emailProviderError: string | null = null;
  try {
    emailProvider = requireEmailProviderConfiguration(env);
  } catch (error) {
    emailProviderError =
      error instanceof Error
        ? error.message
        : "Email provider configuration is invalid.";
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
       WHERE event_id = ? AND provider = ? AND status = 'verified'
       ORDER BY updated_at DESC LIMIT 1
    `,
    )
      .bind(
        message.eventId,
        emailProvider?.provider ?? "email-provider-unavailable",
      )
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
  if (!configurationError && emailProviderError)
    configurationError = emailProviderError;
  if (!configurationError && !sender)
    configurationError =
      "A verified sender profile is required for submission confirmations.";

  const deliveryKey = await communicationDeliveryIdempotencyKey(
    message.idempotencyKey,
    submission.address ?? "unavailable",
  );
  const contentSnapshot =
    content && template
      ? {
          schemaVersion: 1,
          category: "submission_confirmation",
          subjectTemplate: template.subjectTemplate,
          content,
          event: {
            eventName: submission.eventName,
            brandAccent: submission.brandAccent,
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
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, unixepoch(), unixepoch()
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
        emailProvider?.provider ?? null,
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
      id, actor_kind, origin, metadata_version, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
    ) SELECT ?, 'system', 'queue', 1, ?, ?, ?, 'communication', ?, ?, unixepoch()
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
