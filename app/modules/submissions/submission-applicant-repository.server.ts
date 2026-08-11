import { materializePublishedResourceAcknowledgementsForClaimedSpeaker } from "~/modules/resources/resource-service.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import type { PreparedApplicantSession } from "./applicant-session.server";
import { SubmissionDraftFinalizer } from "./submission-draft-finalizer.server";
import {
  mapVersion,
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type Applicant,
  type ApplicantDraft,
  type CoSpeakerInvitation,
  type FormSummary,
  type FormVersion,
  type VersionRow,
} from "./submission-repository-shared";
import {
  speakerInputSchema,
  submittedSnapshotSchema,
  type DraftPayload,
} from "./submission-schema";

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
             s.submitted_at AS submittedAt, s.submitted_snapshot_json AS submittedSnapshotJson,
             (SELECT revision.speaker_snapshot_json
                FROM submission_revisions revision
               WHERE revision.submission_id = s.id
               ORDER BY revision.revision_number DESC LIMIT 1) AS speakerSnapshotJson
        FROM submissions s
        JOIN form_versions fv ON fv.id = s.form_version_id AND fv.form_id = ?
       WHERE (
         (? IS NOT NULL AND s.submitter_person_id = ?)
         OR
         (? IS NOT NULL AND s.id = ? AND s.submitter_person_id IS NULL AND s.submitter_email IS NULL)
       )
       ORDER BY s.updated_at DESC
    `,
    )
      .bind(
        formId,
        applicant.personId,
        applicant.personId,
        applicant.anonymousDraftId,
        applicant.anonymousDraftId,
      )
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
        submittedSnapshotJson: string | null;
        speakerSnapshotJson: string | null;
      }>();

    return Promise.all(
      rows.results.map(async (row) => {
        if (row.speakerSnapshotJson === null) {
          throw new Error(
            `Submission ${row.id} is missing its speaker revision snapshot.`,
          );
        }
        const snapshot = speakerInputSchema
          .array()
          .safeParse(JSON.parse(row.speakerSnapshotJson));
        if (!snapshot.success) {
          throw new Error(
            `Submission ${row.id} has an invalid speaker revision snapshot.`,
          );
        }
        const biographies = new Map(
          snapshot.data.map((speaker) => [
            speaker.email.toLowerCase(),
            speaker.biography,
          ]),
        );
        const speakerRows = await this.env.DB.prepare(
          `
        SELECT ss.person_id AS personId, ss.display_name AS name, ss.email, ss.position,
               ss.is_primary AS isPrimary, ss.invitation_status AS invitationStatus,
               COALESCE(person.biography, '') AS claimedBiography
          FROM submission_speakers ss
          LEFT JOIN people person ON person.id = ss.person_id
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
            claimedBiography: string;
          }>();
        let uploads = {};
        if (row.submittedSnapshotJson) {
          const submittedSnapshot = submittedSnapshotSchema.parse(
            JSON.parse(row.submittedSnapshotJson),
          );
          uploads = submittedSnapshot.uploads;
        }
        const {
          answersJson,
          speakerSnapshotJson: _speakerSnapshotJson,
          submittedSnapshotJson: _submittedSnapshotJson,
          ...summary
        } = row;
        return {
          ...summary,
          answers: JSON.parse(answersJson) as Record<string, string | string[]>,
          uploads,
          speakers: speakerRows.results.map(
            ({ claimedBiography, ...speaker }) => ({
              ...speaker,
              biography:
                !speaker.isPrimary && speaker.invitationStatus === "claimed"
                  ? claimedBiography
                  : (biographies.get(speaker.email.toLowerCase()) ?? ""),
              isPrimary: Boolean(speaker.isPrimary),
            }),
          ),
        };
      }),
    );
  }

  async getCoSpeakerInvitations(
    formId: string,
    applicant: Applicant,
  ): Promise<CoSpeakerInvitation[]> {
    if (!applicant.verified) return [];
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
    expectedClaimTokenHash: string | null = null,
    sessionPersistence: PreparedApplicantSession["persistence"] | null = null,
    proposedBiography: string | null = null,
  ) {
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before claiming a co-speaker invitation.",
      );
    }
    if (
      sessionPersistence &&
      sessionPersistence.personId !== applicant.personId
    ) {
      throw new Error(
        "A co-speaker session must belong to the claimed applicant identity.",
      );
    }
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
    const statements: D1PreparedStatement[] = [
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
              AND (? IS NULL OR speaker.claim_token_hash = ?)
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
      ).bind(
        operationId,
        invitationId,
        applicant.email,
        expectedClaimTokenHash,
        expectedClaimTokenHash,
        formId,
        invitationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submission_speakers
           SET person_id = ?, invitation_status = 'claimed', claim_token_hash = NULL,
               invitation_expires_at = NULL, claimed_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ? AND email = ? COLLATE NOCASE AND invitation_status IN ('pending', 'sent')
           AND (? IS NULL OR claim_token_hash = ?)
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
        expectedClaimTokenHash,
        expectedClaimTokenHash,
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
    ];
    const sessionCreatedIndex = sessionPersistence ? statements.length : null;
    if (sessionPersistence) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO verification_tokens (
             id, identifier, value, expires_at, created_at, updated_at
           ) SELECT ?, ?, ?, unixepoch() + 1209600, unixepoch(), unixepoch()
               WHERE EXISTS (
                 SELECT 1 FROM submission_speakers speaker
                 JOIN events event ON event.id = speaker.event_id
                  WHERE speaker.id = ? AND speaker.event_id = ?
                    AND speaker.person_id = ?
                    AND speaker.invitation_status = 'claimed'
                    AND event.last_operation_id = ?
               )`,
        ).bind(
          sessionPersistence.sessionId,
          sessionPersistence.identifier,
          sessionPersistence.sessionHash,
          invitationId,
          invitation.eventId,
          applicant.personId,
          operationId,
        ),
        this.env.DB.prepare(
          `DELETE FROM verification_tokens
            WHERE identifier = ? AND id <> ?
              AND EXISTS (
                SELECT 1 FROM verification_tokens
                 WHERE id = ? AND identifier = ?
              )`,
        ).bind(
          sessionPersistence.identifier,
          sessionPersistence.sessionId,
          sessionPersistence.sessionId,
          sessionPersistence.identifier,
        ),
        this.env.DB.prepare(
          `UPDATE people
              SET email_verified = 1,
                  biography = CASE
                    WHEN (biography IS NULL OR trim(biography) = '')
                      AND ? IS NOT NULL AND trim(?) <> ''
                    THEN ? ELSE biography END,
                  updated_at = unixepoch()
            WHERE id = ?
              AND EXISTS (
                SELECT 1 FROM verification_tokens
                 WHERE id = ? AND identifier = ?
              )`,
        ).bind(
          proposedBiography,
          proposedBiography,
          proposedBiography,
          applicant.personId,
          sessionPersistence.sessionId,
          sessionPersistence.identifier,
        ),
      );
    }
    const results = await this.env.DB.batch(statements);
    const [eventClaimed, speakerClaimed] = results;
    if (
      (eventClaimed.meta.changes ?? 0) !== 1 ||
      (speakerClaimed.meta.changes ?? 0) !== 1 ||
      (sessionCreatedIndex !== null &&
        (results[sessionCreatedIndex]?.meta.changes ?? 0) !== 1)
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
       WHERE s.id = ? AND s.event_id = ?
         AND (
           (? IS NOT NULL AND s.submitter_person_id = ?)
           OR
           (? IS NOT NULL AND s.id = ? AND s.submitter_person_id IS NULL AND s.submitter_email IS NULL)
         )
       LIMIT 1
    `,
    )
      .bind(
        publicForm.id,
        submissionId,
        publicForm.eventId,
        applicant.personId,
        applicant.personId,
        applicant.anonymousDraftId,
        applicant.anonymousDraftId,
      )
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

  async findDraftCreationReplay(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    draftId: string,
  ) {
    if (!applicant.verified && applicant.anonymousDraftId !== draftId) {
      return null;
    }
    return this.env.DB.prepare(
      `SELECT submission.id
         FROM submissions submission
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
        WHERE submission.id = ? AND submission.event_id = ?
          AND submission.status = 'draft' AND version.form_id = ?
          AND (
            (? IS NOT NULL AND submission.submitter_person_id = ?)
            OR
            (? IS NOT NULL AND submission.id = ?
              AND submission.submitter_person_id IS NULL
              AND submission.submitter_email IS NULL)
          )`,
    )
      .bind(
        draftId,
        form.eventId,
        form.id,
        applicant.personId,
        applicant.personId,
        applicant.anonymousDraftId,
        applicant.anonymousDraftId,
      )
      .first<{ id: string }>();
  }

  async createDraft(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    requestedId?: string,
  ) {
    const id = requestedId ?? crypto.randomUUID();
    if (!applicant.verified && applicant.anonymousDraftId !== id) {
      throw new SubmissionStateError(
        "The anonymous draft session does not own this draft identifier.",
      );
    }
    if (requestedId) {
      const replay = await this.findDraftCreationReplay(form, applicant, id);
      if (replay) return replay.id;
      const occupied = await this.env.DB.prepare(
        "SELECT 1 FROM submissions WHERE id = ? LIMIT 1",
      )
        .bind(id)
        .first();
      if (occupied) {
        throw new SubmissionStateError(
          "The application created for this intent is no longer an owned draft.",
        );
      }
    }
    const publicReference = `PC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const event = await this.env.DB.prepare(
      "SELECT organisation_id AS organisationId FROM events WHERE id = ?",
    )
      .bind(form.eventId)
      .first<{ organisationId: string }>();
    if (!event)
      throw new SubmissionStateError("The submission event is unavailable.");
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      {
        organisationId: event.organisationId,
        eventId: form.eventId,
        personId: applicant.personId,
      },
      {
        eventType: "submission.created",
        entityType: "submission",
        entityId: id,
        idempotencyKey: `submission.created:${id}`,
        correlationId: id,
        data: {
          source: "public_application_form",
          status: "draft",
          anonymous: !applicant.verified,
        },
      },
      auditEventId,
    );
    let created: D1Result<unknown>;
    try {
      [created] = await this.env.DB.batch([
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
          applicant.verified ? applicant.email : null,
          publicReference,
        ),
        this.env.DB.prepare(
          `
        INSERT INTO submission_speakers (
          id, event_id, submission_id, person_id, email, display_name, position,
          invitation_status, is_primary, claimed_at, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, 0, 'claimed', 1, unixepoch(), unixepoch(), unixepoch()
          WHERE ? IS NOT NULL
      `,
        ).bind(
          crypto.randomUUID(),
          form.eventId,
          id,
          applicant.personId,
          applicant.email,
          applicant.name,
          applicant.personId,
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
          JSON.stringify(
            applicant.verified
              ? [
                  {
                    name: applicant.name,
                    email: applicant.email,
                    biography: applicant.biography,
                    isPrimary: true,
                  },
                ]
              : [],
          ),
          applicant.personId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'submission.draft.created', 'submission', ?, ?, unixepoch()
            WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND event_id = ?)`,
        ).bind(
          auditEventId,
          event.organisationId,
          form.eventId,
          applicant.personId,
          id,
          JSON.stringify({ anonymous: !applicant.verified }),
          id,
          form.eventId,
        ),
        ...preparedWebhook.statements,
      ]);
    } catch (error) {
      if (requestedId) {
        const replay = await this.findDraftCreationReplay(form, applicant, id);
        if (replay) return replay.id;
      }
      throw error;
    }
    if ((created.meta.changes ?? 0) !== 1) {
      if (requestedId) {
        const replay = await this.findDraftCreationReplay(form, applicant, id);
        if (replay) return replay.id;
      }
      throw new SubmissionStateError(
        "The application draft could not be created for this intent.",
      );
    }
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return id;
  }

  async saveDraft(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    payload: DraftPayload,
    command: { operationId: string } | null = null,
  ) {
    const operationId = command?.operationId ?? crypto.randomUUID();
    const nextRevision = payload.revision + 1;
    const title =
      String(payload.answers.title || "Untitled application").trim() ||
      "Untitled application";
    const categoryAnswer = payload.answers.category;
    const category = Array.isArray(categoryAnswer)
      ? String(categoryAnswer[0] ?? "").trim() || null
      : String(categoryAnswer || "").trim() || null;
    const format = String(payload.answers.format || "").trim() || null;
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE submissions
           SET title = ?, category = ?, format = ?, answers_json = ?, revision = revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND form_version_id = ?
           AND status = 'draft' AND revision = ?
           AND (
             (? IS NOT NULL AND submitter_person_id = ?)
             OR
             (? IS NOT NULL AND id = ? AND submitter_person_id IS NULL AND submitter_email IS NULL)
           )
           AND NOT EXISTS (
             SELECT 1 FROM submission_speakers claimed
              WHERE claimed.submission_id = submissions.id
                AND claimed.invitation_status = 'claimed'
                AND claimed.is_primary = 0
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(?) requested
                   WHERE lower(json_extract(requested.value, '$.email')) = lower(claimed.email)
                     AND CAST(requested.key AS INTEGER) = claimed.position
                     AND json_extract(requested.value, '$.name') = claimed.display_name
                     AND COALESCE(json_extract(requested.value, '$.biography'), '') =
                         COALESCE((SELECT biography FROM people WHERE id = claimed.person_id), '')
                )
           )
      `,
      ).bind(
        title,
        category,
        format,
        JSON.stringify(payload.answers),
        operationId,
        payload.submissionId,
        form.eventId,
        form.version.id,
        payload.revision,
        applicant.personId,
        applicant.personId,
        applicant.anonymousDraftId,
        applicant.anonymousDraftId,
        JSON.stringify(payload.speakers),
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
               CASE WHEN ? IS NOT NULL AND ? = ? COLLATE NOCASE THEN 'claimed' ELSE 'pending' END, ?,
               NULL,
               CASE WHEN ? = ? COLLATE NOCASE THEN unixepoch() ELSE NULL END,
               unixepoch(), unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
        ON CONFLICT(submission_id, email) DO UPDATE SET
          person_id = CASE
            WHEN submission_speakers.invitation_status = 'claimed' THEN submission_speakers.person_id
            ELSE excluded.person_id
          END,
          display_name = CASE
            WHEN submission_speakers.invitation_status = 'claimed'
             AND submission_speakers.is_primary = 0
              THEN submission_speakers.display_name
            ELSE excluded.display_name
          END,
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
          applicant.personId,
          speaker.email,
          applicant.email,
          position === 0 ? 1 : 0,
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

  async withdrawSubmission(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    submissionId: string,
    expectedRevision: number,
    command: { operationId: string } | null = null,
  ) {
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before withdrawing this application.",
      );
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new SubmissionRevisionConflictError();
    }
    const event = await this.env.DB.prepare(
      `SELECT organisation_id AS organisationId FROM events WHERE id = ?`,
    )
      .bind(form.eventId)
      .first<{ organisationId: string }>();
    if (!event) {
      throw new SubmissionStateError("The submission event is unavailable.");
    }
    const operationId = command?.operationId ?? crypto.randomUUID();
    const nextRevision = expectedRevision + 1;
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      {
        organisationId: event.organisationId,
        eventId: form.eventId,
        personId: applicant.personId,
      },
      {
        eventType: "submission.withdrawn",
        entityType: "submission",
        entityId: submissionId,
        idempotencyKey: `submission.withdrawn:${submissionId}`,
        correlationId: operationId,
        data: { status: "withdrawn", revision: nextRevision },
      },
      auditEventId,
    );
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE submissions
            SET status = 'withdrawn', revision = revision + 1,
                last_operation_id = ?, withdrawn_at = unixepoch(),
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND submitter_person_id = ?
            AND revision = ? AND status IN ('submitted','assigned')
            AND EXISTS (
              SELECT 1 FROM form_versions version
               WHERE version.id = submissions.form_version_id
                 AND version.event_id = submissions.event_id
                 AND version.form_id = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM evaluator_assignments assignment
               WHERE assignment.event_id = submissions.event_id
                 AND assignment.submission_id = submissions.id
                 AND assignment.status <> 'assigned'
            )`,
      ).bind(
        operationId,
        submissionId,
        form.eventId,
        applicant.personId,
        expectedRevision,
        form.id,
      ),
      this.env.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'cancelled', revision = revision + 1,
                last_operation_id = ?
          WHERE submission_id = ? AND event_id = ? AND status = 'assigned'
            AND EXISTS (
              SELECT 1 FROM submissions
               WHERE id = ? AND event_id = ? AND status = 'withdrawn'
                 AND last_operation_id = ?
            )`,
      ).bind(
        operationId,
        submissionId,
        form.eventId,
        submissionId,
        form.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, event.organisation_id, submission.event_id, ?,
                'evaluation.assignments.cancelled_by_withdrawal',
                'submission', submission.id, ?,
                json_object('assignmentCount', (
                  SELECT COUNT(*) FROM evaluator_assignments assignment
                   WHERE assignment.event_id = submission.event_id
                     AND assignment.submission_id = submission.id
                     AND assignment.status = 'cancelled'
                     AND assignment.last_operation_id = ?
                )), unixepoch()
           FROM submissions submission
           JOIN events event ON event.id = submission.event_id
          WHERE submission.id = ? AND submission.event_id = ?
            AND submission.status = 'withdrawn'
            AND submission.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM evaluator_assignments assignment
               WHERE assignment.event_id = submission.event_id
                 AND assignment.submission_id = submission.id
                 AND assignment.status = 'cancelled'
                 AND assignment.last_operation_id = ?
            )`,
      ).bind(
        crypto.randomUUID(),
        applicant.personId,
        operationId,
        operationId,
        submissionId,
        form.eventId,
        operationId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO submission_revisions (
           id, event_id, submission_id, form_version_id, revision_number,
           answers_json, speaker_snapshot_json, save_kind,
           saved_by_person_id, idempotency_key, created_at
         )
         SELECT ?, submission.event_id, submission.id,
                submission.form_version_id, ?, submission.answers_json,
                COALESCE((
                  SELECT revision.speaker_snapshot_json
                    FROM submission_revisions revision
                   WHERE revision.submission_id = submission.id
                     AND revision.event_id = submission.event_id
                   ORDER BY revision.revision_number DESC LIMIT 1
                ), '[]'),
                'withdrawn', ?, ?, unixepoch()
           FROM submissions submission
          WHERE submission.id = ? AND submission.event_id = ?
            AND submission.status = 'withdrawn'
            AND submission.last_operation_id = ?`,
      ).bind(
        crypto.randomUUID(),
        nextRevision,
        applicant.personId,
        operationId,
        submissionId,
        form.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, event.organisation_id, submission.event_id, ?,
                'submission.withdrawn', 'submission', submission.id, ?, ?,
                unixepoch()
           FROM submissions submission
           JOIN events event ON event.id = submission.event_id
          WHERE submission.id = ? AND submission.event_id = ?
            AND submission.status = 'withdrawn'
            AND submission.last_operation_id = ?`,
      ).bind(
        auditEventId,
        applicant.personId,
        operationId,
        JSON.stringify({ revision: nextRevision }),
        submissionId,
        form.eventId,
        operationId,
      ),
      ...preparedWebhook.statements,
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const current = await this.env.DB.prepare(
        `SELECT submission.revision, submission.status
           FROM submissions submission
           JOIN form_versions version
             ON version.id = submission.form_version_id
            AND version.event_id = submission.event_id
          WHERE submission.id = ? AND submission.event_id = ?
            AND submission.submitter_person_id = ? AND version.form_id = ?`,
      )
        .bind(submissionId, form.eventId, applicant.personId, form.id)
        .first<{ revision: number; status: string }>();
      if (!current) {
        throw new Response("Application not found", { status: 404 });
      }
      if (
        current.status === "withdrawn" &&
        current.revision === expectedRevision + 1
      ) {
        return {
          submissionId,
          organisationId: event.organisationId,
          eventId: form.eventId,
          revision: current.revision,
        };
      }
      if (current.revision !== expectedRevision) {
        throw new SubmissionRevisionConflictError();
      }
      throw new SubmissionStateError(
        "Only a submitted application with no review in progress can be withdrawn.",
      );
    }
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return {
      submissionId,
      organisationId: event.organisationId,
      eventId: form.eventId,
      revision: nextRevision,
    };
  }

  async submitDraft(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    payload: DraftPayload,
    options: {
      trackSelections: Array<{ trackId: string; trackName: string }>;
      routedTeamIds: string[];
      routingAssignment?: {
        roundId: string;
        teamIds: string[];
        assignments: Array<{
          teamId: string;
          evaluatorPersonId: string;
        }>;
      } | null;
      upload?: { fieldId: string; assetId: string; versionId: string } | null;
      operationId?: string;
    },
  ) {
    return new SubmissionDraftFinalizer(
      this.env,
      this.saveDraft.bind(this),
    ).submitDraft(form, applicant, payload, options);
  }
}
