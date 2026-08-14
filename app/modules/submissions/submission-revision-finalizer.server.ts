import { buildCoSpeakerInvitationPlan } from "./co-speaker-invitation.server";
import type { PreparedApplicantMutationEvent } from "./submission-applicant-events.server";
import type { EvaluatorEmailRouting } from "~/platform/evaluation/evaluator-email-alias.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type Applicant,
  type FormSummary,
  type FormVersion,
  type SubmittedRevisionCommand,
  type SubmittedRevisionCommit,
} from "./submission-repository-shared";
import { type DraftPayload } from "./submission-schema";
import {
  assertCurrentRevisionState,
  assertSubmittedRevisionRequest,
  parseCurrentSubmittedSnapshot,
  planSubmittedRevisionSpeakers,
  type PersistedRevisionSpeaker,
} from "./submission-revision-plan";

type RevisionOptions = {
  trackSelections: Array<{ trackId: string; trackName: string }>;
  routedTeamIds: string[];
  command: SubmittedRevisionCommand;
  event: PreparedApplicantMutationEvent;
  evaluatorEmailRoutings?: EvaluatorEmailRouting[];
};

function uploadEntries(
  uploads: DraftPayload["uploads"],
): Array<[string, { assetId: string; versionId: string }]> {
  return Object.entries(uploads ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function sameUploads(
  left: DraftPayload["uploads"],
  right: DraftPayload["uploads"],
) {
  return (
    JSON.stringify(uploadEntries(left)) === JSON.stringify(uploadEntries(right))
  );
}

export class SubmissionRevisionFinalizer {
  constructor(private readonly env: CloudflareEnvironment) {}

  async revise(
    form: FormSummary & { version: FormVersion },
    applicant: Extract<Applicant, { verified: true }>,
    payload: DraftPayload,
    options: RevisionOptions,
  ) {
    assertSubmittedRevisionRequest({
      form,
      applicant,
      command: options.command,
      preparedEventId: options.event.eventId,
      preparedWebhookEventId: options.event.webhook.eventId,
      trackSelectionCount: options.trackSelections.length,
    });

    const current = await this.env.DB.prepare(
      `SELECT submission.status, submission.revision,
              submission.submitted_snapshot_json AS submittedSnapshotJson,
              event.organisation_id AS organisationId, event.name AS eventName,
              event.brand_accent AS brandAccent, event.starts_at AS startsAt,
              event.ends_at AS endsAt, event.venue_name AS venueName, event.city,
              current_form.status AS formStatus,
              current_form.revision AS formRevision,
              current_form.public_slug AS currentPublicSlug,
              current_form.closes_at AS closesAt,
              (
                EXISTS (
                  SELECT 1 FROM evaluator_assignments assignment
                   LEFT JOIN reviews review
                     ON review.assignment_id = assignment.id
                    AND review.event_id = assignment.event_id
                  WHERE assignment.submission_id = submission.id
                    AND assignment.event_id = submission.event_id
                    AND (assignment.status <> 'cancelled' OR review.id IS NOT NULL)
                )
                OR EXISTS (
                  SELECT 1 FROM evaluator_conflicts conflict
                   WHERE conflict.submission_id = submission.id
                     AND conflict.event_id = submission.event_id
                )
                OR EXISTS (
                  SELECT 1 FROM review_moderations moderation
                   WHERE moderation.submission_id = submission.id
                     AND moderation.event_id = submission.event_id
                )
                OR EXISTS (
                  SELECT 1 FROM submission_decisions decision
                   WHERE decision.submission_id = submission.id
                     AND decision.event_id = submission.event_id
                )
                OR EXISTS (
                  SELECT 1 FROM sessions session
                   WHERE session.source_submission_id = submission.id
                     AND session.event_id = submission.event_id
                )
                OR EXISTS (
                  SELECT 1 FROM ai_review_assessments assessment
                   WHERE assessment.submission_id = submission.id
                     AND assessment.event_id = submission.event_id
                )
                OR EXISTS (
                  SELECT 1 FROM operation_jobs operation
                   WHERE operation.event_id = submission.event_id
                     AND operation.type = 'ai.review_assessment.generate'
                     AND operation.status NOT IN ('failed', 'cancelled')
                     AND json_extract(operation.payload_json, '$.submissionId') = submission.id
                )
              ) AS hasDownstreamWork
         FROM submissions submission
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
         JOIN form_definitions current_form
           ON current_form.id = version.form_id
          AND current_form.event_id = version.event_id
         JOIN events event ON event.id = submission.event_id
        WHERE submission.id = ? AND submission.event_id = ?
          AND submission.form_version_id = ?
          AND submission.submitter_person_id = ?
          AND version.form_id = ?`,
    )
      .bind(
        payload.submissionId,
        form.eventId,
        form.version.id,
        applicant.personId,
        form.id,
      )
      .first<{
        status: string;
        revision: number;
        submittedSnapshotJson: string | null;
        organisationId: string;
        eventName: string;
        brandAccent: string;
        startsAt: number;
        endsAt: number;
        venueName: string | null;
        city: string | null;
        formStatus: string;
        formRevision: number;
        currentPublicSlug: string;
        closesAt: number | null;
        hasDownstreamWork: number;
      }>();
    if (!current) {
      throw new SubmissionStateError(
        "The submitted application is unavailable for revision.",
      );
    }
    if (
      options.event.organisationId !== current.organisationId ||
      options.command.organisationId !== current.organisationId
    ) {
      throw new Error(
        "The prepared revision event does not belong to the submission organisation.",
      );
    }
    assertCurrentRevisionState({
      submissionId: payload.submissionId,
      expectedRevision: payload.revision,
      currentRevision: current.revision,
      status: current.status,
      hasDownstreamWork: current.hasDownstreamWork,
      formStatus: current.formStatus,
      closesAt: current.closesAt,
    });
    const snapshot = parseCurrentSubmittedSnapshot({
      submissionId: payload.submissionId,
      snapshotJson: current.submittedSnapshotJson,
      form,
      payload,
      sameUploads,
    });

    const currentSpeakers = await this.env.DB.prepare(
      `SELECT speaker.id, speaker.person_id AS personId, speaker.email,
              speaker.display_name AS displayName, speaker.position,
              speaker.invitation_status AS invitationStatus,
              speaker.is_primary AS isPrimary,
              COALESCE(person.biography, '') AS claimedBiography
         FROM submission_speakers speaker
         LEFT JOIN people person ON person.id = speaker.person_id
        WHERE speaker.submission_id = ? AND speaker.event_id = ?
        ORDER BY speaker.position, speaker.id`,
    )
      .bind(payload.submissionId, form.eventId)
      .all<PersistedRevisionSpeaker>();
    const {
      existingRelationshipsJson: existingSpeakerRelationshipsJson,
      newInvitees,
    } = planSubmittedRevisionSpeakers({
      submissionId: payload.submissionId,
      applicant,
      persisted: currentSpeakers.results,
      submitted: snapshot.speakers,
      requested: payload.speakers,
    });
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (newInvitees.length > 0 && !operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    const invitationPlans = await Promise.all(
      newInvitees.map((speaker) =>
        buildCoSpeakerInvitationPlan(
          this.env,
          {
            organisationId: current.organisationId,
            eventId: form.eventId,
            eventName: current.eventName,
            brandAccent: current.brandAccent,
            startsAt: current.startsAt,
            endsAt: current.endsAt,
            physicalAddress: [current.venueName, current.city]
              .filter((value): value is string => Boolean(value?.trim()))
              .join(", "),
            formId: form.id,
            publicSlug: current.currentPublicSlug,
            submissionId: payload.submissionId,
            submissionTitle: String(payload.answers.title),
            requestedByPersonId: applicant.personId,
            submissionOperationId: options.command.recordId,
          },
          {
            id: speaker.id,
            email: speaker.email,
            displayName: speaker.name,
            claimTokenHash: null,
          },
        ),
      ),
    );

    const nextRevision = payload.revision + 1;
    const categoryAnswer = payload.answers.category;
    const category = Array.isArray(categoryAnswer)
      ? String(categoryAnswer[0] ?? "").trim() || null
      : String(categoryAnswer || "").trim() || null;
    const format = String(payload.answers.format || "").trim() || null;
    const title = String(payload.answers.title).trim();
    const submittedSnapshot = JSON.stringify({
      formVersionId: form.version.id,
      versionNumber: form.version.versionNumber,
      schema: form.version.schema,
      answers: payload.answers,
      speakers: payload.speakers,
      uploads: payload.uploads ?? {},
    });
    const trackSelectionsJson = JSON.stringify(options.trackSelections);
    const routedTeamIdsJson = JSON.stringify(options.routedTeamIds);
    const uploadsJson = JSON.stringify(payload.uploads ?? {});
    const committed: SubmittedRevisionCommit = {
      submissionId: payload.submissionId,
      organisationId: current.organisationId,
      eventId: form.eventId,
      revision: nextRevision,
      invitationCount: invitationPlans.length,
      webhookCount:
        options.event.webhook.existingResults.length +
        options.event.webhook.candidates.length,
      auditEventId: options.event.auditEventId,
    };
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = ? AND idempotency_key = ?
            AND expires_at <= unixepoch()`,
      ).bind(
        options.command.organisationId,
        options.command.eventId,
        options.command.actorId,
        options.command.scope,
        options.command.idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
                   unixepoch() + 2592000, unixepoch())`,
      ).bind(
        options.command.recordId,
        options.command.organisationId,
        options.command.eventId,
        options.command.actorId,
        options.command.scope,
        options.command.idempotencyKey,
        options.command.requestHash,
      ),
      this.env.DB.prepare(
        `UPDATE submissions
            SET title = ?, category = ?, format = ?, answers_json = ?,
                submitted_snapshot_json = ?, revision = revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND form_version_id = ?
            AND submitter_person_id = ? AND status = 'submitted' AND revision = ?
            AND EXISTS (
              SELECT 1 FROM idempotency_records command
               WHERE command.id = ? AND command.organisation_id = ?
                 AND command.event_id = ? AND command.actor_id = ?
                 AND command.scope = ? AND command.idempotency_key = ?
                 AND command.request_hash = ? AND command.status = 'processing'
            )
            AND (
              SELECT COUNT(*) FROM submission_speakers existing_speaker
               WHERE existing_speaker.submission_id = submissions.id
                 AND existing_speaker.event_id = submissions.event_id
            ) = ?
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) expected_speaker
               WHERE NOT EXISTS (
                 SELECT 1 FROM submission_speakers existing_speaker
                 LEFT JOIN people existing_person
                   ON existing_person.id = existing_speaker.person_id
                  WHERE existing_speaker.submission_id = submissions.id
                    AND existing_speaker.event_id = submissions.event_id
                    AND existing_speaker.id = json_extract(expected_speaker.value, '$.id')
                    AND existing_speaker.person_id IS json_extract(expected_speaker.value, '$.personId')
                    AND existing_speaker.email = json_extract(expected_speaker.value, '$.email')
                    AND existing_speaker.display_name = json_extract(expected_speaker.value, '$.displayName')
                    AND existing_speaker.position = json_extract(expected_speaker.value, '$.position')
                    AND existing_speaker.invitation_status = json_extract(expected_speaker.value, '$.invitationStatus')
                    AND existing_speaker.is_primary = json_extract(expected_speaker.value, '$.isPrimary')
                    AND COALESCE(existing_person.biography, '') = json_extract(expected_speaker.value, '$.claimedBiography')
               )
            )
            AND NOT EXISTS (
              SELECT 1 FROM evaluator_assignments assignment
               LEFT JOIN reviews review
                 ON review.assignment_id = assignment.id
                AND review.event_id = assignment.event_id
               WHERE assignment.submission_id = submissions.id
                 AND assignment.event_id = submissions.event_id
                 AND (assignment.status <> 'cancelled' OR review.id IS NOT NULL)
            )
            AND NOT EXISTS (
              SELECT 1 FROM evaluator_conflicts conflict
               WHERE conflict.submission_id = submissions.id
                 AND conflict.event_id = submissions.event_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM review_moderations moderation
               WHERE moderation.submission_id = submissions.id
                 AND moderation.event_id = submissions.event_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM submission_decisions decision
               WHERE decision.submission_id = submissions.id
                 AND decision.event_id = submissions.event_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM sessions session
               WHERE session.source_submission_id = submissions.id
                 AND session.event_id = submissions.event_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM ai_review_assessments assessment
               WHERE assessment.submission_id = submissions.id
                 AND assessment.event_id = submissions.event_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM operation_jobs operation
               WHERE operation.event_id = submissions.event_id
                 AND operation.type = 'ai.review_assessment.generate'
                 AND operation.status NOT IN ('failed', 'cancelled')
                 AND json_extract(operation.payload_json, '$.submissionId') = submissions.id
            )
            AND EXISTS (
              SELECT 1 FROM form_definitions current_form
               WHERE current_form.id = ? AND current_form.event_id = submissions.event_id
                 AND current_form.revision = ?
                 AND current_form.status = 'published'
                 AND (current_form.closes_at IS NULL OR current_form.closes_at >= unixepoch())
            )
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) expected_track
               WHERE NOT EXISTS (
                 SELECT 1 FROM tracks track
                  WHERE track.id = json_extract(expected_track.value, '$.trackId')
                    AND track.event_id = submissions.event_id
               )
            )
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) expected_team
               WHERE NOT EXISTS (
                 SELECT 1 FROM evaluation_teams team
                  WHERE team.id = CAST(expected_team.value AS TEXT)
                    AND team.event_id = submissions.event_id
               )
            )
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) expected_upload
               WHERE NOT EXISTS (
                 SELECT 1
                   FROM file_assets asset
                   JOIN file_versions version
                     ON version.id = json_extract(expected_upload.value, '$.versionId')
                    AND version.asset_id = asset.id
                    AND version.event_id = asset.event_id
                  WHERE asset.id = json_extract(expected_upload.value, '$.assetId')
                    AND asset.event_id = submissions.event_id
                    AND asset.target_type = 'submission'
                    AND asset.target_id = submissions.id
                    AND asset.asset_kind = 'video'
                    AND asset.owner_person_id = submissions.submitter_person_id
                    AND asset.status = 'active'
                    AND asset.current_version_id = version.id
                    AND version.upload_status = 'uploaded'
                    AND version.signature_status = 'valid'
                    AND version.scan_status = 'clean'
                    AND version.released_at IS NOT NULL
                    AND version.deleted_at IS NULL
               )
            )`,
      ).bind(
        title,
        category,
        format,
        JSON.stringify(payload.answers),
        submittedSnapshot,
        options.command.recordId,
        payload.submissionId,
        form.eventId,
        form.version.id,
        applicant.personId,
        payload.revision,
        options.command.recordId,
        options.command.organisationId,
        options.command.eventId,
        options.command.actorId,
        options.command.scope,
        options.command.idempotencyKey,
        options.command.requestHash,
        currentSpeakers.results.length,
        existingSpeakerRelationshipsJson,
        form.id,
        current.formRevision,
        trackSelectionsJson,
        routedTeamIdsJson,
        uploadsJson,
      ),
      this.env.DB.prepare(
        `DELETE FROM submission_track_selections
          WHERE submission_id = ? AND event_id = ?
            AND EXISTS (
              SELECT 1 FROM submissions submission
               WHERE submission.id = ? AND submission.event_id = ?
                 AND submission.last_operation_id = ?
            )`,
      ).bind(
        payload.submissionId,
        form.eventId,
        payload.submissionId,
        form.eventId,
        options.command.recordId,
      ),
      this.env.DB.prepare(
        `DELETE FROM submission_routing_teams
          WHERE submission_id = ? AND event_id = ?
            AND EXISTS (
              SELECT 1 FROM submissions submission
               WHERE submission.id = ? AND submission.event_id = ?
                 AND submission.last_operation_id = ?
            )`,
      ).bind(
        payload.submissionId,
        form.eventId,
        payload.submissionId,
        form.eventId,
        options.command.recordId,
      ),
    ];
    const submissionUpdateIndex = 2;
    for (const track of options.trackSelections) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO submission_track_selections (
             submission_id, event_id, track_id, track_name_snapshot, position
           ) SELECT ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM submissions submission
                 WHERE submission.id = ? AND submission.event_id = ?
                   AND submission.last_operation_id = ?
              )`,
        ).bind(
          payload.submissionId,
          form.eventId,
          track.trackId,
          track.trackName,
          options.trackSelections.indexOf(track),
          payload.submissionId,
          form.eventId,
          options.command.recordId,
        ),
      );
    }
    for (const teamId of options.routedTeamIds) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO submission_routing_teams (
             submission_id, event_id, team_id
           ) SELECT ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM submissions submission
                 WHERE submission.id = ? AND submission.event_id = ?
                   AND submission.last_operation_id = ?
              )`,
        ).bind(
          payload.submissionId,
          form.eventId,
          teamId,
          payload.submissionId,
          form.eventId,
          options.command.recordId,
        ),
      );
    }
    for (const speaker of newInvitees) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO submission_speakers (
             id, event_id, submission_id, person_id, email, display_name,
             role_label, position, invitation_status, is_primary,
             claimed_at, created_at, updated_at
           ) SELECT ?, ?, ?, NULL, ?, ?, 'Co-speaker', ?, 'pending', 0,
                    NULL,
                    unixepoch(), unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM submissions submission
                 WHERE submission.id = ? AND submission.event_id = ?
                   AND submission.last_operation_id = ?
              )`,
        ).bind(
          speaker.id,
          form.eventId,
          payload.submissionId,
          speaker.email,
          speaker.name,
          speaker.position,
          payload.submissionId,
          form.eventId,
          options.command.recordId,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO submission_revisions (
           id, event_id, submission_id, form_version_id, revision_number,
           answers_json, speaker_snapshot_json, save_kind,
           saved_by_person_id, idempotency_key, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM submissions submission
               WHERE submission.id = ? AND submission.event_id = ?
                 AND submission.last_operation_id = ?
                 AND submission.revision = ?
            )`,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        payload.submissionId,
        form.version.id,
        nextRevision,
        JSON.stringify(payload.answers),
        JSON.stringify(payload.speakers),
        applicant.personId,
        options.command.recordId,
        payload.submissionId,
        form.eventId,
        options.command.recordId,
        nextRevision,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'submission.revised', 'submission', ?, ?, ?,
                  unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM submissions submission
               WHERE submission.id = ? AND submission.event_id = ?
                 AND submission.last_operation_id = ?
                 AND submission.revision = ?
            )`,
      ).bind(
        options.event.auditEventId,
        current.organisationId,
        form.eventId,
        applicant.personId,
        payload.submissionId,
        options.command.recordId,
        JSON.stringify({
          previousRevision: payload.revision,
          revision: nextRevision,
          formVersionId: form.version.id,
          speakerCount: payload.speakers.length,
          ...(options.evaluatorEmailRoutings?.length
            ? { evaluatorEmailRoutings: options.evaluatorEmailRoutings }
            : {}),
        }),
        payload.submissionId,
        form.eventId,
        options.command.recordId,
        nextRevision,
      ),
    );
    for (const plan of invitationPlans) {
      statements.push(...plan.statements);
    }
    statements.push(...options.event.webhook.statements);
    const completionIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'submission', entity_id = ?,
                completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = ? AND idempotency_key = ?
            AND request_hash = ? AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM submission_revisions revision
               WHERE revision.submission_id = ? AND revision.event_id = ?
                 AND revision.revision_number = ?
                 AND revision.saved_by_person_id = ?
                 AND revision.idempotency_key = idempotency_records.id
            )
            AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ?
                 AND audit.organisation_id = idempotency_records.organisation_id
                 AND audit.event_id = idempotency_records.event_id
                 AND audit.actor_person_id = ?
                 AND audit.action = 'submission.revised'
                 AND audit.entity_type = 'submission'
                 AND audit.entity_id = ?
                 AND audit.correlation_id = idempotency_records.id
            )
            AND (
              SELECT COUNT(*) FROM operation_jobs operation
              JOIN communications communication
                ON communication.operation_id = operation.id
               AND communication.event_id = operation.event_id
              JOIN communication_deliveries delivery
                ON delivery.communication_id = communication.id
               AND delivery.event_id = communication.event_id
              JOIN submission_speakers speaker
                ON speaker.id = delivery.source_id
               AND speaker.event_id = delivery.event_id
               AND speaker.submission_id = ?
             WHERE operation.organisation_id = ? AND operation.event_id = ?
               AND operation.type = 'communication.send'
               AND json_extract(communication.audience_json,
                                '$.submissionOperationId') =
                   idempotency_records.id
            ) = ?
            AND (
              SELECT COUNT(*) FROM webhook_deliveries delivery
              JOIN webhook_endpoints endpoint
                ON endpoint.id = delivery.endpoint_id
              JOIN operation_items item
                ON item.entity_type = 'webhook_delivery'
               AND item.entity_id = delivery.id
              JOIN operation_jobs operation
                ON operation.id = item.operation_id
             WHERE endpoint.organisation_id = ? AND endpoint.event_id = ?
               AND operation.organisation_id = ? AND operation.event_id = ?
               AND delivery.event_type = 'submission.updated'
               AND delivery.entity_type = 'submission'
               AND delivery.entity_id = ?
               AND delivery.idempotency_key =
                   'webhook:' || endpoint.id || ':' || ?
            ) = ?`,
      ).bind(
        JSON.stringify(committed),
        payload.submissionId,
        options.command.recordId,
        options.command.organisationId,
        options.command.eventId,
        options.command.actorId,
        options.command.scope,
        options.command.idempotencyKey,
        options.command.requestHash,
        payload.submissionId,
        form.eventId,
        nextRevision,
        applicant.personId,
        options.event.auditEventId,
        applicant.personId,
        payload.submissionId,
        payload.submissionId,
        current.organisationId,
        form.eventId,
        invitationPlans.length,
        current.organisationId,
        form.eventId,
        current.organisationId,
        form.eventId,
        payload.submissionId,
        `submission.updated:${payload.submissionId}:${nextRevision}`,
        committed.webhookCount,
      ),
    );
    statements.push(
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = ? AND idempotency_key = ?
            AND request_hash = ? AND status = 'processing'
            AND NOT EXISTS (
              SELECT 1 FROM submission_revisions revision
               WHERE revision.submission_id = ? AND revision.event_id = ?
                 AND revision.idempotency_key = idempotency_records.id
            )`,
      ).bind(
        options.command.recordId,
        options.command.organisationId,
        options.command.eventId,
        options.command.actorId,
        options.command.scope,
        options.command.idempotencyKey,
        options.command.requestHash,
        payload.submissionId,
        form.eventId,
      ),
    );
    const completionGuardIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = CASE
              WHEN status = 'completed' AND response_status = 200
               AND response_json = ? AND entity_type = 'submission'
               AND entity_id = ? AND completed_at IS NOT NULL
              THEN status ELSE 'invalid' END
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = ? AND idempotency_key = ?
            AND request_hash = ?`,
      ).bind(
        JSON.stringify(committed),
        payload.submissionId,
        options.command.recordId,
        options.command.organisationId,
        options.command.eventId,
        options.command.actorId,
        options.command.scope,
        options.command.idempotencyKey,
        options.command.requestHash,
      ),
    );

    const results = await this.env.DB.batch(statements);
    if ((results[submissionUpdateIndex]?.meta.changes ?? 0) !== 1) {
      const latest = await this.env.DB.prepare(
        `SELECT status, revision,
                EXISTS (
                  SELECT 1 FROM evaluator_assignments assignment
                   WHERE assignment.submission_id = submission.id
                     AND assignment.event_id = submission.event_id
                ) AS hasAssignments
           FROM submissions submission
          WHERE submission.id = ? AND submission.event_id = ?
            AND submission.submitter_person_id = ?`,
      )
        .bind(payload.submissionId, form.eventId, applicant.personId)
        .first<{ status: string; revision: number; hasAssignments: number }>();
      if (latest && latest.revision !== payload.revision) {
        throw new SubmissionRevisionConflictError();
      }
      if (!latest || latest.status !== "submitted" || latest.hasAssignments) {
        throw new SubmissionStateError(
          "Only a submitted application with no review in progress can be revised.",
        );
      }
      throw new SubmissionStateError(
        "The form, routing, native upload or submission state changed before the revision was saved. Refresh and review the application again.",
      );
    }
    if ((results[completionIndex]?.meta.changes ?? 0) !== 1) {
      throw new Error(
        "The submitted revision committed without its durable replay result.",
      );
    }
    if ((results[completionGuardIndex]?.meta.changes ?? 0) !== 1) {
      throw new Error(
        "The submitted revision replay result did not satisfy its atomic completion guard.",
      );
    }
    return committed;
  }
}
