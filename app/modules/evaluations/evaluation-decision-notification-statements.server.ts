import type { DecisionStatementInput } from "./evaluation-decision-statements.server";

export function buildDecisionNotificationStatements(
  input: Pick<
    DecisionStatementInput,
    "env" | "viewer" | "submission" | "notificationIntent" | "decisionId"
  >,
): D1PreparedStatement[] {
  const { env, viewer, submission, notificationIntent, decisionId } = input;
  return notificationIntent
    ? [
        env.DB.prepare(
          `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json,
          progress_completed, progress_total, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'decision.notification', ?, ?, 'queued', ?, 0, 1, unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM submission_decisions
            WHERE id = ? AND event_id = ? AND status = 'published'
         )
      `,
        ).bind(
          notificationIntent.operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          notificationIntent.operationIdempotencyKey,
          notificationIntent.correlationId,
          notificationIntent.queuePayloadJson,
          decisionId,
          viewer.eventId,
        ),
        env.DB.prepare(
          `
        INSERT INTO communications (
          id, event_id, template_version_id, sender_profile_id, operation_id,
          idempotency_key, kind, channel, status, audience_json,
          content_snapshot_json, recipient_count, queued_at,
          created_by_person_id, created_at, updated_at
        )
        SELECT ?, decision.event_id, version.id, sender.id, operation.id,
               ?, 'transactional', 'email', 'queued', ?, ?, 1, unixepoch(),
               ?, unixepoch(), unixepoch()
          FROM submission_decisions decision
          JOIN operation_jobs operation
            ON operation.id = decision.notification_operation_id
           AND operation.event_id = decision.event_id
           AND operation.organisation_id = ?
           AND operation.status = 'queued'
          JOIN communication_template_versions version
            ON version.id = ? AND version.event_id = decision.event_id
           AND version.status = 'published' AND version.category = 'decision'
           AND version.channel = 'email' AND version.name = ?
           AND version.version_number = ? AND version.subject_template = ?
           AND version.content_json = ?
          JOIN communication_templates template
            ON template.id = version.template_id
           AND template.event_id = version.event_id
           AND template.status = 'active'
          JOIN sender_profiles sender
            ON sender.id = ? AND sender.event_id = decision.event_id
           AND sender.status = 'verified' AND sender.provider = ?
           AND sender.from_name = ? AND sender.from_email = ?
           AND sender.reply_to_email IS ?
          JOIN events event
            ON event.id = decision.event_id AND event.organisation_id = ?
           AND event.name = ? AND event.brand_accent = ?
           AND event.starts_at = ? AND event.ends_at = ?
         WHERE decision.id = ? AND decision.event_id = ?
           AND decision.status = 'published'
      `,
        ).bind(
          notificationIntent.communicationId,
          notificationIntent.operationIdempotencyKey,
          notificationIntent.audienceJson,
          notificationIntent.contentSnapshotJson,
          viewer.personId,
          viewer.organisationId,
          notificationIntent.templateVersionId,
          notificationIntent.templateName,
          notificationIntent.templateVersionNumber,
          notificationIntent.templateSubject,
          notificationIntent.templateContentJson,
          notificationIntent.senderProfileId,
          notificationIntent.senderProvider,
          notificationIntent.senderFromName,
          notificationIntent.senderFromEmail,
          notificationIntent.senderReplyToEmail,
          viewer.organisationId,
          notificationIntent.eventName,
          notificationIntent.eventBrandAccent,
          notificationIntent.eventStartsAt,
          notificationIntent.eventEndsAt,
          decisionId,
          viewer.eventId,
        ),
        env.DB.prepare(
          `
        INSERT INTO communication_deliveries (
          id, event_id, communication_id, person_id, recipient_address,
          recipient_name, source_id, source_values_json, channel, provider,
          idempotency_key, status, rendered_subject, rendered_body_sha256,
          created_at, updated_at
        )
        SELECT ?, communication.event_id, communication.id, ?, ?, ?, ?, ?,
               'email', ?, ?, 'queued', ?, ?, unixepoch(), unixepoch()
          FROM communications communication
         WHERE communication.id = ? AND communication.event_id = ?
           AND communication.operation_id = ?
           AND communication.status = 'queued'
      `,
        ).bind(
          notificationIntent.deliveryId,
          notificationIntent.recipientPersonId,
          notificationIntent.recipientAddress,
          notificationIntent.recipientName,
          submission.id,
          notificationIntent.sourceValuesJson,
          notificationIntent.senderProvider,
          notificationIntent.deliveryIdempotencyKey,
          notificationIntent.renderedSubject,
          notificationIntent.renderedBodySha256,
          notificationIntent.communicationId,
          viewer.eventId,
          notificationIntent.operationId,
        ),
        env.DB.prepare(
          `
        INSERT INTO operation_items (
          id, operation_id, item_key, entity_type, entity_id, status,
          result_json, updated_at
        )
        SELECT ?, operation.id, ?, 'communication_delivery', delivery.id,
               'pending', json_object('sourceId', ?), unixepoch()
          FROM operation_jobs operation
          JOIN communication_deliveries delivery
            ON delivery.id = ? AND delivery.event_id = operation.event_id
         WHERE operation.id = ? AND operation.event_id = ?
           AND operation.status = 'queued'
      `,
        ).bind(
          notificationIntent.operationItemId,
          notificationIntent.deliveryIdempotencyKey,
          submission.id,
          notificationIntent.deliveryId,
          notificationIntent.operationId,
          viewer.eventId,
        ),
        env.DB.prepare(
          `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id,
          actor_person_id, action, entity_type, entity_id, correlation_id,
          metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
               'decision.notification.prepared', 'communication', ?, ?, ?,
               unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM communication_deliveries
            WHERE id = ? AND event_id = ? AND communication_id = ?
         )
      `,
        ).bind(
          `decision-notification-prepared:${notificationIntent.operationId}`,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          notificationIntent.communicationId,
          notificationIntent.operationId,
          JSON.stringify({
            decisionId,
            operationId: notificationIntent.operationId,
            templateVersionId: notificationIntent.templateVersionId,
            deliveryId: notificationIntent.deliveryId,
            renderedSubject: notificationIntent.renderedSubject,
            renderedBodySha256: notificationIntent.renderedBodySha256,
          }),
          notificationIntent.deliveryId,
          viewer.eventId,
          notificationIntent.communicationId,
        ),
        env.DB.prepare(
          `
        INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, correlation_id,
          created_at
        )
        SELECT ?, 'communication', ?, 'created', ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM communication_deliveries
            WHERE id = ? AND event_id = ? AND communication_id = ?
         )
      `,
        ).bind(
          viewer.eventId,
          notificationIntent.communicationId,
          notificationIntent.correlationId,
          notificationIntent.deliveryId,
          viewer.eventId,
          notificationIntent.communicationId,
        ),
      ]
    : [];
}
