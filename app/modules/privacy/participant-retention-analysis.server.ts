import type { Viewer } from "~/platform/auth/authorize.server";
import {
  candidateBindings,
  candidateSql,
  completionId,
  count,
  type InternalMapping,
  type ParticipantCandidate,
  ParticipantRetentionAccessError,
  ParticipantRetentionFoundation,
  ParticipantRetentionStateError,
  parseCompletionMetadata,
  RETAINED_PERSON_PREFIX,
  requireOwner,
  sha256Hex,
} from "./participant-retention-foundation.server";

export abstract class ParticipantRetentionAnalysis extends ParticipantRetentionFoundation {
  protected async candidates(viewer: Viewer, limit?: number) {
    const result = await this.env.DB.prepare(
      candidateSql(limit === undefined ? "" : "LIMIT ?"),
    )
      .bind(
        ...candidateBindings(viewer),
        ...(limit === undefined ? [] : [limit]),
      )
      .all<ParticipantCandidate>();
    return result.results;
  }

  protected async candidateCount(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM (${candidateSql("")}) candidates`,
    )
      .bind(...candidateBindings(viewer))
      .first<{ total: number }>();
    return count(row?.total);
  }

  protected async completionIntegrity(viewer: Viewer) {
    const checks = [
      {
        area: "participant identity or credential",
        sql: `WITH locked AS (
          SELECT event_id FROM participant_retention_locked_events
           WHERE event_id = ? AND organisation_id = ?
        )
        SELECT
          (SELECT COUNT(*) FROM participant_retention_locked_identities link
            JOIN people person ON person.id = link.person_id
           WHERE link.event_id IN locked AND link.identity_kind = 'pseudonym'
             AND (person.id NOT LIKE 'retained-participant-%'
               OR person.email NOT LIKE '%@privacy.invalid'
               OR person.display_name <> 'Anonymised participant'
               OR person.email_verified <> 0
               OR person.image_url IS NOT NULL OR person.biography IS NOT NULL
               OR person.pronunciation IS NOT NULL
               OR person.organisation_name IS NOT NULL OR person.job_title IS NOT NULL
               OR person.linkedin_url IS NOT NULL OR person.x_handle IS NOT NULL
               OR person.profile_status <> 'archived'))
          + (SELECT COUNT(*) FROM participant_retention_locked_identities link
            JOIN people person ON person.id = link.person_id
           WHERE link.event_id IN locked AND link.identity_kind = 'retired'
             AND (person.email NOT LIKE 'retired-account-%@privacy.invalid'
               OR person.display_name <> 'Anonymised participant'
               OR person.email_verified <> 0
               OR person.image_url IS NOT NULL OR person.biography IS NOT NULL
               OR person.pronunciation IS NOT NULL
               OR person.organisation_name IS NOT NULL OR person.job_title IS NOT NULL
               OR person.linkedin_url IS NOT NULL OR person.x_handle IS NOT NULL
               OR person.profile_status <> 'archived'
               OR EXISTS (SELECT 1 FROM auth_sessions auth
                            WHERE auth.person_id = person.id)
               OR EXISTS (SELECT 1 FROM auth_accounts auth
                            WHERE auth.person_id = person.id)
               OR EXISTS (SELECT 1 FROM verification_tokens token
                            WHERE token.identifier = person.email COLLATE NOCASE)))
          + (SELECT COUNT(*) FROM event_participant_profiles profile
              WHERE profile.event_id IN locked)
          + (SELECT COUNT(*) FROM speaker_profile_revisions revision
              WHERE revision.event_id IN locked)
          AS total`,
      },
      {
        area: "submission, speaker, or review",
        sql: `WITH locked AS (
          SELECT event_id FROM participant_retention_locked_events
           WHERE event_id = ? AND organisation_id = ?
        )
        SELECT
          (SELECT COUNT(*) FROM submissions record WHERE record.event_id IN locked
            AND (record.submitter_email IS NOT NULL
              OR record.public_reference <> 'retained-' || record.id
              OR record.title <> 'Retained submission'
              OR COALESCE(json_extract(record.answers_json, '$.redacted'), 0) <> 1
              OR (record.submitted_snapshot_json IS NOT NULL
                AND COALESCE(json_extract(record.submitted_snapshot_json, '$.redacted'), 0) <> 1)))
          + (SELECT COUNT(*) FROM submission_revisions record WHERE record.event_id IN locked
            AND (COALESCE(json_extract(record.answers_json, '$.redacted'), 0) <> 1
              OR COALESCE(json_extract(record.speaker_snapshot_json, '$.redacted'), 0) <> 1))
          + (SELECT COUNT(*) FROM submission_email_verifications record
              WHERE record.event_id IN locked)
          + (SELECT COUNT(*) FROM submission_speakers record WHERE record.event_id IN locked
            AND (record.email NOT LIKE '%@privacy.invalid'
              OR record.display_name <> 'Anonymised speaker'
              OR record.role_label IS NOT NULL OR record.invitation_status <> 'revoked'
              OR record.claim_token_hash IS NOT NULL))
          + (SELECT COUNT(*) FROM event_speaker_workflows record
              WHERE record.event_id IN locked
                AND NOT EXISTS (
                  SELECT 1 FROM participant_retention_locked_identities identity_link
                   WHERE identity_link.event_id = record.event_id
                     AND identity_link.person_id = record.person_id
                     AND identity_link.identity_kind = 'pseudonym'
                ))
          + (SELECT COUNT(*) FROM evaluator_assignments record
              WHERE record.event_id IN locked
                AND record.session_snapshot_json IS NOT NULL
                AND COALESCE(json_extract(record.session_snapshot_json, '$.redacted'), 0) <> 1)
          + (SELECT COUNT(*) FROM reviews record WHERE record.event_id IN locked
            AND (COALESCE(json_extract(record.scores_json, '$.redacted'), 0) <> 1
              OR record.submitter_feedback IS NOT NULL OR record.private_notes IS NOT NULL))
          + (SELECT COUNT(*) FROM review_revisions record WHERE record.event_id IN locked
            AND (COALESCE(json_extract(record.scores_json, '$.redacted'), 0) <> 1
              OR COALESCE(json_extract(record.content_json, '$.redacted'), 0) <> 1))
          + (SELECT COUNT(*) FROM evaluation_discussion_messages record
              WHERE record.event_id IN locked AND record.body IS NOT NULL)
          AS total`,
      },
      {
        area: "participant workspace or private-file",
        sql: `WITH locked AS (
          SELECT event_id FROM participant_retention_locked_events
           WHERE event_id = ? AND organisation_id = ?
        )
        SELECT
          (SELECT COUNT(*) FROM sessions record WHERE record.event_id IN locked
            AND record.source_submission_id IS NOT NULL AND record.description IS NOT NULL)
          + (SELECT COUNT(*) FROM schedule_session_contents record
              JOIN sessions session
                ON session.id = record.session_id
               AND session.event_id = record.event_id
             WHERE record.event_id IN locked
               AND session.source_submission_id IS NOT NULL
               AND record.description IS NOT NULL)
          + (SELECT COUNT(*) FROM session_content_revisions record
              JOIN sessions session
                ON session.id = record.session_id
               AND session.event_id = record.event_id
             WHERE record.event_id IN locked
               AND session.source_submission_id IS NOT NULL
               AND record.description IS NOT NULL)
          + (SELECT COUNT(*) FROM public_itineraries record WHERE record.event_id IN locked)
          + (SELECT COUNT(*) FROM task_instances record WHERE record.event_id IN locked
            AND record.target_type = 'speaker'
            AND (record.description IS NOT NULL
              OR record.title <> 'Retained participant task'
              OR (record.evidence_json IS NOT NULL
                AND COALESCE(json_extract(record.evidence_json, '$.redacted'), 0) <> 1)
              OR (record.waiver_json IS NOT NULL
                AND COALESCE(json_extract(record.waiver_json, '$.redacted'), 0) <> 1)))
          + (SELECT COUNT(*) FROM task_comments record WHERE record.event_id IN locked
            AND record.task_id IN (
              SELECT id FROM task_instances
               WHERE event_id = record.event_id AND target_type = 'speaker'
            )
            AND record.body <> '[redacted after event retention]')
          + (SELECT COUNT(*) FROM task_evidence record WHERE record.event_id IN locked
            AND record.task_id IN (
              SELECT id FROM task_instances
               WHERE event_id = record.event_id AND target_type = 'speaker'
            )
            AND COALESCE(json_extract(record.evidence_json, '$.redacted'), 0) <> 1)
          + (SELECT COUNT(*) FROM resource_acknowledgements record
              WHERE record.event_id IN locked AND record.user_agent IS NOT NULL)
          + (SELECT COUNT(*) FROM file_assets record WHERE record.event_id IN locked
            AND (record.status <> 'deleted' OR record.current_version_id IS NOT NULL))
          + (SELECT COUNT(*) FROM file_versions record WHERE record.event_id IN locked
            AND (record.object_key <> 'retained/' || record.id
              OR record.multipart_upload_id IS NOT NULL
              OR record.original_filename <> 'retained-file'
              OR record.detected_content_type IS NOT NULL
              OR record.checksum_sha256 IS NOT NULL OR record.object_etag IS NOT NULL
              OR record.scan_provider IS NOT NULL OR record.scan_result_json IS NOT NULL
              OR record.scan_error IS NOT NULL OR record.released_at IS NOT NULL
              OR record.deleted_at IS NULL))
          + (SELECT COUNT(*) FROM file_multipart_uploads record WHERE record.event_id IN locked
            AND (record.upload_id IS NOT NULL
              OR record.idempotency_key <> 'retained-upload-' || record.version_id
              OR record.manifest_json IS NOT NULL OR record.manifest_hash IS NOT NULL
              OR record.last_error IS NOT NULL))
          AS total`,
      },
      {
        area: "communication or calendar recipient",
        sql: `WITH locked AS (
          SELECT event_id FROM participant_retention_locked_events
           WHERE event_id = ? AND organisation_id = ?
        )
        SELECT
          (SELECT COUNT(*) FROM communications record WHERE record.event_id IN locked
            AND (COALESCE(json_extract(record.audience_json, '$.redacted'), 0) <> 1
              OR COALESCE(json_extract(record.content_snapshot_json, '$.redacted'), 0) <> 1))
          + (SELECT COUNT(*) FROM communication_deliveries record WHERE record.event_id IN locked
            AND (record.recipient_address NOT LIKE '%@privacy.invalid'
              OR record.recipient_name IS NOT NULL OR record.source_id IS NOT NULL
              OR COALESCE(json_extract(record.source_values_json, '$.redacted'), 0) <> 1
              OR record.provider IS NOT NULL OR record.provider_message_id IS NOT NULL
              OR record.failure_message IS NOT NULL))
          + (SELECT COUNT(*) FROM communication_delivery_events delivery_event
            JOIN communication_deliveries delivery ON delivery.id = delivery_event.delivery_id
           WHERE delivery.event_id IN locked
             AND (delivery_event.provider_event_id IS NOT NULL
               OR COALESCE(json_extract(delivery_event.payload_json, '$.redacted'), 0) <> 1))
          + (SELECT COUNT(*) FROM communication_unsubscribes record WHERE record.event_id IN locked
            AND (record.address NOT LIKE '%@privacy.invalid' OR record.reason IS NOT NULL))
          + (SELECT COUNT(*) FROM calendar_connections record WHERE record.event_id IN locked
            AND (record.account_reference <> 'retained-' || record.id
              OR record.encrypted_credentials IS NOT NULL))
          + (SELECT COUNT(*) FROM calendar_invitations record WHERE record.event_id IN locked
            AND (record.connection_id IS NOT NULL OR record.delivery_id IS NOT NULL
              OR record.provider_event_id IS NOT NULL OR record.last_payload_hash IS NOT NULL
              OR record.current_attempt_id IS NOT NULL OR record.status <> 'cancelled'))
          + (SELECT COUNT(*) FROM calendar_sync_attempts attempt
            JOIN calendar_invitations invitation ON invitation.id = attempt.invitation_id
           WHERE invitation.event_id IN locked
             AND (attempt.provider_event_id IS NOT NULL OR attempt.error_message IS NOT NULL))
          AS total`,
      },
      {
        area: "cached provider or operation payload",
        sql: `WITH locked AS (
          SELECT event_id, completed_at FROM participant_retention_locked_events
           WHERE event_id = ? AND organisation_id = ?
        )
        SELECT
          (SELECT COUNT(*) FROM integration_run_items item
            JOIN integration_runs run ON run.id = item.run_id
            JOIN integration_connections connection ON connection.id = run.connection_id
            JOIN locked ON locked.event_id = connection.event_id
           WHERE run.created_at < locked.completed_at
             AND (item.external_id IS NOT NULL OR json(item.diff_json) <> json('{}')
               OR item.error_message IS NOT NULL))
          + (SELECT COUNT(*) FROM integration_entity_mappings mapping
            JOIN integration_connections connection ON connection.id = mapping.connection_id
            JOIN locked ON locked.event_id = connection.event_id
           WHERE mapping.created_at < locked.completed_at)
          + (SELECT COUNT(*) FROM operation_jobs record
            JOIN locked ON locked.event_id = record.event_id
           WHERE record.created_at < locked.completed_at
             AND (COALESCE(json_extract(record.payload_json, '$.redacted'), 0) <> 1
              OR (record.result_json IS NOT NULL
                AND COALESCE(json_extract(record.result_json, '$.redacted'), 0) <> 1)
              OR record.last_error IS NOT NULL OR record.claim_token IS NOT NULL))
          + (SELECT COUNT(*) FROM operation_items item
            JOIN operation_jobs operation ON operation.id = item.operation_id
            JOIN locked ON locked.event_id = operation.event_id
           WHERE operation.created_at < locked.completed_at
             AND ((item.result_json IS NOT NULL
                 AND COALESCE(json_extract(item.result_json, '$.redacted'), 0) <> 1)
               OR item.error_message IS NOT NULL))
          + (SELECT COUNT(*) FROM event_changes record
            JOIN locked ON locked.event_id = record.event_id
           WHERE record.created_at < locked.completed_at
             AND (record.entity_id IS NOT NULL OR record.correlation_id IS NOT NULL))
          + (SELECT COUNT(*) FROM saved_views record
            JOIN locked ON locked.event_id = record.event_id
           WHERE record.created_at < locked.completed_at)
          + (SELECT COUNT(*) FROM idempotency_records record
            JOIN locked ON locked.event_id = record.event_id
           WHERE record.created_at < locked.completed_at)
          + (SELECT COUNT(*) FROM webhook_deliveries delivery
            JOIN webhook_endpoints endpoint ON endpoint.id = delivery.endpoint_id
            JOIN locked ON locked.event_id = endpoint.event_id
           WHERE delivery.created_at < locked.completed_at
             AND (delivery.entity_id IS NOT NULL
               OR COALESCE(json_extract(delivery.payload_json, '$.redacted'), 0) <> 1))
          AS total`,
      },
      {
        area: "application-session token",
        sql: `WITH locked AS (
          SELECT event_id FROM participant_retention_locked_events
           WHERE event_id = ? AND organisation_id = ?
        )
        SELECT COUNT(*) AS total FROM verification_tokens token
         WHERE EXISTS (
           SELECT 1 FROM form_definitions form WHERE form.event_id IN locked
             AND (
               substr(token.identifier, 1,
                 length('application-session:' || form.id || ':')) =
                 'application-session:' || form.id || ':'
               OR substr(token.identifier, 1,
                 length('anonymous-application-session:' || form.id || ':')) =
                 'anonymous-application-session:' || form.id || ':'
             )
         )`,
      },
    ] as const;
    const results = await this.env.DB.batch(
      checks.map((check) =>
        this.env.DB.prepare(check.sql).bind(
          viewer.eventId,
          viewer.organisationId,
        ),
      ),
    );
    return checks.flatMap((check, index) => {
      const row = results[index]?.results[0] as { total?: number } | undefined;
      const total = count(row?.total);
      return total === 0
        ? []
        : [
            `${total} ${check.area} record${total === 1 ? " does" : "s do"} not match the completed retention state.`,
          ];
    });
  }

  protected async classifyCandidate(
    viewer: Viewer,
    candidate: ParticipantCandidate,
  ) {
    const state = await this.env.DB.prepare(
      `SELECT
         (
           EXISTS (
             SELECT 1 FROM memberships
              WHERE person_id = ?
                AND (event_id IS NULL OR event_id <> ?
                     OR role NOT IN ('submitter','speaker'))
           )
           OR EXISTS (
             SELECT 1 FROM submissions
              WHERE submitter_person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM submission_speakers
              WHERE person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM session_speakers
              WHERE person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM task_instances
              WHERE owner_person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM task_evidence evidence
             JOIN task_instances task
               ON task.id = evidence.task_id AND task.event_id = evidence.event_id
              WHERE evidence.submitted_by_person_id = ?
                AND evidence.event_id <> ? AND task.target_type = 'speaker'
           )
           OR EXISTS (
             SELECT 1 FROM resource_acknowledgements
              WHERE person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM resource_audiences
              WHERE target_type = 'person' AND target_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM public_itineraries
              WHERE person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM calendar_invitations
              WHERE person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM communication_deliveries
              WHERE person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM communication_unsubscribes
              WHERE person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM file_assets
              WHERE owner_person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM event_participant_profiles
              WHERE person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM speaker_profile_revisions
              WHERE person_id = ? AND event_id <> ?
           )
           OR EXISTS (
             SELECT 1 FROM audit_events
              WHERE actor_person_id = ? AND (event_id IS NULL OR event_id <> ?)
           )
           OR EXISTS (
             SELECT 1 FROM organisation_contacts
              WHERE person_id = ? AND status = 'active'
           )
           OR EXISTS (
             SELECT 1 FROM calendar_connections
              WHERE person_id = ?
                AND (event_id IS NULL OR event_id <> ? OR organisation_id <> ?)
           )
         ) AS shared,
         (
           SELECT COUNT(*) FROM audit_events
            WHERE event_id = ? AND actor_person_id = ?
         ) AS immutableAuditRows`,
    )
      .bind(
        ...Array.from({ length: 16 }, () => [
          candidate.id,
          viewer.eventId,
        ]).flat(),
        candidate.id,
        candidate.id,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        candidate.id,
      )
      .first<{ shared: number; immutableAuditRows: number }>();
    if (!state) {
      throw new ParticipantRetentionStateError(
        "Participant retention could not classify an eligible identity.",
      );
    }
    return {
      shared: state.shared === 1,
      immutableAuditRows: count(state.immutableAuditRows),
    };
  }

  async preview(viewer: Viewer) {
    requireOwner(viewer);
    const [state, pendingParticipants, subjectSummary] = await Promise.all([
      this.env.DB.prepare(
        `SELECT event.name, event.ends_at AS endsAt,
                event.retention_months AS retentionMonths,
                event.file_retention_hold_at AS holdAt,
                event.repository_provider AS repositoryProvider,
                unixepoch(datetime(event.ends_at, 'unixepoch',
                  '+' || event.retention_months || ' months')) AS eligibleAt,
                event.participant_retention_completed_at AS completedAt,
                completion.metadata_json AS completionMetadata,
                (SELECT COUNT(*) FROM form_definitions form
                  WHERE form.event_id = event.id AND form.status = 'published') AS publishedForms,
                (SELECT COUNT(*) FROM file_assets asset
                  WHERE asset.event_id = event.id
                    AND NOT EXISTS (
                      SELECT 1 FROM audit_events erased
                       WHERE erased.id = 'file-erasure-complete:' || asset.id
                    )) AS pendingFiles,
                (SELECT COUNT(*) FROM operation_jobs operation
                  WHERE operation.event_id = event.id
                    AND operation.status = 'running') AS activeOperations,
                (SELECT COUNT(*) FROM communications communication
                  WHERE communication.event_id = event.id
                    AND communication.status = 'sending') AS activeCommunications,
                (SELECT COUNT(*) FROM calendar_sync_attempts attempt
                  JOIN calendar_invitations invitation ON invitation.id = attempt.invitation_id
                  WHERE invitation.event_id = event.id AND attempt.status = 'running') AS activeCalendarAttempts,
                (SELECT COUNT(*) FROM calendar_invitations invitation
                  WHERE invitation.event_id = event.id
                    AND invitation.method <> 'CANCEL'
                    AND invitation.status IN ('pending','queued','sent','confirmed','failed')) AS activeCalendarInvitations,
                (SELECT COUNT(*) FROM integration_runs run
                  JOIN integration_connections connection ON connection.id = run.connection_id
                  WHERE connection.event_id = event.id AND run.status = 'running'
                    AND NOT (
                      json_extract(run.summary_json, '$.kind') = 'airtable_event_projection'
                      AND json_extract(run.summary_json, '$.operation') =
                          'participant.retention.anonymise'
                    )) AS activeIntegrationRuns,
                (SELECT COUNT(*) FROM webhook_deliveries delivery
                  JOIN webhook_endpoints endpoint ON endpoint.id = delivery.endpoint_id
                  WHERE endpoint.event_id = event.id AND delivery.status = 'delivering') AS activeWebhookDeliveries,
                (SELECT COUNT(*) FROM audit_events audit
                  WHERE audit.event_id = event.id
                    AND audit.id <> ?
                    AND audit.action <> 'participant.retention.subject_anonymised')
                  AS immutableAuditRecords,
                (SELECT COUNT(*) FROM sessions session
                  WHERE session.event_id = event.id) AS retainedProgrammeRecords,
                (SELECT COUNT(*) FROM integration_connections connection
                  WHERE connection.event_id = event.id) AS externalIntegrationConnections,
                (SELECT COUNT(*) FROM communication_deliveries delivery
                  WHERE delivery.event_id = event.id AND delivery.provider IS NOT NULL) AS externalDeliveryRecords
           FROM events event
           LEFT JOIN audit_events completion ON completion.id = ?
          WHERE event.id = ? AND event.organisation_id = ?`,
      )
        .bind(
          completionId(viewer.eventId),
          completionId(viewer.eventId),
          viewer.eventId,
          viewer.organisationId,
        )
        .first<{
          name: string;
          endsAt: number;
          retentionMonths: number;
          holdAt: number | null;
          repositoryProvider: string;
          eligibleAt: number;
          completedAt: number | null;
          completionMetadata: string | null;
          publishedForms: number;
          pendingFiles: number;
          activeOperations: number;
          activeCommunications: number;
          activeCalendarAttempts: number;
          activeCalendarInvitations: number;
          activeIntegrationRuns: number;
          activeWebhookDeliveries: number;
          immutableAuditRecords: number;
          retainedProgrammeRecords: number;
          externalIntegrationConnections: number;
          externalDeliveryRecords: number;
        }>(),
      this.candidateCount(viewer),
      this.env.DB.prepare(
        `SELECT COUNT(*) AS anonymisedParticipants,
                COALESCE(SUM(CASE WHEN json_extract(metadata_json, '$.sharedIdentity') = 1
                                  THEN 1 ELSE 0 END), 0) AS sharedIdentities,
                COALESCE(SUM(CASE
                  WHEN json_extract(metadata_json, '$.sharedIdentity') = 1
                  THEN json_extract(metadata_json, '$.immutableAuditRows') ELSE 0 END), 0)
                  AS sharedIdentityAuditLinks
           FROM audit_events
          WHERE event_id = ? AND action = 'participant.retention.subject_anonymised'`,
      )
        .bind(viewer.eventId)
        .first<{
          anonymisedParticipants: number;
          sharedIdentities: number;
          sharedIdentityAuditLinks: number;
        }>(),
    ]);
    if (!state) {
      throw new ParticipantRetentionAccessError();
    }
    if (this.projectionDepth === 0) await this.airtable.assertReadable(viewer);
    const completedMetadata = parseCompletionMetadata(state.completionMetadata);
    const now = Math.floor(Date.now() / 1_000);
    const blockers: string[] = [];
    if (state.holdAt !== null)
      blockers.push("The event retention hold is active.");
    if (state.eligibleAt > now)
      blockers.push("The configured event retention period has not elapsed.");
    if (count(state.publishedForms) > 0)
      blockers.push(
        `${count(state.publishedForms)} public form${count(state.publishedForms) === 1 ? " is" : "s are"} still published. Close or archive every public form first.`,
      );
    if (count(state.pendingFiles) > 0)
      blockers.push(
        `${count(state.pendingFiles)} private file asset${count(state.pendingFiles) === 1 ? " must" : "s must"} be permanently erased first.`,
      );
    const activeWork =
      count(state.activeOperations) +
      count(state.activeCommunications) +
      count(state.activeCalendarAttempts) +
      count(state.activeIntegrationRuns) +
      count(state.activeWebhookDeliveries);
    if (activeWork > 0)
      blockers.push(
        `${activeWork} provider or background operation${activeWork === 1 ? " is" : "s are"} actively running. Wait for a terminal result before anonymising.`,
      );
    if (count(state.activeCalendarInvitations) > 0)
      blockers.push(
        `${count(state.activeCalendarInvitations)} direct calendar invitation${count(state.activeCalendarInvitations) === 1 ? " requires" : "s require"} cancellation and provider reconciliation first.`,
      );
    const integrityViolations: string[] = [];
    if (state.completedAt !== null && state.completionMetadata === null)
      integrityViolations.push(
        "The completion tombstone exists without its immutable completion audit.",
      );
    if (state.completedAt === null && state.completionMetadata !== null)
      integrityViolations.push(
        "The immutable completion audit exists without the event completion tombstone.",
      );
    if (state.completedAt !== null && pendingParticipants > 0)
      integrityViolations.push(
        `${pendingParticipants} non-pseudonymous participant link${pendingParticipants === 1 ? " exists" : "s exist"} after completion.`,
      );
    if (state.completedAt !== null)
      integrityViolations.push(...(await this.completionIntegrity(viewer)));
    if (state.completedAt !== null && blockers.length > 0)
      integrityViolations.push(...blockers);
    return {
      name: state.name,
      retentionMonths: count(state.retentionMonths),
      eligibleAt: count(state.eligibleAt),
      eligible: state.eligibleAt <= now,
      holdAt: state.holdAt,
      completedAt: state.completedAt,
      completed: state.completedAt !== null,
      pendingParticipants,
      anonymisedParticipants: count(subjectSummary?.anonymisedParticipants),
      sharedIdentities: count(subjectSummary?.sharedIdentities),
      immutableAuditRecords: count(state.immutableAuditRecords),
      sharedIdentityAuditLinks: count(subjectSummary?.sharedIdentityAuditLinks),
      retainedProgrammeRecords: count(state.retainedProgrammeRecords),
      repositoryProvider: state.repositoryProvider,
      externalProviderErasureRequired:
        completedMetadata?.externalProviderErasureRequired ??
        (state.repositoryProvider === "airtable" ||
          count(state.externalIntegrationConnections) > 0 ||
          count(state.externalDeliveryRecords) > 0),
      unscopedStoresNotAutomaticallyRedacted:
        completedMetadata?.unscopedStoresNotAutomaticallyRedacted ?? [
          "webhook_receipts",
          "abuse_rate_limits",
        ],
      blockers: state.completedAt === null ? blockers : [],
      integrityViolations,
      canRun:
        state.completedAt === null &&
        blockers.length === 0 &&
        integrityViolations.length === 0,
    };
  }

  protected async buildMappings(
    viewer: Viewer,
    operationId: string,
    candidates: ParticipantCandidate[],
  ): Promise<InternalMapping[]> {
    const mappings: InternalMapping[] = [];
    for (const candidate of candidates) {
      const digest = await sha256Hex(
        `program-cue-participant-retention-v1:${viewer.eventId}:${candidate.id}`,
      );
      const classification = await this.classifyCandidate(viewer, candidate);
      const pseudonymToken = crypto.randomUUID();
      const retiredToken = crypto.randomUUID();
      mappings.push({
        ...candidate,
        pseudonymId: `${RETAINED_PERSON_PREFIX}${pseudonymToken}`,
        pseudonymEmail: `retained-${pseudonymToken}@privacy.invalid`,
        retiredEmail: `retired-account-${retiredToken}@privacy.invalid`,
        subjectAuditId: `participant-retention-subject:${viewer.eventId}:${digest}`,
        ...classification,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        operationId,
      });
    }
    return mappings;
  }
}
