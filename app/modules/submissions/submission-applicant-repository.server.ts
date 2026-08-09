import { materializePublishedResourceAcknowledgementsForClaimedSpeaker } from "~/modules/resources/resource-service.server";
import type { DraftPayload } from "./submission-schema";
import {
  mapVersion,
  SubmissionDraftSavedError,
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type Applicant,
  type ApplicantDraft,
  type CoSpeakerInvitation,
  type FormSummary,
  type FormVersion,
  type VersionRow,
} from "./submission-repository-shared";

export class SubmissionApplicantRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async getApplicantDrafts(
    formId: string,
    applicant: Applicant,
  ): Promise<ApplicantDraft[]> {
    const rows = await this.env.DB.prepare(
      `
      SELECT s.id, s.title, COALESCE(s.category, '') AS category, COALESCE(s.format, '') AS format,
             s.status, s.answers_json AS answersJson, s.revision,
             s.form_version_id AS formVersionId, fv.version_number AS versionNumber,
             s.submitted_at AS submittedAt
        FROM submissions s
        JOIN form_versions fv ON fv.id = s.form_version_id AND fv.form_id = ?
       WHERE s.submitter_person_id = ?
       ORDER BY s.updated_at DESC
    `,
    )
      .bind(formId, applicant.personId)
      .all<{
        id: string;
        title: string;
        category: string;
        format: string;
        status: string;
        answersJson: string;
        revision: number;
        formVersionId: string;
        versionNumber: number;
        submittedAt: number | null;
      }>();

    return Promise.all(
      rows.results.map(async (row) => {
        const speakerRows = await this.env.DB.prepare(
          `
        SELECT ss.person_id AS personId, ss.display_name AS name, ss.email, ss.position,
               ss.is_primary AS isPrimary, ss.invitation_status AS invitationStatus
          FROM submission_speakers ss
         WHERE ss.submission_id = ?
         ORDER BY ss.position
      `,
        )
          .bind(row.id)
          .all<{
            personId: string | null;
            name: string;
            email: string;
            position: number;
            isPrimary: number;
            invitationStatus: string;
          }>();
        return {
          ...row,
          answers: JSON.parse(row.answersJson) as Record<
            string,
            string | string[]
          >,
          speakers: speakerRows.results.map((speaker) => ({
            ...speaker,
            isPrimary: Boolean(speaker.isPrimary),
          })),
        };
      }),
    );
  }

  async getCoSpeakerInvitations(
    formId: string,
    applicant: Applicant,
  ): Promise<CoSpeakerInvitation[]> {
    const rows = await this.env.DB.prepare(
      `
      SELECT ss.id, ss.submission_id AS submissionId, s.title AS submissionTitle,
             ss.display_name AS displayName, ss.invitation_status AS status
        FROM submission_speakers ss
        JOIN submissions s ON s.id = ss.submission_id AND s.event_id = ss.event_id
        JOIN form_versions fv ON fv.id = s.form_version_id AND fv.form_id = ?
       WHERE ss.email = ? COLLATE NOCASE
         AND ss.person_id IS NULL
         AND ss.invitation_status IN ('pending', 'sent')
       ORDER BY s.updated_at DESC
    `,
    )
      .bind(formId, applicant.email)
      .all<CoSpeakerInvitation>();
    return rows.results;
  }

  async claimCoSpeaker(
    formId: string,
    applicant: Applicant,
    invitationId: string,
  ) {
    const invitation = await this.env.DB.prepare(
      `
      SELECT speaker.event_id AS eventId
        FROM submission_speakers speaker
        JOIN submissions submission
          ON submission.id = speaker.submission_id
         AND submission.event_id = speaker.event_id
        JOIN form_versions version
          ON version.id = submission.form_version_id
         AND version.event_id = submission.event_id
       WHERE speaker.id = ? AND speaker.email = ? COLLATE NOCASE
         AND version.form_id = ?
    `,
    )
      .bind(invitationId, applicant.email, formId)
      .first<{ eventId: string }>();
    if (!invitation) {
      throw new SubmissionStateError(
        "This co-speaker invitation is no longer available.",
      );
    }
    const operationId = crypto.randomUUID();
    const [eventClaimed, speakerClaimed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE events
           SET revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE EXISTS (
           SELECT 1
             FROM submission_speakers speaker
             JOIN submissions submission
               ON submission.id = speaker.submission_id
              AND submission.event_id = speaker.event_id
             JOIN form_versions version
               ON version.id = submission.form_version_id
              AND version.event_id = submission.event_id
            WHERE speaker.id = ? AND speaker.event_id = events.id
              AND speaker.email = ? COLLATE NOCASE
              AND speaker.invitation_status IN ('pending', 'sent')
              AND version.form_id = ?
         )
           AND NOT EXISTS (
             SELECT 1
               FROM submission_speakers speaker
               JOIN sessions session
                 ON session.source_submission_id = speaker.submission_id
                AND session.event_id = speaker.event_id
              WHERE speaker.id = ? AND speaker.event_id = events.id
                AND session.status = 'published'
           )
      `,
      ).bind(operationId, invitationId, applicant.email, formId, invitationId),
      this.env.DB.prepare(
        `
        UPDATE submission_speakers
           SET person_id = ?, invitation_status = 'claimed', claimed_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ? AND email = ? COLLATE NOCASE AND invitation_status IN ('pending', 'sent')
           AND EXISTS (
             SELECT 1 FROM submissions s JOIN form_versions fv ON fv.id = s.form_version_id
              WHERE s.id = submission_speakers.submission_id AND fv.form_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = submission_speakers.event_id
                AND last_operation_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM sessions
              WHERE source_submission_id = submission_speakers.submission_id
                AND event_id = submission_speakers.event_id
                AND status = 'published'
           )
      `,
      ).bind(
        applicant.personId,
        invitationId,
        applicant.email,
        formId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type,
          entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, event.organisation_id, speaker.event_id, ?,
               'submission.speaker.claimed', 'submission_speaker', ?, ?, '{}', unixepoch()
          FROM submission_speakers speaker
          JOIN events event ON event.id = speaker.event_id
         WHERE speaker.id = ? AND speaker.person_id = ?
           AND speaker.invitation_status = 'claimed'
           AND event.last_operation_id = ?
      `,
      ).bind(
        crypto.randomUUID(),
        applicant.personId,
        invitationId,
        operationId,
        invitationId,
        applicant.personId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label, visibility
        )
        SELECT session.id, session.event_id, speaker.person_id,
               COALESCE((
                 SELECT MAX(existing.position) + 1
                   FROM session_speakers existing
                  WHERE existing.session_id = session.id
               ), 0),
               CASE WHEN speaker.is_primary = 1 THEN 'Primary speaker' ELSE 'Co-speaker' END,
               'public'
          FROM submission_speakers speaker
          JOIN sessions session
            ON session.source_submission_id = speaker.submission_id
           AND session.event_id = speaker.event_id
         WHERE speaker.id = ? AND speaker.person_id = ?
           AND speaker.invitation_status = 'claimed'
           AND session.status <> 'published'
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = speaker.event_id AND last_operation_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_speakers existing
              WHERE existing.session_id = session.id
                AND existing.person_id = speaker.person_id
           )
      `,
      ).bind(invitationId, applicant.personId, operationId),
      ...materializePublishedResourceAcknowledgementsForClaimedSpeaker(
        this.env,
        invitation.eventId,
        invitationId,
        applicant.personId,
        operationId,
      ),
    ]);
    if (
      (eventClaimed.meta.changes ?? 0) !== 1 ||
      (speakerClaimed.meta.changes ?? 0) !== 1
    ) {
      const publishedSession = await this.env.DB.prepare(
        `
        SELECT session.id
          FROM submission_speakers speaker
          JOIN submissions submission
            ON submission.id = speaker.submission_id
           AND submission.event_id = speaker.event_id
          JOIN form_versions version
            ON version.id = submission.form_version_id
           AND version.event_id = submission.event_id
          JOIN sessions session
            ON session.source_submission_id = speaker.submission_id
           AND session.event_id = speaker.event_id
         WHERE speaker.id = ? AND speaker.email = ? COLLATE NOCASE
           AND version.form_id = ? AND session.status = 'published'
         LIMIT 1
      `,
      )
        .bind(invitationId, applicant.email, formId)
        .first();
      if (publishedSession) {
        throw new SubmissionStateError(
          "This accepted session is already published, so its speaker list is locked. Contact an administrator to resolve this invitation.",
        );
      }
      throw new SubmissionStateError(
        "This co-speaker invitation is no longer available.",
      );
    }
  }

  async getApplicantDraftForm(
    publicForm: FormSummary & { version: FormVersion },
    applicant: Applicant,
    submissionId: string,
  ) {
    const version = await this.env.DB.prepare(
      `
      SELECT fv.id, fv.revision, fv.version_number AS versionNumber, fv.schema_json AS schemaJson,
             fv.routing_json AS routingJson, fv.settings_snapshot_json AS settingsSnapshotJson,
             fv.status, fv.published_at AS publishedAt
        FROM submissions s
        JOIN form_versions fv ON fv.id = s.form_version_id AND fv.form_id = ?
       WHERE s.id = ? AND s.event_id = ? AND s.submitter_person_id = ?
       LIMIT 1
    `,
    )
      .bind(publicForm.id, submissionId, publicForm.eventId, applicant.personId)
      .first<VersionRow>();
    if (!version)
      throw new Response("Application draft not found", { status: 404 });
    const mapped = mapVersion(version);
    return {
      ...publicForm,
      ...mapped.settings,
      accessPasswordHash: mapped.routing.passwordHash,
      version: mapped,
    };
  }

  async createDraft(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
  ) {
    const id = crypto.randomUUID();
    const publicReference = `PC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO submissions (
          id, event_id, form_version_id, submitter_person_id, submitter_email,
          public_reference, title, status, answers_json, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'Untitled application', 'draft', '{}', 1, unixepoch(), unixepoch())
      `,
      ).bind(
        id,
        form.eventId,
        form.version.id,
        applicant.personId,
        applicant.email,
        publicReference,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO submission_speakers (
          id, event_id, submission_id, person_id, email, display_name, position,
          invitation_status, is_primary, claimed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'claimed', 1, unixepoch(), unixepoch(), unixepoch())
      `,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        id,
        applicant.personId,
        applicant.email,
        applicant.name,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO submission_revisions (
          id, event_id, submission_id, form_version_id, revision_number, answers_json,
          speaker_snapshot_json, save_kind, saved_by_person_id, created_at
        ) VALUES (?, ?, ?, ?, 1, '{}', ?, 'manual', ?, unixepoch())
      `,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        id,
        form.version.id,
        JSON.stringify([
          { name: applicant.name, email: applicant.email, isPrimary: true },
        ]),
        applicant.personId,
      ),
    ]);
    return id;
  }

  async saveDraft(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    payload: DraftPayload,
  ) {
    const operationId = crypto.randomUUID();
    const nextRevision = payload.revision + 1;
    const title =
      String(payload.answers.title || "Untitled application").trim() ||
      "Untitled application";
    const category = String(payload.answers.category || "").trim() || null;
    const format = String(payload.answers.format || "").trim() || null;
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE submissions
           SET title = ?, category = ?, format = ?, answers_json = ?, revision = revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND submitter_person_id = ? AND form_version_id = ?
           AND status = 'draft' AND revision = ?
      `,
      ).bind(
        title,
        category,
        format,
        JSON.stringify(payload.answers),
        operationId,
        payload.submissionId,
        form.eventId,
        applicant.personId,
        form.version.id,
        payload.revision,
      ),
    ];
    // Move existing positions out of the unique range before the email-keyed
    // upserts below. This preserves a co-speaker's claimed identity/status
    // across subsequent submitter saves, including case-only email changes.
    statements.push(
      this.env.DB.prepare(
        `
      UPDATE submission_speakers SET position = position + 10000, updated_at = unixepoch()
       WHERE submission_id = ?
         AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
    `,
      ).bind(payload.submissionId, payload.submissionId, operationId),
    );
    payload.speakers.forEach((speaker, position) => {
      statements.push(
        this.env.DB.prepare(
          `
        INSERT INTO submission_speakers (
          id, event_id, submission_id, person_id, email, display_name, position,
          invitation_status, is_primary, invited_at, claimed_at, created_at, updated_at
        )
        SELECT ?, ?, ?, CASE WHEN ? = ? COLLATE NOCASE THEN ? ELSE NULL END, ?, ?, ?,
               CASE WHEN ? = ? COLLATE NOCASE THEN 'claimed' ELSE 'pending' END, ?,
               CASE WHEN ? = ? COLLATE NOCASE THEN NULL ELSE unixepoch() END,
               CASE WHEN ? = ? COLLATE NOCASE THEN unixepoch() ELSE NULL END,
               unixepoch(), unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
        ON CONFLICT(submission_id, email) DO UPDATE SET
          person_id = CASE
            WHEN submission_speakers.invitation_status = 'claimed' THEN submission_speakers.person_id
            ELSE excluded.person_id
          END,
          display_name = excluded.display_name,
          position = excluded.position,
          invitation_status = CASE
            WHEN submission_speakers.invitation_status = 'claimed' THEN 'claimed'
            ELSE excluded.invitation_status
          END,
          is_primary = excluded.is_primary,
          invited_at = CASE
            WHEN submission_speakers.invitation_status = 'claimed' THEN submission_speakers.invited_at
            ELSE COALESCE(submission_speakers.invited_at, excluded.invited_at)
          END,
          claimed_at = CASE
            WHEN submission_speakers.invitation_status = 'claimed' THEN submission_speakers.claimed_at
            ELSE excluded.claimed_at
          END,
          updated_at = unixepoch()
      `,
        ).bind(
          crypto.randomUUID(),
          form.eventId,
          payload.submissionId,
          speaker.email,
          applicant.email,
          applicant.personId,
          speaker.email,
          speaker.name,
          position,
          speaker.email,
          applicant.email,
          position === 0 ? 1 : 0,
          speaker.email,
          applicant.email,
          speaker.email,
          applicant.email,
          payload.submissionId,
          operationId,
        ),
      );
    });
    statements.push(
      this.env.DB.prepare(
        `
      DELETE FROM submission_speakers
       WHERE submission_id = ?
         AND lower(email) NOT IN (
           SELECT lower(json_extract(value, '$.email')) FROM json_each(?)
         )
         AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
    `,
      ).bind(
        payload.submissionId,
        JSON.stringify(payload.speakers),
        payload.submissionId,
        operationId,
      ),
    );
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO submission_revisions (
        id, event_id, submission_id, form_version_id, revision_number, answers_json,
        speaker_snapshot_json, save_kind, saved_by_person_id, idempotency_key, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, unixepoch()
       WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
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
    );
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, action, entity_type,
        entity_id, metadata_json, created_at
      )
      SELECT ?, event.organisation_id, ?, ?, 'submission.draft.saved',
             'submission', ?, ?, unixepoch()
        FROM events event
       WHERE event.id = ?
         AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
    `,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        applicant.personId,
        payload.submissionId,
        JSON.stringify({
          speakerCount: payload.speakers.length,
          revision: nextRevision,
        }),
        form.eventId,
        payload.submissionId,
        operationId,
      ),
    );

    const results = await this.env.DB.batch(statements);
    if ((results[0].meta.changes ?? 0) !== 1)
      throw new SubmissionRevisionConflictError();
    return nextRevision;
  }

  async submitDraft(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    payload: DraftPayload,
  ) {
    const revision = await this.saveDraft(form, applicant, payload);
    const operationId = crypto.randomUUID();
    const confirmationOperationId = crypto.randomUUID();
    const confirmationCommunicationId = crypto.randomUUID();
    const confirmationIdempotencyKey = `submission-confirmation:${payload.submissionId}`;
    const event = await this.env.DB.prepare(
      `
      SELECT organisation_id AS organisationId FROM events WHERE id = ?
    `,
    )
      .bind(form.eventId)
      .first<{ organisationId: string }>();
    if (!event)
      throw new SubmissionStateError("The submission event is unavailable.");
    const confirmationMessage = {
      type: "submission.notification" as const,
      operationId: confirmationOperationId,
      communicationId: confirmationCommunicationId,
      submissionId: payload.submissionId,
      eventId: form.eventId,
      organisationId: event.organisationId,
      idempotencyKey: confirmationIdempotencyKey,
    };
    const nextRevision = revision + 1;
    const submissionSnapshot = JSON.stringify({
      formVersionId: form.version.id,
      versionNumber: form.version.versionNumber,
      schema: form.version.schema,
      answers: payload.answers,
      speakers: payload.speakers,
    });
    const [result] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE submissions
           SET status = 'submitted', submitted_snapshot_json = ?, revision = revision + 1,
               last_operation_id = ?, submitted_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND submitter_person_id = ? AND form_version_id = ?
           AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM form_definitions current_form
              WHERE current_form.id = ? AND current_form.event_id = ?
                AND current_form.status = 'published'
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
           )
      `,
      ).bind(
        submissionSnapshot,
        operationId,
        payload.submissionId,
        form.eventId,
        applicant.personId,
        form.version.id,
        revision,
        form.id,
        form.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO submission_revisions (
          id, event_id, submission_id, form_version_id, revision_number, answers_json,
          speaker_snapshot_json, save_kind, saved_by_person_id, idempotency_key, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ? AND status = 'submitted')
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
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type,
          entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'submission.submitted', 'submission', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ? AND status = 'submitted')
      `,
      ).bind(
        crypto.randomUUID(),
        event.organisationId,
        form.eventId,
        applicant.personId,
        payload.submissionId,
        JSON.stringify({
          formVersionId: form.version.id,
          version: form.version.versionNumber,
        }),
        payload.submissionId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO communications (
          id, event_id, operation_id, idempotency_key, kind, channel, status, audience_json,
          content_snapshot_json, recipient_count, queued_at, created_by_person_id, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'transactional', 'email', 'queued', ?, ?, 1, unixepoch(), ?, unixepoch(), unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ? AND status = 'submitted')
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
        }),
        applicant.personId,
        payload.submissionId,
        operationId,
      ),
      this.env.DB.prepare(
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
    ]);
    if ((result.meta.changes ?? 0) !== 1) {
      throw new SubmissionDraftSavedError(
        "Applications closed or reached their limit before final submission. Your latest changes were saved as a draft.",
        payload.submissionId,
        revision,
      );
    }
    try {
      if (!this.env.OPERATIONS_QUEUE)
        throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
      await this.env.OPERATIONS_QUEUE.send(confirmationMessage);
      return {
        submissionId: payload.submissionId,
        eventId: form.eventId,
        organisationId: event.organisationId,
        confirmation: {
          status: "queued" as const,
          communicationId: confirmationCommunicationId,
          operationId: confirmationOperationId,
        },
      };
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 2_000);
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
        ).bind(message, confirmationOperationId, form.eventId),
        this.env.DB.prepare(
          `UPDATE communications SET status = 'failed', updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
        ).bind(confirmationCommunicationId, form.eventId),
      ]);
      return {
        submissionId: payload.submissionId,
        eventId: form.eventId,
        organisationId: event.organisationId,
        confirmation: {
          status: "queue_failed" as const,
          communicationId: confirmationCommunicationId,
          operationId: confirmationOperationId,
          message,
        },
      };
    }
  }
}
