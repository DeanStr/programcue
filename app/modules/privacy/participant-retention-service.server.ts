import { z } from "zod";

import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";

const MAX_PARTICIPANTS_PER_BATCH = 20;
const RETAINED_PERSON_PREFIX = "retained-participant-";
const RETENTION_COMPLETION_PREFIX = "participant-retention-complete:";
const REDACTED_JSON = JSON.stringify({
  redacted: true,
  reason: "event_retention_period_elapsed",
});

export class ParticipantRetentionAccessError extends Error {
  constructor() {
    super(
      "Organisation owner access is required for participant-retention controls.",
    );
    this.name = "ParticipantRetentionAccessError";
  }
}

export class ParticipantRetentionConfirmationError extends Error {
  constructor() {
    super("Type the event name to confirm participant anonymisation.");
    this.name = "ParticipantRetentionConfirmationError";
  }
}

export class ParticipantRetentionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParticipantRetentionStateError";
  }
}

type ParticipantCandidate = {
  id: string;
  email: string;
};

type ParticipantMapping = ParticipantCandidate & {
  pseudonymId: string;
  pseudonymEmail: string;
  retiredEmail: string;
  subjectAuditId: string;
  shared: boolean;
  immutableAuditRows: number;
};

type CompletionMetadata = {
  version: 1;
  scope: "local_event_data";
  repositoryProvider: string;
  externalProviderErasureRequired: boolean;
  immutableAuditRecords: number;
  sharedIdentityAuditLinks: number;
  retainedProgrammeRecords: number;
  unscopedStoresNotAutomaticallyRedacted: string[];
};

const participantPredicateSql = `(
  EXISTS (SELECT 1 FROM memberships candidate_membership
    WHERE candidate_membership.event_id = ?
      AND candidate_membership.person_id = person.id
      AND candidate_membership.role IN ('submitter','speaker'))
  OR EXISTS (SELECT 1 FROM submissions candidate_submission
    WHERE candidate_submission.event_id = ?
      AND candidate_submission.submitter_person_id = person.id)
  OR EXISTS (SELECT 1 FROM submission_speakers candidate_speaker
    WHERE candidate_speaker.event_id = ? AND candidate_speaker.person_id = person.id)
  OR EXISTS (SELECT 1 FROM session_speakers candidate_session_speaker
    WHERE candidate_session_speaker.event_id = ? AND candidate_session_speaker.person_id = person.id)
  OR EXISTS (SELECT 1 FROM task_instances candidate_task
    WHERE candidate_task.event_id = ? AND candidate_task.owner_person_id = person.id
      AND candidate_task.target_type = 'speaker')
  OR EXISTS (SELECT 1 FROM task_evidence candidate_evidence
    JOIN task_instances candidate_evidence_task
      ON candidate_evidence_task.id = candidate_evidence.task_id
     AND candidate_evidence_task.event_id = candidate_evidence.event_id
    WHERE candidate_evidence.event_id = ?
      AND candidate_evidence_task.target_type = 'speaker'
      AND candidate_evidence.submitted_by_person_id = person.id)
  OR EXISTS (SELECT 1 FROM resource_acknowledgements candidate_acknowledgement
    WHERE candidate_acknowledgement.event_id = ? AND candidate_acknowledgement.person_id = person.id)
  OR EXISTS (SELECT 1 FROM resource_audiences candidate_audience
    WHERE candidate_audience.event_id = ?
      AND candidate_audience.target_type = 'person'
      AND candidate_audience.target_id = person.id)
  OR EXISTS (SELECT 1 FROM public_itineraries candidate_itinerary
    WHERE candidate_itinerary.event_id = ? AND candidate_itinerary.person_id = person.id)
  OR EXISTS (SELECT 1 FROM calendar_connections candidate_connection
    WHERE candidate_connection.event_id = ? AND candidate_connection.person_id = person.id)
  OR EXISTS (SELECT 1 FROM calendar_invitations candidate_invitation
    WHERE candidate_invitation.event_id = ? AND candidate_invitation.person_id = person.id)
  OR EXISTS (SELECT 1 FROM communication_deliveries candidate_delivery
    WHERE candidate_delivery.event_id = ? AND candidate_delivery.person_id = person.id)
  OR EXISTS (SELECT 1 FROM communication_unsubscribes candidate_unsubscribe
    WHERE candidate_unsubscribe.event_id = ? AND candidate_unsubscribe.person_id = person.id)
  OR EXISTS (SELECT 1 FROM file_assets candidate_file
    WHERE candidate_file.event_id = ? AND candidate_file.owner_person_id = person.id
      AND candidate_file.target_type IN ('person','submission','session','task'))
)`;

function participantIdBindings(eventId: string) {
  return Array.from({ length: 14 }, () => eventId);
}

function candidateSql(suffix: string) {
  return `
    SELECT person.id, person.email
      FROM people person
     WHERE ${participantPredicateSql}
       AND person.id NOT LIKE '${RETAINED_PERSON_PREFIX}%'
     ORDER BY person.id
     ${suffix}
  `;
}

function candidateBindings(viewer: Viewer) {
  return participantIdBindings(viewer.eventId);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function completionId(eventId: string) {
  return `${RETENTION_COMPLETION_PREFIX}${eventId}`;
}

function requireOwner(viewer: Viewer) {
  if (viewer.role !== "owner") throw new ParticipantRetentionAccessError();
}

function count(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function parseCompletionMetadata(
  value: string | null,
): CompletionMetadata | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  return z
    .object({
      version: z.literal(1),
      scope: z.literal("local_event_data"),
      repositoryProvider: z.string(),
      externalProviderErasureRequired: z.boolean(),
      immutableAuditRecords: z.number().int().nonnegative(),
      sharedIdentityAuditLinks: z.number().int().nonnegative(),
      retainedProgrammeRecords: z.number().int().nonnegative(),
      unscopedStoresNotAutomaticallyRedacted: z.array(z.string()),
    })
    .parse(parsed);
}

function eventClaimGuard() {
  return `EXISTS (
    SELECT 1 FROM events retention_event
     WHERE retention_event.id = ?
       AND retention_event.organisation_id = ?
       AND retention_event.last_operation_id = ?
  )`;
}

type InternalMapping = ParticipantMapping & {
  eventId: string;
  organisationId: string;
  operationId: string;
};

function mapStatement(
  env: CloudflareEnvironment,
  mappings: InternalMapping[],
  table: string,
  column: string,
  eventWhere = "event_id = ?",
  extraWhere = "1 = 1",
) {
  const cases = mappings.map(() => "WHEN ? THEN ?").join(" ");
  const originals = mappings.map(() => "?").join(", ");
  return env.DB.prepare(
    `UPDATE ${table}
        SET ${column} = CASE ${column} ${cases} ELSE ${column} END
      WHERE ${eventWhere}
        AND ${extraWhere}
        AND ${column} IN (${originals})
        AND ${eventClaimGuard()}`,
  ).bind(
    ...mappings.flatMap((mapping) => [mapping.id, mapping.pseudonymId]),
    mappings[0]!.eventId,
    ...mappings.map((mapping) => mapping.id),
    mappings[0]!.eventId,
    mappings[0]!.organisationId,
    mappings[0]!.operationId,
  );
}

export class ParticipantRetentionService {
  private readonly airtable: AirtableProviderBoundary;
  private projectionDepth = 0;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private async candidates(viewer: Viewer, limit?: number) {
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

  private async candidateCount(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM (${candidateSql("")}) candidates`,
    )
      .bind(...candidateBindings(viewer))
      .first<{ total: number }>();
    return count(row?.total);
  }

  private async completionIntegrity(viewer: Viewer) {
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
               OR person.profile_status <> 'archived'
               OR EXISTS (SELECT 1 FROM auth_sessions auth
                            WHERE auth.person_id = person.id)
               OR EXISTS (SELECT 1 FROM auth_accounts auth
                            WHERE auth.person_id = person.id)
               OR EXISTS (SELECT 1 FROM verification_tokens token
                            WHERE token.identifier = person.email COLLATE NOCASE)))
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

  private async classifyCandidate(
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
             SELECT 1 FROM audit_events
              WHERE actor_person_id = ? AND (event_id IS NULL OR event_id <> ?)
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
        ...Array.from({ length: 14 }, () => [
          candidate.id,
          viewer.eventId,
        ]).flat(),
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

  private async buildMappings(
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

  private claimStatement(
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

  private async remapBatch(
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

  private async finalise(
    viewer: Viewer,
    preview: Awaited<ReturnType<ParticipantRetentionService["preview"]>>,
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

  private async anonymiseExpiredParticipantsD1(
    viewer: Viewer,
    preview: Awaited<ReturnType<ParticipantRetentionService["preview"]>>,
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
