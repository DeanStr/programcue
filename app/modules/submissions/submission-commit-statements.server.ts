import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import type { EvaluatorEmailRouting } from "~/platform/evaluation/evaluator-email-alias.server";
import type {
  Applicant,
  FormSummary,
  FormVersion,
} from "./submission-repository-shared";
import type { DraftPayload } from "./submission-schema";

export type SubmissionFinalizationOptions = {
  trackSelections: Array<{ trackId: string; trackName: string }>;
  routedTeamIds: string[];
  upload?: { fieldId: string; assetId: string; versionId: string } | null;
  operationId?: string;
  evaluatorEmailRoutings?: EvaluatorEmailRouting[];
};

type SubmissionCommitInput = {
  env: CloudflareEnvironment;
  form: FormSummary & { version: FormVersion };
  applicant: Applicant;
  payload: DraftPayload;
  options: SubmissionFinalizationOptions;
  event: { organisationId: string; revision: number };
  operationId: string;
  revision: number;
  nextRevision: number;
  directSessionId: string | null;
  directSessionFormat: string | null;
  directSessionDurationMinutes: number | null;
  finalStatus: "accepted" | "submitted";
  submissionSnapshot: string;
  submissionAuditEventId: string;
  directSessionAuditEventId: string | null;
  confirmationOperationId: string;
  confirmationCommunicationId: string;
  confirmationIdempotencyKey: string;
  applicationUrl: string;
  confirmationMessage: {
    type: "submission.notification";
    operationId: string;
    communicationId: string;
    submissionId: string;
    eventId: string;
    organisationId: string;
    idempotencyKey: string;
    applicationUrl: string;
  };
};

function directSessionSlug(title: string, sessionId: string) {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "session";
  return `${base}-${sessionId.slice(0, 8)}`;
}

function submissionTransitionStatements(
  input: Pick<
    SubmissionCommitInput,
    | "env"
    | "form"
    | "applicant"
    | "payload"
    | "options"
    | "event"
    | "operationId"
    | "revision"
    | "nextRevision"
    | "directSessionId"
    | "directSessionFormat"
    | "finalStatus"
    | "submissionSnapshot"
    | "submissionAuditEventId"
    | "confirmationOperationId"
    | "confirmationCommunicationId"
    | "confirmationIdempotencyKey"
    | "applicationUrl"
    | "confirmationMessage"
  >,
): D1PreparedStatement[] {
  const {
    env,
    form,
    applicant,
    payload,
    options,
    event,
    operationId,
    revision,
    nextRevision,
    directSessionId,
    directSessionFormat,
    finalStatus,
    submissionSnapshot,
    submissionAuditEventId,
    confirmationOperationId,
    confirmationCommunicationId,
    confirmationIdempotencyKey,
    applicationUrl,
    confirmationMessage,
  } = input;
  return [
    env.DB.prepare(
      `
        UPDATE submissions
           SET status = ?, submitted_snapshot_json = ?, revision = revision + 1,
               last_operation_id = ?, submitted_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND submitter_person_id = ? AND form_version_id = ?
           AND status = 'draft' AND revision = ?
           AND (? IS NULL OR EXISTS (
             SELECT 1
               FROM events configured_event,
                    json_each(configured_event.session_formats_json) configured_format
              WHERE configured_event.id = submissions.event_id
                AND configured_event.revision = ?
                AND json_extract(configured_format.value, '$.key') = ?
           ))
           AND (
             ? IS NULL OR EXISTS (
               SELECT 1
                 FROM file_assets upload_asset
                 JOIN file_versions upload_version
                   ON upload_version.id = ?
                  AND upload_version.asset_id = upload_asset.id
                  AND upload_version.event_id = upload_asset.event_id
                WHERE upload_asset.id = ?
                  AND upload_asset.event_id = submissions.event_id
                  AND upload_asset.target_type = 'submission'
                  AND upload_asset.target_id = submissions.id
                  AND upload_asset.asset_kind = 'video'
                  AND upload_asset.owner_person_id = submissions.submitter_person_id
                  AND upload_asset.status = 'active'
                  AND upload_asset.current_version_id = upload_version.id
                  AND upload_version.upload_status = 'uploaded'
                  AND upload_version.signature_status = 'valid'
                  AND upload_version.scan_status = 'clean'
                  AND upload_version.released_at IS NOT NULL
                  AND upload_version.deleted_at IS NULL
             )
           )
           AND (
             ? = 0 OR NOT EXISTS (
               SELECT 1 FROM json_each(?) expected_team
                WHERE NOT EXISTS (
                  SELECT 1 FROM evaluation_teams routed_team
                   WHERE routed_team.id = CAST(expected_team.value AS TEXT)
                     AND routed_team.event_id = submissions.event_id
                )
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?) expected_track
              WHERE NOT EXISTS (
                SELECT 1 FROM tracks current_track
                 WHERE current_track.id = json_extract(expected_track.value, '$.trackId')
                   AND current_track.event_id = submissions.event_id
              )
           )
           AND EXISTS (
             SELECT 1 FROM form_definitions current_form
              WHERE current_form.id = ? AND current_form.event_id = ?
                AND current_form.status = 'published'
                AND (current_form.opens_at IS NULL OR current_form.opens_at <= unixepoch())
                AND (current_form.closes_at IS NULL OR current_form.closes_at >= unixepoch())
                AND (
                  current_form.submission_limit IS NULL OR (
                    SELECT COUNT(*) FROM submissions current
                    JOIN form_versions current_version
                      ON current_version.id = current.form_version_id
                   WHERE current_version.form_id = current_form.id
                     AND current.status <> 'draft'
                  ) < current_form.submission_limit
                )
                AND (
                  current_form.per_person_submission_limit IS NULL OR (
                    SELECT COUNT(*) FROM submissions participant_submission
                    JOIN form_versions participant_version
                      ON participant_version.id = participant_submission.form_version_id
                     AND participant_version.event_id = participant_submission.event_id
                   WHERE participant_version.form_id = current_form.id
                     AND participant_submission.submitter_person_id = submissions.submitter_person_id
                     AND participant_submission.id <> submissions.id
                     AND participant_submission.status <> 'withdrawn'
                  ) < current_form.per_person_submission_limit
                )
           )
      `,
    ).bind(
      finalStatus,
      submissionSnapshot,
      operationId,
      payload.submissionId,
      form.eventId,
      applicant.personId,
      form.version.id,
      revision,
      directSessionId,
      event.revision,
      directSessionFormat,
      options.upload?.assetId ?? null,
      options.upload?.versionId ?? null,
      options.upload?.assetId ?? null,
      options.routedTeamIds.length,
      JSON.stringify(options.routedTeamIds),
      JSON.stringify(options.trackSelections),
      form.id,
      form.eventId,
    ),
    env.DB.prepare(
      `
        INSERT INTO submission_revisions (
          id, event_id, submission_id, form_version_id, revision_number, answers_json,
          speaker_snapshot_json, save_kind, saved_by_person_id, idempotency_key, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ? AND status <> 'draft')
      `,
    ).bind(
      crypto.randomUUID(),
      form.eventId,
      payload.submissionId,
      form.version.id,
      nextRevision,
      JSON.stringify(payload.answers),
      JSON.stringify(payload.speakers),
      applicant.personId,
      operationId,
      payload.submissionId,
      operationId,
    ),
    env.DB.prepare(
      `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
          entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'public_form', 1, ?, ?, ?, 'submission.submitted', 'submission', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ? AND status <> 'draft')
      `,
    ).bind(
      submissionAuditEventId,
      event.organisationId,
      form.eventId,
      applicant.personId,
      payload.submissionId,
      JSON.stringify({
        formVersionId: form.version.id,
        version: form.version.versionNumber,
        ...(options.evaluatorEmailRoutings?.length
          ? { evaluatorEmailRoutings: options.evaluatorEmailRoutings }
          : {}),
      }),
      payload.submissionId,
      operationId,
    ),
    env.DB.prepare(
      `
        INSERT INTO communications (
          id, event_id, operation_id, idempotency_key, kind, channel, status, audience_json,
          content_snapshot_json, recipient_count, queued_at, created_by_person_id, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'transactional', 'email', 'queued', ?, ?, 1, unixepoch(), ?, unixepoch(), unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ? AND status <> 'draft')
      `,
    ).bind(
      confirmationCommunicationId,
      form.eventId,
      confirmationOperationId,
      confirmationIdempotencyKey,
      JSON.stringify({
        kind: "submission_confirmation",
        personIds: [applicant.personId],
        emails: [applicant.email],
      }),
      JSON.stringify({
        schemaVersion: 1,
        category: "submission_confirmation",
        pendingMaterialization: true,
        submissionId: payload.submissionId,
        applicationUrl,
      }),
      applicant.personId,
      payload.submissionId,
      operationId,
    ),
    env.DB.prepare(
      `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
          correlation_id, status, payload_json, progress_total, progress_completed,
          progress_failed, cancellable, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'submission.notification', ?, ?, 'queued', ?, 1, 0, 0, 0, unixepoch(), unixepoch()
         WHERE EXISTS (SELECT 1 FROM communications WHERE id = ? AND event_id = ?)
      `,
    ).bind(
      confirmationOperationId,
      event.organisationId,
      form.eventId,
      applicant.personId,
      confirmationIdempotencyKey,
      crypto.randomUUID(),
      JSON.stringify(confirmationMessage),
      confirmationCommunicationId,
      form.eventId,
    ),
  ];
}

function submissionRoutingStatements(
  input: Pick<
    SubmissionCommitInput,
    "env" | "form" | "payload" | "options" | "operationId"
  >,
): D1PreparedStatement[] {
  const { env, form, payload, options, operationId } = input;
  const finalStatements: D1PreparedStatement[] = [];
  options.trackSelections.forEach((track, position) => {
    finalStatements.push(
      env.DB.prepare(
        `INSERT INTO submission_track_selections (
             submission_id, event_id, track_id, track_name_snapshot, position
           )
           SELECT ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM submissions submission
               WHERE submission.id = ? AND submission.event_id = ?
                 AND submission.last_operation_id = ? AND submission.status <> 'draft'
            )
              AND EXISTS (
                SELECT 1 FROM tracks track
                 WHERE track.id = ? AND track.event_id = ?
              )`,
      ).bind(
        payload.submissionId,
        form.eventId,
        track.trackId,
        track.trackName,
        position,
        payload.submissionId,
        form.eventId,
        operationId,
        track.trackId,
        form.eventId,
      ),
    );
  });
  for (const teamId of options.routedTeamIds) {
    finalStatements.push(
      env.DB.prepare(
        `INSERT INTO submission_routing_teams (
             submission_id, event_id, team_id
           )
           SELECT ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM submissions submission
               WHERE submission.id = ? AND submission.event_id = ?
                 AND submission.last_operation_id = ? AND submission.status <> 'draft'
            )
              AND EXISTS (
                SELECT 1 FROM evaluation_teams team
                 WHERE team.id = ? AND team.event_id = ?
              )`,
      ).bind(
        payload.submissionId,
        form.eventId,
        teamId,
        payload.submissionId,
        form.eventId,
        operationId,
        teamId,
        form.eventId,
      ),
    );
  }
  return finalStatements;
}

function directSessionStatements(
  input: Pick<
    SubmissionCommitInput,
    | "env"
    | "form"
    | "applicant"
    | "payload"
    | "options"
    | "event"
    | "operationId"
    | "directSessionId"
    | "directSessionFormat"
    | "directSessionDurationMinutes"
    | "directSessionAuditEventId"
  >,
): D1PreparedStatement[] {
  const {
    env,
    form,
    applicant,
    payload,
    options,
    event,
    operationId,
    directSessionId,
    directSessionFormat,
    directSessionDurationMinutes,
    directSessionAuditEventId,
  } = input;
  const finalStatements: D1PreparedStatement[] = [];
  if (directSessionId) {
    const title = String(payload.answers.title);
    if (!directSessionFormat || directSessionDurationMinutes === null) {
      throw new Error(
        "The direct-session format configuration was not resolved.",
      );
    }
    finalStatements.push(
      env.DB.prepare(
        `INSERT INTO sessions (
             id, event_id, source_submission_id, track_id, title, slug, description, format,
             duration_minutes, status, visibility, created_at, updated_at
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unscheduled', 'public', unixepoch(), unixepoch()
               WHERE EXISTS (
                 SELECT 1 FROM submissions
                  WHERE id = ? AND event_id = ? AND last_operation_id = ?
                    AND status = 'accepted'
               )`,
      ).bind(
        directSessionId,
        form.eventId,
        payload.submissionId,
        options.trackSelections[0].trackId,
        title,
        directSessionSlug(title, directSessionId),
        String(payload.answers.description ?? "").trim() || null,
        directSessionFormat,
        directSessionDurationMinutes,
        payload.submissionId,
        form.eventId,
        operationId,
      ),
    );
    finalStatements.push(
      env.DB.prepare(
        `INSERT INTO session_speakers (
             session_id, event_id, person_id, position, role_label,
             participation_status, participation_confirmed_at, visibility
          ) SELECT ?, speaker.event_id, speaker.person_id, speaker.position,
                    speaker.role_label,
                    'confirmed', unixepoch(), 'public'
               FROM submission_speakers speaker
              WHERE speaker.submission_id = ? AND speaker.event_id = ?
                AND speaker.person_id IS NOT NULL
                AND speaker.invitation_status = 'claimed'
                AND EXISTS (
                  SELECT 1 FROM sessions
                   WHERE id = ? AND event_id = ? AND source_submission_id = ?
                )`,
      ).bind(
        directSessionId,
        payload.submissionId,
        form.eventId,
        directSessionId,
        form.eventId,
        payload.submissionId,
      ),
    );
    for (const speaker of payload.speakers) {
      finalStatements.push(
        env.DB.prepare(
          `INSERT INTO memberships (
               id, organisation_id, event_id, person_id, role,
               invited_at, invitation_expires_at, accepted_at, revoked_at,
               last_operation_id, created_at
             )
             SELECT ?, ?, ?, person.id, 'speaker', unixepoch(), NULL,
                    unixepoch(), NULL, ?, unixepoch()
               FROM people person
               JOIN submission_speakers claimed
                 ON claimed.person_id = person.id
                AND claimed.event_id = ?
                AND claimed.submission_id = ?
                AND claimed.invitation_status = 'claimed'
              WHERE person.email = ? COLLATE NOCASE
                AND EXISTS (
                  SELECT 1 FROM session_speakers relationship
                   WHERE relationship.person_id = person.id
                     AND relationship.event_id = ?
                     AND relationship.session_id = ?
                )
             ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
             DO UPDATE SET invited_at = unixepoch(), invitation_expires_at = NULL,
                           accepted_at = unixepoch(), revoked_at = NULL,
                           last_operation_id = excluded.last_operation_id
              WHERE memberships.organisation_id = excluded.organisation_id
                AND (memberships.revoked_at IS NOT NULL
                     OR memberships.accepted_at IS NULL)`,
        ).bind(
          crypto.randomUUID(),
          event.organisationId,
          form.eventId,
          operationId,
          form.eventId,
          payload.submissionId,
          speaker.email,
          form.eventId,
          directSessionId,
        ),
      );
    }
    finalStatements.push(
      ...materializePublishedResourceAcknowledgementsForSession(
        env,
        form.eventId,
        directSessionId,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
             entity_id, correlation_id, metadata_json, created_at
           ) SELECT ?, 'person', 'public_form', 1, ?, ?, ?, 'session.direct.public_materialized', 'session',
                    ?, ?, ?, unixepoch()
               WHERE EXISTS (
                 SELECT 1 FROM sessions
                  WHERE id = ? AND event_id = ? AND source_submission_id = ?
               )`,
      ).bind(
        directSessionAuditEventId,
        event.organisationId,
        form.eventId,
        applicant.personId,
        directSessionId,
        operationId,
        JSON.stringify({
          formVersionId: form.version.id,
          intakeReference: payload.submissionId,
        }),
        directSessionId,
        form.eventId,
        payload.submissionId,
      ),
    );
  }
  return finalStatements;
}

// Keep transition, routing and direct-session effects in the caller's atomic batch.
export function buildSubmissionCommitStatements(
  input: SubmissionCommitInput,
): D1PreparedStatement[] {
  return [
    ...submissionTransitionStatements(input),
    ...submissionRoutingStatements(input),
    ...directSessionStatements(input),
  ];
}
