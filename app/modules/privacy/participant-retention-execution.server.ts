import { z } from "zod";
import { airtableCommandKey } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ParticipantRetentionAnalysis } from "./participant-retention-analysis.server";
import {
  MAX_PARTICIPANTS_PER_BATCH,
  ParticipantRetentionConfirmationError,
  ParticipantRetentionStateError,
  REDACTED_JSON,
  RETAINED_PERSON_PREFIX,
  completionId,
  eventClaimGuard,
  mapStatement,
  participantIdBindings,
  participantPredicateSql,
  requireOwner,
  type CompletionMetadata,
  type ParticipantCandidate,
} from "./participant-retention-foundation.server";

export abstract class ParticipantRetentionExecution extends ParticipantRetentionAnalysis {
  protected claimStatement(
    viewer: Viewer,
    operationId: string,
    confirmedEventName: string,
    requireNoParticipants = false,
  ) {
    return this.env.DB.prepare(
      `UPDATE events
          SET last_operation_id = ?, updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ?
          AND name = ?
          AND file_retention_hold_at IS NULL
          AND participant_retention_completed_at IS NULL
          AND unixepoch(datetime(ends_at, 'unixepoch',
                '+' || retention_months || ' months')) <= unixepoch()
          AND NOT EXISTS (
            SELECT 1 FROM audit_events WHERE id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM form_definitions
             WHERE event_id = events.id AND status = 'published'
          )
          AND NOT EXISTS (
            SELECT 1 FROM file_assets asset
             WHERE asset.event_id = events.id
               AND NOT EXISTS (
                 SELECT 1 FROM audit_events erased
                  WHERE erased.id = 'file-erasure-complete:' || asset.id
               )
          )
          AND NOT EXISTS (
            SELECT 1 FROM operation_jobs operation
             WHERE operation.event_id = events.id
               AND operation.status = 'running'
          )
          AND NOT EXISTS (
            SELECT 1 FROM communications
             WHERE event_id = events.id AND status = 'sending'
          )
          AND NOT EXISTS (
            SELECT 1 FROM calendar_sync_attempts attempt
             JOIN calendar_invitations invitation ON invitation.id = attempt.invitation_id
             WHERE invitation.event_id = events.id AND attempt.status = 'running'
          )
          AND NOT EXISTS (
            SELECT 1 FROM calendar_invitations invitation
             WHERE invitation.event_id = events.id
               AND invitation.method <> 'CANCEL'
               AND invitation.status IN ('pending','queued','sent','confirmed','failed')
          )
          AND NOT EXISTS (
            SELECT 1 FROM integration_runs run
             JOIN integration_connections connection ON connection.id = run.connection_id
             WHERE connection.event_id = events.id AND run.status = 'running'
               AND NOT (
                 json_extract(run.summary_json, '$.kind') = 'airtable_event_projection'
                 AND json_extract(run.summary_json, '$.operation') =
                     'participant.retention.anonymise'
               )
          )
          AND NOT EXISTS (
            SELECT 1 FROM webhook_deliveries delivery
             JOIN webhook_endpoints endpoint ON endpoint.id = delivery.endpoint_id
             WHERE endpoint.event_id = events.id AND delivery.status = 'delivering'
          )
          ${
            requireNoParticipants
              ? `AND NOT EXISTS (
                   SELECT 1 FROM people person
                    WHERE ${participantPredicateSql}
                      AND person.id NOT LIKE '${RETAINED_PERSON_PREFIX}%'
                 )`
              : ""
          }`,
    ).bind(
      operationId,
      viewer.eventId,
      viewer.organisationId,
      confirmedEventName,
      completionId(viewer.eventId),
      ...(requireNoParticipants ? participantIdBindings(viewer.eventId) : []),
    );
  }

  protected async remapBatch(
    viewer: Viewer,
    candidates: ParticipantCandidate[],
    confirmedEventName: string,
  ) {
    const operationId = crypto.randomUUID();
    const mappings = await this.buildMappings(viewer, operationId, candidates);
    if (mappings.length === 0) return;

    const existing = await this.env.DB.prepare(
      `SELECT id, email FROM people WHERE id IN (${mappings.map(() => "?").join(",")})`,
    )
      .bind(...mappings.map((mapping) => mapping.pseudonymId))
      .all<{ id: string; email: string }>();
    for (const row of existing.results) {
      const expected = mappings.find(
        (mapping) => mapping.pseudonymId === row.id,
      );
      if (!expected || row.email !== expected.pseudonymEmail) {
        throw new ParticipantRetentionStateError(
          "A retained participant identifier collides with an existing identity.",
        );
      }
    }

    const statements = [
      this.claimStatement(viewer, operationId, confirmedEventName),
      ...mappings.map((mapping) =>
        this.env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, image_url, biography,
             pronunciation, organisation_name, job_title, profile_status,
             created_at, updated_at
           )
           SELECT ?, ?, 'Anonymised participant', 0, NULL, NULL, NULL, NULL,
                  NULL, 'archived', unixepoch(), unixepoch()
            WHERE ${eventClaimGuard()}
              AND EXISTS (
                SELECT 1 FROM people person
                 WHERE person.id = ? AND ${participantPredicateSql}
              )`,
        ).bind(
          mapping.pseudonymId,
          mapping.pseudonymEmail,
          viewer.eventId,
          viewer.organisationId,
          operationId,
          mapping.id,
          ...participantIdBindings(viewer.eventId),
        ),
      ),
      mapStatement(
        this.env,
        mappings,
        "memberships",
        "person_id",
        "event_id = ?",
        "role IN ('submitter','speaker')",
      ),
      mapStatement(this.env, mappings, "submissions", "submitter_person_id"),
      mapStatement(
        this.env,
        mappings,
        "submission_revisions",
        "saved_by_person_id",
      ),
      mapStatement(this.env, mappings, "submission_speakers", "person_id"),
      mapStatement(this.env, mappings, "session_speakers", "person_id"),
      mapStatement(this.env, mappings, "public_itineraries", "person_id"),
      mapStatement(
        this.env,
        mappings,
        "task_instances",
        "owner_person_id",
        "event_id = ?",
        "target_type = 'speaker'",
      ),
      mapStatement(
        this.env,
        mappings,
        "task_instances",
        "completed_by_person_id",
        "event_id = ?",
        "target_type = 'speaker'",
      ),
      mapStatement(
        this.env,
        mappings,
        "task_comments",
        "author_person_id",
        "event_id = ?",
        "task_id IN (SELECT id FROM task_instances WHERE event_id = task_comments.event_id AND target_type = 'speaker')",
      ),
      mapStatement(
        this.env,
        mappings,
        "file_assets",
        "owner_person_id",
        "event_id = ?",
        "target_type IN ('person','submission','session','task')",
      ),
      mapStatement(
        this.env,
        mappings,
        "file_versions",
        "created_by_person_id",
        "event_id = ?",
        "asset_id IN (SELECT id FROM file_assets WHERE event_id = file_versions.event_id AND target_type IN ('person','submission','session','task'))",
      ),
      mapStatement(
        this.env,
        mappings,
        "task_evidence",
        "submitted_by_person_id",
        "event_id = ?",
        "task_id IN (SELECT id FROM task_instances WHERE event_id = task_evidence.event_id AND target_type = 'speaker')",
      ),
      mapStatement(
        this.env,
        mappings,
        "resource_acknowledgements",
        "person_id",
      ),
      mapStatement(this.env, mappings, "communication_deliveries", "person_id"),
      mapStatement(
        this.env,
        mappings,
        "communication_unsubscribes",
        "person_id",
      ),
      mapStatement(
        this.env,
        mappings,
        "calendar_connections",
        "person_id",
        "event_id = ?",
      ),
      mapStatement(this.env, mappings, "calendar_invitations", "person_id"),
      mapStatement(
        this.env,
        mappings,
        "task_instances",
        "target_id",
        "event_id = ?",
        "target_type = 'speaker'",
      ),
      mapStatement(
        this.env,
        mappings,
        "file_assets",
        "target_id",
        "event_id = ?",
        "target_type = 'person'",
      ),
      mapStatement(
        this.env,
        mappings,
        "resource_audiences",
        "target_id",
        "event_id = ?",
        "target_type = 'person'",
      ),
      this.env.DB.prepare(
        `UPDATE memberships
            SET revoked_at = COALESCE(revoked_at, unixepoch())
          WHERE event_id = ?
            AND person_id IN (${mappings.map(() => "?").join(",")})
            AND ${eventClaimGuard()}`,
      ).bind(
        viewer.eventId,
        ...mappings.map((mapping) => mapping.pseudonymId),
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      ...mappings
        .filter((mapping) => !mapping.shared)
        .flatMap((mapping) => [
          this.env.DB.prepare(
            `UPDATE people
                SET email = ?, display_name = 'Anonymised participant',
                    email_verified = 0, image_url = NULL, biography = NULL,
                    pronunciation = NULL, organisation_name = NULL,
                    job_title = NULL, profile_status = 'archived',
                    last_operation_id = ?, updated_at = unixepoch()
              WHERE id = ? AND ${eventClaimGuard()}
                AND EXISTS (SELECT 1 FROM people retained WHERE retained.id = ?)
                AND NOT EXISTS (
                  SELECT 1 FROM memberships other WHERE other.person_id = people.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM submissions other
                   WHERE other.submitter_person_id = people.id AND other.event_id <> ?
                )
                AND NOT EXISTS (
                  SELECT 1 FROM submission_speakers other
                   WHERE other.person_id = people.id AND other.event_id <> ?
                )
                AND NOT EXISTS (
                  SELECT 1 FROM session_speakers other
                   WHERE other.person_id = people.id AND other.event_id <> ?
                )
                AND NOT EXISTS (
                  SELECT 1 FROM audit_events other
                   WHERE other.actor_person_id = people.id
                     AND (other.event_id IS NULL OR other.event_id <> ?)
                )`,
          ).bind(
            mapping.retiredEmail,
            `participant-retention:${viewer.eventId}`,
            mapping.id,
            viewer.eventId,
            viewer.organisationId,
            operationId,
            mapping.pseudonymId,
            viewer.eventId,
            viewer.eventId,
            viewer.eventId,
            viewer.eventId,
          ),
          this.env.DB.prepare(
            `DELETE FROM auth_sessions
              WHERE person_id = ?
                AND EXISTS (SELECT 1 FROM people WHERE id = ? AND email = ?)
                AND ${eventClaimGuard()}`,
          ).bind(
            mapping.id,
            mapping.id,
            mapping.retiredEmail,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
          this.env.DB.prepare(
            `DELETE FROM auth_accounts
              WHERE person_id = ?
                AND EXISTS (SELECT 1 FROM people WHERE id = ? AND email = ?)
                AND ${eventClaimGuard()}`,
          ).bind(
            mapping.id,
            mapping.id,
            mapping.retiredEmail,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
          this.env.DB.prepare(
            `DELETE FROM verification_tokens
              WHERE identifier = ? COLLATE NOCASE
                AND EXISTS (SELECT 1 FROM people WHERE id = ? AND email = ?)
                AND ${eventClaimGuard()}`,
          ).bind(
            mapping.email,
            mapping.id,
            mapping.retiredEmail,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
          this.env.DB.prepare(
            `UPDATE calendar_connections
                SET status = 'disconnected', account_reference = 'retained-' || id,
                    encrypted_credentials = NULL, scopes_json = '[]',
                    expires_at = NULL, last_synced_at = NULL,
                    updated_at = unixepoch()
              WHERE person_id = ? AND organisation_id = ?
                AND EXISTS (SELECT 1 FROM people WHERE id = ? AND email = ?)
                AND ${eventClaimGuard()}`,
          ).bind(
            mapping.id,
            viewer.organisationId,
            mapping.id,
            mapping.retiredEmail,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
        ]),
      ...mappings.map((mapping) =>
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, ?, 'participant.retention.subject_anonymised',
                  'person', ?, ?, unixepoch()
            WHERE ${eventClaimGuard()}
              AND EXISTS (SELECT 1 FROM people WHERE id = ?)`,
        ).bind(
          mapping.subjectAuditId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          mapping.pseudonymId,
          JSON.stringify({
            version: 1,
            sharedIdentity: mapping.shared,
            immutableAuditRows: mapping.immutableAuditRows,
          }),
          viewer.eventId,
          viewer.organisationId,
          operationId,
          mapping.pseudonymId,
        ),
      ),
    ];
    const results = await this.env.DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const latest = await this.preview(viewer);
      if (latest.completed) return;
      throw new ParticipantRetentionStateError(
        latest.blockers[0] ??
          "Participant retention changed concurrently. Review the latest preview before retrying.",
      );
    }
  }

  protected async finalise(
    viewer: Viewer,
    preview: Awaited<ReturnType<ParticipantRetentionAnalysis["preview"]>>,
  ) {
    const operationId = crypto.randomUUID();
    const completionMetadata: CompletionMetadata = {
      version: 1,
      scope: "local_event_data",
      repositoryProvider: preview.repositoryProvider,
      externalProviderErasureRequired: preview.externalProviderErasureRequired,
      immutableAuditRecords: preview.immutableAuditRecords,
      sharedIdentityAuditLinks: preview.sharedIdentityAuditLinks,
      retainedProgrammeRecords: preview.retainedProgrammeRecords,
      unscopedStoresNotAutomaticallyRedacted:
        preview.unscopedStoresNotAutomaticallyRedacted,
    };
    const guard = eventClaimGuard();
    const guarded = (sql: string, ...bindings: unknown[]) =>
      this.env.DB.prepare(`${sql} AND ${guard}`).bind(
        ...bindings,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      );
    const statements = [
      this.claimStatement(viewer, operationId, preview.name, true),
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
                last_operation_id = NULL, updated_at = unixepoch()
          WHERE event_id = ?`,
        REDACTED_JSON,
        viewer.eventId,
      ),
      guarded(
        `UPDATE review_revisions
            SET scores_json = ?, content_json = ?, idempotency_key = NULL
          WHERE event_id = ?`,
        REDACTED_JSON,
        REDACTED_JSON,
        viewer.eventId,
      ),
      guarded(
        `UPDATE review_moderations SET notes = NULL WHERE event_id = ?`,
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
      this.env.DB.prepare(
        `UPDATE events
            SET participant_retention_completed_at = unixepoch(),
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            AND participant_retention_completed_at IS NULL`,
      ).bind(viewer.eventId, viewer.organisationId, operationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'participant.retention.completed',
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
    const results = await this.env.DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const latest = await this.preview(viewer);
      if (latest.completed) return { duplicate: true };
      throw new ParticipantRetentionStateError(
        latest.blockers[0] ??
          "Participant retention changed concurrently. Review the latest preview before retrying.",
      );
    }
    const marker = results.at(-2);
    const completion = results.at(-1);
    if (
      (marker?.meta.changes ?? 0) !== 1 ||
      (completion?.meta.changes ?? 0) !== 1
    ) {
      throw new ParticipantRetentionStateError(
        "Participant records changed during final anonymisation. Review and retry.",
      );
    }
    return { duplicate: false };
  }

  async anonymiseExpiredParticipants(
    viewer: Viewer,
    input: { confirmation: string; acknowledged: boolean; limit?: number },
  ) {
    requireOwner(viewer);
    const preview = await this.preview(viewer);
    if (!input.acknowledged || input.confirmation !== preview.name)
      throw new ParticipantRetentionConfirmationError();
    if (preview.integrityViolations.length > 0) {
      throw new ParticipantRetentionStateError(
        `Participant-retention integrity check failed: ${preview.integrityViolations[0]}`,
      );
    }
    if (preview.completed) {
      return { duplicate: true, complete: true, state: preview };
    }
    if (preview.blockers.length > 0)
      throw new ParticipantRetentionStateError(preview.blockers[0]!);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(MAX_PARTICIPANTS_PER_BATCH)
      .parse(input.limit ?? MAX_PARTICIPANTS_PER_BATCH);
    const operation = "participant.retention.anonymise";
    const idempotencyKey = await airtableCommandKey(operation, viewer, {
      confirmation: input.confirmation,
      acknowledged: input.acknowledged,
      limit,
      pendingParticipants: preview.pendingParticipants,
      anonymisedParticipants: preview.anonymisedParticipants,
      completed: preview.completed,
    });
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation },
      async () => {
        this.projectionDepth += 1;
        try {
          return await this.anonymiseExpiredParticipantsD1(
            viewer,
            preview,
            limit,
          );
        } finally {
          this.projectionDepth -= 1;
        }
      },
    );
  }

  protected async anonymiseExpiredParticipantsD1(
    viewer: Viewer,
    preview: Awaited<ReturnType<ParticipantRetentionAnalysis["preview"]>>,
    limit: number,
  ) {
    const batch = await this.candidates(viewer, limit);
    if (batch.length > 0) await this.remapBatch(viewer, batch, preview.name);
    const afterBatch = await this.preview(viewer);
    if (afterBatch.completed) {
      return { duplicate: true, complete: true, state: afterBatch };
    }
    if (afterBatch.pendingParticipants > 0) {
      return { duplicate: false, complete: false, state: afterBatch };
    }
    if (afterBatch.blockers.length > 0)
      throw new ParticipantRetentionStateError(afterBatch.blockers[0]!);
    const finalised = await this.finalise(viewer, afterBatch);
    return {
      duplicate: finalised.duplicate,
      complete: true,
      state: await this.preview(viewer),
    };
  }
}
