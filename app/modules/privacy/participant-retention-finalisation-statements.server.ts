import type { Viewer } from "~/platform/auth/authorize.server";
import {
  REDACTED_JSON,
  completionId,
  eventClaimGuard,
  type CompletionMetadata,
} from "./participant-retention-foundation.server";

export function buildParticipantRetentionFinalisationStatements(
  env: CloudflareEnvironment,
  viewer: Viewer,
  operationId: string,
  completionMetadata: CompletionMetadata,
  claimStatement: D1PreparedStatement,
) {
  const guard = eventClaimGuard();
  const guarded = (sql: string, ...bindings: unknown[]) =>
    env.DB.prepare(`${sql} AND ${guard}`).bind(
      ...bindings,
      viewer.eventId,
      viewer.organisationId,
      operationId,
    );
  const statements = [
    claimStatement,
    guarded(
      `UPDATE submissions
          SET submitter_email = NULL, public_reference = 'retained-' || id,
              title = 'Retained submission',
              answers_json = ?,
              submitted_snapshot_json = CASE WHEN submitted_snapshot_json IS NULL THEN NULL ELSE ? END,
              last_operation_id = NULL, updated_at = unixepoch()
        WHERE event_id = ?`,
      REDACTED_JSON,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE submission_revisions
          SET answers_json = ?, speaker_snapshot_json = ?, idempotency_key = NULL
        WHERE event_id = ?`,
      REDACTED_JSON,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `DELETE FROM submission_email_verifications WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE submission_speakers
          SET email = 'retained-speaker-' || id || '@privacy.invalid',
              display_name = 'Anonymised speaker', role_label = NULL,
              invitation_status = 'revoked', claim_token_hash = NULL,
              invitation_expires_at = NULL, updated_at = unixepoch()
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE evaluator_conflicts SET relationship = NULL, notes = NULL
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE evaluator_assignments SET session_snapshot_json = ?
        WHERE event_id = ? AND session_snapshot_json IS NOT NULL`,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE reviews
          SET scores_json = ?, submitter_feedback = NULL, private_notes = NULL,
              ai_suggestion_id = NULL, imported_criterion_ids_json = '[]',
              confirmed_ai_criterion_ids_json = '[]',
              last_operation_id = NULL, updated_at = unixepoch()
        WHERE event_id = ?`,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE review_revisions
          SET scores_json = ?, content_json = ?, idempotency_key = NULL,
              ai_suggestion_id = NULL, imported_criterion_ids_json = '[]',
              confirmed_ai_criterion_ids_json = '[]'
        WHERE event_id = ?`,
      REDACTED_JSON,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE evaluation_discussion_messages
          SET body = NULL, idempotency_key = 'retained-discussion-' || id
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE review_moderations SET notes = NULL WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `DELETE FROM reviewer_ai_suggestions WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `DELETE FROM ai_review_assessments WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE submission_decisions
          SET rationale = NULL, notification_feedback_json = '[]',
              effect_preview_json = ?, idempotency_key = NULL
        WHERE event_id = ?`,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE sessions SET description = NULL WHERE event_id = ? AND source_submission_id IS NOT NULL`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE schedule_session_contents
          SET description = NULL, updated_at = unixepoch()
        WHERE event_id = ?
          AND session_id IN (
            SELECT id FROM sessions
             WHERE event_id = schedule_session_contents.event_id
               AND source_submission_id IS NOT NULL
          )`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE session_content_revisions
          SET description = NULL
        WHERE event_id = ?
          AND session_id IN (
            SELECT id FROM sessions
             WHERE event_id = session_content_revisions.event_id
               AND source_submission_id IS NOT NULL
          )`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE schedule_conflicts
          SET details_json = ?, resolution_json = CASE WHEN resolution_json IS NULL THEN NULL ELSE ? END
        WHERE event_id = ?`,
      REDACTED_JSON,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `DELETE FROM public_itineraries WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `DELETE FROM event_participant_profiles
        WHERE event_id = ? AND organisation_id = ?`,
      viewer.eventId,
      viewer.organisationId,
    ),
    guarded(
      `DELETE FROM speaker_profile_revisions
        WHERE event_id = ? AND organisation_id = ?`,
      viewer.eventId,
      viewer.organisationId,
    ),
    guarded(
      `UPDATE task_instances
          SET title = 'Retained participant task',
              description = NULL,
              evidence_json = CASE WHEN evidence_json IS NULL THEN NULL ELSE ? END,
              waiver_json = CASE WHEN waiver_json IS NULL THEN NULL ELSE ? END,
              last_operation_id = NULL, idempotency_key = NULL,
              updated_at = unixepoch()
        WHERE event_id = ? AND target_type = 'speaker'`,
      REDACTED_JSON,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE task_comments
          SET body = '[redacted after event retention]', edited_at = unixepoch()
        WHERE event_id = ?
          AND task_id IN (
            SELECT id FROM task_instances
             WHERE event_id = task_comments.event_id AND target_type = 'speaker'
          )`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE task_evidence SET evidence_json = ?
        WHERE event_id = ?
          AND task_id IN (
            SELECT id FROM task_instances
             WHERE event_id = task_evidence.event_id AND target_type = 'speaker'
          )`,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE file_assets
          SET status = 'deleted', current_version_id = NULL, updated_at = unixepoch()
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE file_versions
          SET object_key = 'retained/' || id, multipart_upload_id = NULL,
              original_filename = 'retained-file',
              declared_content_type = 'application/octet-stream',
              detected_content_type = NULL, checksum_sha256 = NULL,
              object_etag = NULL, scan_provider = NULL, scan_result_json = NULL,
              scan_error = NULL, released_at = NULL,
              deleted_at = COALESCE(deleted_at, unixepoch())
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE file_multipart_uploads
          SET upload_id = NULL,
              idempotency_key = 'retained-upload-' || version_id,
              manifest_json = NULL, manifest_hash = NULL,
              last_error = NULL, status = CASE WHEN status = 'completed' THEN status ELSE 'aborted' END,
              updated_at = unixepoch()
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE resource_acknowledgements SET user_agent = NULL WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE resource_pages
          SET title = 'Retained resource', slug = 'retained-' || id,
              category = NULL, status = 'archived', last_operation_id = NULL,
              archived_at = COALESCE(archived_at, unixepoch()),
              updated_at = unixepoch()
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE resource_page_versions
          SET title = 'Retained resource', slug = 'retained-' || id,
              category = NULL, document_json = ?,
              rendered_html = '<p>Content removed under the event retention policy.</p>',
              status = 'retired'
        WHERE event_id = ?`,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE resource_attachments SET label = NULL WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE sender_profiles
          SET name = 'Retained sender ' || id, from_name = 'Retained sender',
              from_email = 'retained-sender-' || id || '@privacy.invalid',
              reply_to_email = NULL, provider_sender_id = NULL,
              status = 'disabled', updated_at = unixepoch()
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE communication_templates
          SET name = 'Retained template ' || id, status = 'archived',
              last_operation_id = NULL, updated_at = unixepoch()
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE communication_template_versions
          SET name = 'Retained template',
              subject_template = CASE WHEN channel = 'email' THEN 'Retained message' ELSE NULL END,
              content_json = ?, rendered_preview_html = NULL
        WHERE event_id = ?`,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE communication_triggers
          SET configuration_json = '{}', enabled = 0, updated_at = unixepoch()
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE communications
          SET status = CASE WHEN status = 'sent' THEN status ELSE 'cancelled' END,
              idempotency_key = 'retained-communication-' || id,
              audience_json = ?, content_snapshot_json = ?,
              cancelled_at = CASE WHEN status = 'sent' THEN cancelled_at ELSE COALESCE(cancelled_at, unixepoch()) END,
              updated_at = unixepoch()
        WHERE event_id = ?`,
      REDACTED_JSON,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE communication_deliveries
          SET recipient_address = 'retained-delivery-' || id || '@privacy.invalid',
              recipient_name = NULL, source_id = NULL,
              source_values_json = ?, provider = NULL,
              provider_message_id = NULL,
              idempotency_key = 'retained-delivery-' || id,
              status = CASE WHEN status IN ('queued','sending','failed') THEN 'cancelled' ELSE status END,
              next_attempt_at = NULL, failure_code = NULL, failure_message = NULL,
              updated_at = unixepoch()
        WHERE event_id = ?`,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE communication_delivery_events
          SET provider_event_id = NULL, payload_json = ?
        WHERE delivery_id IN (
          SELECT id FROM communication_deliveries WHERE event_id = ?
        )`,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE communication_unsubscribes
          SET address = 'retained-unsubscribe-' || id || '@privacy.invalid', reason = NULL
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE calendar_connections
          SET status = 'disconnected',
              account_reference = 'retained-' || id,
              encrypted_credentials = NULL, scopes_json = '[]',
              expires_at = NULL, last_synced_at = NULL,
              updated_at = unixepoch()
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE calendar_invitations
          SET connection_id = NULL, delivery_id = NULL,
              ical_uid = 'retained-' || id, method = 'CANCEL',
              provider_event_id = NULL, status = 'cancelled',
              last_payload_hash = NULL, current_attempt_id = NULL,
              updated_at = unixepoch()
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE calendar_sync_attempts
          SET status = CASE WHEN status IN ('queued','failed') THEN 'superseded' ELSE status END,
              provider_event_id = NULL, error_code = NULL, error_message = NULL
        WHERE invitation_id IN (
          SELECT id FROM calendar_invitations WHERE event_id = ?
        )`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE integration_connections
          SET status = 'disconnected', last_operation_id = NULL,
              updated_at = unixepoch()
        WHERE event_id = ? AND provider <> 'airtable_repository'`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE integration_runs
          SET status = CASE WHEN status = 'succeeded' THEN status ELSE 'cancelled' END,
              idempotency_key = 'retained-run-' || id,
              summary_json = '{}', completed_at = COALESCE(completed_at, unixepoch())
        WHERE connection_id IN (
          SELECT id FROM integration_connections WHERE event_id = ?
        )
          AND NOT (
            status = 'running'
            AND json_extract(summary_json, '$.kind') = 'airtable_event_projection'
            AND json_extract(summary_json, '$.operation') =
                'participant.retention.anonymise'
          )`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE integration_run_items
          SET entity_id = 'retained-' || id, external_id = NULL,
              diff_json = '{}', error_code = NULL,
              error_message = NULL,
              status = CASE WHEN status IN ('pending','running','failed') THEN 'skipped' ELSE status END,
              updated_at = unixepoch()
        WHERE run_id IN (
          SELECT run.id FROM integration_runs run
          JOIN integration_connections connection ON connection.id = run.connection_id
          WHERE connection.event_id = ?
        )`,
      viewer.eventId,
    ),
    guarded(
      `DELETE FROM integration_entity_mappings
        WHERE connection_id IN (
          SELECT id FROM integration_connections WHERE event_id = ?
        )`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE operation_jobs
          SET idempotency_key = 'retained-operation-' || id,
              correlation_id = 'retained-correlation-' || id,
              status = CASE WHEN status = 'completed' THEN status ELSE 'cancelled' END,
              payload_json = ?, result_json = CASE WHEN result_json IS NULL THEN NULL ELSE ? END,
              last_error = NULL, claim_token = NULL, claim_expires_at = NULL,
              completed_at = COALESCE(completed_at, unixepoch()), updated_at = unixepoch()
        WHERE event_id = ?`,
      REDACTED_JSON,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE operation_items
          SET item_key = 'retained-item-' || id, entity_id = NULL,
              status = CASE WHEN status IN ('pending','running','failed') THEN 'skipped' ELSE status END,
              result_json = CASE WHEN result_json IS NULL THEN NULL ELSE ? END,
              error_code = NULL, error_message = NULL, updated_at = unixepoch()
        WHERE operation_id IN (
          SELECT id FROM operation_jobs WHERE event_id = ?
        )`,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE event_changes
          SET entity_id = NULL, correlation_id = NULL
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(`DELETE FROM saved_views WHERE event_id = ?`, viewer.eventId),
    guarded(
      `DELETE FROM idempotency_records WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE webhook_endpoints
          SET status = 'disabled', disabled_at = COALESCE(disabled_at, unixepoch()),
              updated_at = unixepoch()
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE webhook_deliveries
          SET idempotency_key = 'retained-webhook-delivery-' || id,
              entity_id = NULL, payload_json = ?,
              status = CASE WHEN status IN ('queued','failed') THEN 'cancelled' ELSE status END,
              next_attempt_at = NULL, updated_at = unixepoch()
        WHERE endpoint_id IN (
          SELECT id FROM webhook_endpoints WHERE event_id = ?
        )`,
      REDACTED_JSON,
      viewer.eventId,
    ),
    guarded(
      `UPDATE webhook_delivery_attempts
          SET response_headers_json = NULL, response_excerpt = NULL, error_message = NULL
        WHERE delivery_id IN (
          SELECT delivery.id FROM webhook_deliveries delivery
          JOIN webhook_endpoints endpoint ON endpoint.id = delivery.endpoint_id
          WHERE endpoint.event_id = ?
        )`,
      viewer.eventId,
    ),
    guarded(
      `UPDATE api_keys
          SET revoked_at = COALESCE(revoked_at, unixepoch())
        WHERE event_id = ?`,
      viewer.eventId,
    ),
    guarded(
      `DELETE FROM verification_tokens
        WHERE EXISTS (
          SELECT 1 FROM form_definitions form
           WHERE form.event_id = ?
             AND (
               substr(verification_tokens.identifier, 1,
                 length('application-session:' || form.id || ':')) =
                 'application-session:' || form.id || ':'
               OR substr(verification_tokens.identifier, 1,
                 length('anonymous-application-session:' || form.id || ':')) =
                 'anonymous-application-session:' || form.id || ':'
             )
        )`,
      viewer.eventId,
    ),
    env.DB.prepare(
      `UPDATE events
          SET participant_retention_completed_at = unixepoch(),
              updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
          AND participant_retention_completed_at IS NULL`,
    ).bind(viewer.eventId, viewer.organisationId, operationId),
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, correlation_id, metadata_json, created_at
       )
       SELECT ?, 'person', 'participant_ui', 1, ?, ?, ?, 'participant.retention.completed',
              'event', ?, ?, ?, unixepoch()
        WHERE ${guard}`,
    ).bind(
      completionId(viewer.eventId),
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      viewer.eventId,
      operationId,
      JSON.stringify(completionMetadata),
      viewer.eventId,
      viewer.organisationId,
      operationId,
    ),
  ];
  return statements;
}
