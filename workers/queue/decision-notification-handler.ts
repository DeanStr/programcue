import { z } from "zod";

import { templateContentSchema } from "../../app/modules/communications/communication-schema";
import { requireEmailProviderConfiguration } from "../../app/modules/communications/email-provider.server";
import { communicationDeliveryIdempotencyKey } from "../../app/modules/communications/communication-service-shared";
import { processCommunicationSend } from "./communication-send";
import type { QueueProviderDependencies } from "./handler-types";
import { markTriggerFailure } from "./notification-failure";

const decisionNotificationMessageSchema = z.object({
  type: z.literal("decision.notification"),
  operationId: z.string().min(1),
  eventId: z.string().min(1),
  organisationId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  payload: z.object({ decisionId: z.string().min(1) }),
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
    SELECT o.id, o.status, o.requested_by_person_id AS requestedByPersonId,
           o.payload_json AS payloadJson
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
      payloadJson: string;
    }>();
  if (!operation)
    throw new Error(
      "Decision notification operation does not exist in the authorised event.",
    );
  if (operation.status === "completed" || operation.status === "cancelled")
    return;
  let savedMessage: ReturnType<typeof decisionNotificationMessageSchema.parse>;
  try {
    savedMessage = decisionNotificationMessageSchema.parse(
      JSON.parse(operation.payloadJson),
    );
  } catch {
    throw new Error("The durable decision notification payload is invalid.");
  }
  if (JSON.stringify(savedMessage) !== JSON.stringify(message)) {
    throw new Error(
      "The decision notification Queue message does not match its durable operation payload.",
    );
  }
  if (["failed", "partially_failed"].includes(operation.status)) {
    const terminal = await env.DB.prepare(
      `SELECT communication.id,
              EXISTS (
                SELECT 1 FROM audit_events failed_audit
                 WHERE failed_audit.event_id = communication.event_id
                   AND failed_audit.action = 'decision.notification.failed'
                   AND failed_audit.entity_type = 'communication'
                   AND failed_audit.entity_id = communication.id
              ) AS configurationFailed
         FROM communications communication
        WHERE communication.event_id = ? AND communication.operation_id = ?
          AND communication.idempotency_key = ?
        LIMIT 1`,
    )
      .bind(message.eventId, message.operationId, message.idempotencyKey)
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

  const decision = await env.DB.prepare(
    `
    SELECT sd.id AS decisionId, sd.decision, s.id AS submissionId, s.title AS submissionTitle,
           s.submitter_person_id AS personId, COALESCE(p.email, s.submitter_email) AS address,
           COALESCE(p.display_name, s.submitter_email) AS recipientName,
           e.name AS eventName, e.brand_accent AS brandAccent,
           e.starts_at AS startsAt, e.ends_at AS endsAt
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
      brandAccent: string;
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
        FROM sender_profiles WHERE event_id = ? AND provider = ? AND status = 'verified'
       ORDER BY updated_at DESC LIMIT 1
    `,
    )
      .bind(
        message.eventId,
        emailProvider?.provider ?? "email-provider-unavailable",
      )
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
  if (!configurationError && emailProviderError)
    configurationError = emailProviderError;
  if (!configurationError && !sender)
    configurationError =
      "A verified sender profile is required for decision notifications.";

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
  const deliveryKey = await communicationDeliveryIdempotencyKey(
    message.idempotencyKey,
    decision.address ?? "unavailable",
  );
  const contentSnapshot =
    content && template
      ? {
          schemaVersion: 1,
          category: "decision",
          subjectTemplate: template.subjectTemplate,
          content,
          event: {
            eventName: decision.eventName,
            brandAccent: decision.brandAccent,
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
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, unixepoch(), unixepoch()
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
        emailProvider?.provider ?? null,
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
