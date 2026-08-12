import { materializePublishedResourceAcknowledgementsForClaimedSpeaker } from "~/modules/resources/resource-service-shared";
import type { PreparedApplicantSession } from "./applicant-session.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type Applicant,
  type CoSpeakerInvitation,
} from "./submission-repository-shared";

export class SubmissionCoSpeakerRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

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
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role,
          invited_at, invitation_expires_at, accepted_at, revoked_at,
          last_operation_id, created_at
        )
        SELECT ?, event.organisation_id, speaker.event_id, ?, 'submitter',
               unixepoch(), NULL, unixepoch(), NULL, ?, unixepoch()
          FROM submission_speakers speaker
          JOIN events event ON event.id = speaker.event_id
         WHERE speaker.id = ? AND speaker.person_id = ?
           AND speaker.invitation_status = 'claimed'
           AND event.last_operation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM memberships membership
              WHERE membership.event_id = speaker.event_id
                AND membership.person_id = speaker.person_id
                AND membership.role = 'speaker'
                AND membership.accepted_at IS NOT NULL
                AND membership.revoked_at IS NULL
           )
        ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
        DO UPDATE SET invited_at = unixepoch(), invitation_expires_at = NULL,
                      accepted_at = unixepoch(), revoked_at = NULL,
                      last_operation_id = excluded.last_operation_id
         WHERE memberships.organisation_id = excluded.organisation_id
           AND (memberships.revoked_at IS NOT NULL
                OR memberships.accepted_at IS NULL)
      `,
      ).bind(
        crypto.randomUUID(),
        applicant.personId,
        operationId,
        invitationId,
        applicant.personId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label,
          participation_status, participation_confirmed_at, visibility
        )
        SELECT session.id, session.event_id, speaker.person_id,
               COALESCE((
                 SELECT MAX(existing.position) + 1
                   FROM session_speakers existing
                  WHERE existing.session_id = session.id
               ), 0),
               CASE WHEN speaker.is_primary = 1 THEN 'Primary speaker' ELSE 'Co-speaker' END,
               'confirmed', unixepoch(), 'public'
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
      this.env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, invitation_expires_at, accepted_at, revoked_at,
           last_operation_id, created_at
         )
         SELECT ?, event.organisation_id, speaker.event_id, speaker.person_id,
                'speaker', unixepoch(), NULL, unixepoch(), NULL, ?, unixepoch()
           FROM submission_speakers speaker
           JOIN events event ON event.id = speaker.event_id
          WHERE speaker.id = ? AND speaker.person_id = ?
            AND speaker.invitation_status = 'claimed'
            AND event.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM sessions session
              JOIN session_speakers relationship
                ON relationship.session_id = session.id
               AND relationship.event_id = session.event_id
               AND relationship.person_id = speaker.person_id
             WHERE session.source_submission_id = speaker.submission_id
               AND session.event_id = speaker.event_id
               AND session.status <> 'published'
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
        operationId,
        invitationId,
        applicant.personId,
        operationId,
      ),
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
}
