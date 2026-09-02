import { requireValue } from "~/lib/required-value";
import {
  acceptanceTaskPlanGuardSql,
  buildAcceptanceTaskPlanStatements,
} from "~/modules/evaluations/evaluation-decision-statements.server";
import { materializePublishedResourceAcknowledgementsForClaimedSpeaker } from "~/modules/resources/resource-service-shared";
import { scheduleDraftConflictRebuildStatements } from "~/modules/schedule/schedule-conflict-statement.server";
import { ScheduleConfigurationError } from "~/modules/schedule/schedule-errors";
import type { ScheduleWorkspace } from "~/modules/schedule/schedule-service.server";
import {
  detectWorkspaceConflicts,
  loadScheduleWorkspaceD1,
  withAddedSessionSpeaker,
} from "~/modules/schedule/schedule-workspace.server";
import type { PreparedApplicantSession } from "./applicant-session.server";
import {
  buildAcceptedClaimPropagationAuditStatement,
  buildAcceptedDirectClaimPropagationAuditStatement,
  unscheduledClaimDraftEntryGuards,
} from "./submission-co-speaker-claim-statements.server";
import {
  type Applicant,
  type CoSpeakerInvitation,
  SubmissionStateError,
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
         AND (ss.invitation_expires_at IS NULL OR ss.invitation_expires_at > unixepoch())
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
      SELECT speaker.event_id AS eventId,
             event.organisation_id AS organisationId,
             speaker.submission_id AS submissionId,
             submission.status AS submissionStatus,
             form.kind AS formKind,
             (SELECT COUNT(*) FROM sessions session
               WHERE session.source_submission_id = speaker.submission_id
                 AND session.event_id = speaker.event_id
             ) AS derivedSessionCount,
             (SELECT session.id FROM sessions session
               WHERE session.source_submission_id = speaker.submission_id
                 AND session.event_id = speaker.event_id
               ORDER BY session.id LIMIT 1
             ) AS sessionId,
             (SELECT session.status FROM sessions session
               WHERE session.source_submission_id = speaker.submission_id
                 AND session.event_id = speaker.event_id
               ORDER BY session.id LIMIT 1
             ) AS sessionStatus,
             (SELECT COUNT(*) FROM submission_decisions decision
               WHERE decision.submission_id = speaker.submission_id
                 AND decision.event_id = speaker.event_id
                 AND decision.status = 'published'
                 AND decision.decision = 'accepted'
             ) AS acceptanceDecisionCount,
             (SELECT decision.id FROM submission_decisions decision
               WHERE decision.submission_id = speaker.submission_id
                 AND decision.event_id = speaker.event_id
                 AND decision.status = 'published'
                 AND decision.decision = 'accepted'
               ORDER BY decision.published_at DESC, decision.id DESC LIMIT 1
             ) AS acceptanceDecisionId,
             speaker.invitation_status AS invitationStatus,
             speaker.invitation_expires_at AS invitationExpiresAt
        FROM submission_speakers speaker
        JOIN submissions submission
          ON submission.id = speaker.submission_id
         AND submission.event_id = speaker.event_id
        JOIN events event ON event.id = speaker.event_id
        JOIN form_versions version
          ON version.id = submission.form_version_id
         AND version.event_id = submission.event_id
        JOIN form_definitions form
          ON form.id = version.form_id
         AND form.event_id = version.event_id
       WHERE speaker.id = ? AND speaker.email = ? COLLATE NOCASE
         AND version.form_id = ?
    `,
    )
      .bind(invitationId, applicant.email, formId)
      .first<{
        eventId: string;
        organisationId: string;
        submissionId: string;
        submissionStatus: string;
        formKind: "submission" | "direct_session";
        derivedSessionCount: number;
        sessionId: string | null;
        sessionStatus: string | null;
        acceptanceDecisionCount: number;
        acceptanceDecisionId: string | null;
        invitationStatus: string;
        invitationExpiresAt: number | null;
      }>();
    if (!invitation) {
      throw new SubmissionStateError(
        "This co-speaker invitation is no longer available.",
      );
    }
    if (
      invitation.invitationStatus !== "pending" &&
      invitation.invitationStatus !== "sent"
    ) {
      throw new SubmissionStateError(
        "This co-speaker invitation is no longer available.",
      );
    }
    if (
      invitation.invitationExpiresAt !== null &&
      invitation.invitationExpiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      throw new SubmissionStateError("This co-speaker invitation has expired.");
    }
    const acceptedClaim = invitation.submissionStatus === "accepted";
    if (acceptedClaim && invitation.derivedSessionCount !== 1) {
      throw new SubmissionStateError(
        "This accepted application must have exactly one derived session before its co-speaker invitation can be claimed.",
      );
    }
    if (
      acceptedClaim &&
      invitation.sessionStatus !== "unscheduled" &&
      invitation.sessionStatus !== "scheduled"
    ) {
      throw new SubmissionStateError(
        "This accepted session is not editable, so its speaker list is locked. Contact an administrator to resolve this invitation.",
      );
    }
    const acceptedTaskClaim =
      acceptedClaim && invitation.formKind === "submission";
    if (
      acceptedTaskClaim &&
      (invitation.acceptanceDecisionCount !== 1 ||
        !invitation.acceptanceDecisionId ||
        !invitation.sessionId)
    ) {
      throw new SubmissionStateError(
        "This accepted application is missing its published acceptance plan.",
      );
    }
    const operationId = crypto.randomUUID();
    const draftRebuild = await this.draftConflictRebuildForClaim({
      organisationId: invitation.organisationId,
      eventId: invitation.eventId,
      sessionId: acceptedClaim ? invitation.sessionId : null,
      personId: requireValue(
        applicant.personId,
        "A verified co-speaker identity is required to claim this invitation.",
      ),
      personName: applicant.name,
      operationId,
    });
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
              AND (speaker.invitation_expires_at IS NULL
                   OR speaker.invitation_expires_at > unixepoch())
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
           AND NOT EXISTS (
             SELECT 1
               FROM submission_speakers speaker
               JOIN submissions submissions
                 ON submissions.id = speaker.submission_id
                AND submissions.event_id = speaker.event_id
              WHERE speaker.id = ? AND speaker.event_id = events.id
                AND submissions.status = 'accepted'
                AND (
                  1 <> (
                    SELECT COUNT(*) FROM sessions session
                     WHERE session.source_submission_id = speaker.submission_id
                       AND session.event_id = speaker.event_id
                  )
                  OR NOT EXISTS (
                    SELECT 1 FROM sessions session
                     WHERE session.source_submission_id = speaker.submission_id
                       AND session.event_id = speaker.event_id
                       AND session.status IN ('unscheduled','scheduled')
                  )
                  OR (
                    EXISTS (
                      SELECT 1 FROM form_versions version
                      JOIN form_definitions form
                        ON form.id = version.form_id
                       AND form.event_id = version.event_id
                       WHERE version.id = submissions.form_version_id
                         AND version.event_id = submissions.event_id
                         AND form.kind = 'submission'
                    )
                    AND (
                      1 <> (
                        SELECT COUNT(*) FROM submission_decisions decision
                         WHERE decision.submission_id = speaker.submission_id
                           AND decision.event_id = speaker.event_id
                           AND decision.status = 'published'
                           AND decision.decision = 'accepted'
                      )
                      OR NOT (${acceptanceTaskPlanGuardSql})
                    )
                  )
                  OR EXISTS (
                    SELECT 1 FROM session_speakers relationship
                    JOIN sessions session
                      ON session.id = relationship.session_id
                     AND session.event_id = relationship.event_id
                     WHERE session.source_submission_id = speaker.submission_id
                       AND session.event_id = speaker.event_id
                       AND relationship.person_id = ?
                  )
                )
           )
           ${draftRebuild.versionGuardSql}
      `,
      ).bind(
        operationId,
        invitationId,
        applicant.email,
        expectedClaimTokenHash,
        expectedClaimTokenHash,
        formId,
        invitationId,
        invitationId,
        applicant.personId,
        ...draftRebuild.versionGuardBindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE submission_speakers
           SET person_id = ?, invitation_status = 'claimed', claim_token_hash = NULL,
               invitation_expires_at = NULL, claimed_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ? AND email = ? COLLATE NOCASE AND invitation_status IN ('pending', 'sent')
           AND (invitation_expires_at IS NULL OR invitation_expires_at > unixepoch())
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
           ${draftRebuild.speakerGuardSql}
      `,
      ).bind(
        applicant.personId,
        invitationId,
        applicant.email,
        expectedClaimTokenHash,
        expectedClaimTokenHash,
        formId,
        operationId,
        ...draftRebuild.speakerGuardBindings,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
          entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'public_form', 1, event.organisation_id, speaker.event_id, ?,
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
               speaker.role_label,
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
           ${draftRebuild.speakerGuardSql}
      `,
      ).bind(
        invitationId,
        applicant.personId,
        operationId,
        ...draftRebuild.speakerGuardBindings,
      ),
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
      ...(acceptedClaim
        ? acceptedTaskClaim
          ? [
              ...buildAcceptanceTaskPlanStatements({
                env: this.env,
                viewer: {
                  organisationId: invitation.organisationId,
                  eventId: invitation.eventId,
                  personId: applicant.personId,
                },
                submissionId: invitation.submissionId,
                sessionId: requireValue(
                  invitation.sessionId,
                  "Required invitation.sessionId is unavailable.",
                ),
                decisionId: requireValue(
                  invitation.acceptanceDecisionId,
                  "Required invitation.acceptanceDecisionId is unavailable.",
                ),
                materializationOperationId: operationId,
              }),
              buildAcceptedClaimPropagationAuditStatement(this.env, {
                organisationId: invitation.organisationId,
                eventId: invitation.eventId,
                submissionId: invitation.submissionId,
                sessionId: requireValue(
                  invitation.sessionId,
                  "Required invitation.sessionId is unavailable.",
                ),
                decisionId: requireValue(
                  invitation.acceptanceDecisionId,
                  "Required invitation.acceptanceDecisionId is unavailable.",
                ),
                speakerId: invitationId,
                personId: applicant.personId,
                operationId,
              }),
            ]
          : [
              buildAcceptedDirectClaimPropagationAuditStatement(this.env, {
                organisationId: invitation.organisationId,
                eventId: invitation.eventId,
                sessionId: requireValue(
                  invitation.sessionId,
                  "Required invitation.sessionId is unavailable.",
                ),
                speakerId: invitationId,
                personId: applicant.personId,
                operationId,
              }),
            ]
        : []),
    ];
    if (draftRebuild.statements.length) {
      statements.splice(1, 0, ...draftRebuild.statements);
    }
    const acceptedPropagationIndex = acceptedClaim
      ? statements.length - 1
      : null;
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
    const eventClaimed = results[0];
    const draftUpdated = draftRebuild.statements.length ? results[1] : null;
    const speakerClaimed = results[1 + draftRebuild.statements.length];
    if (
      (eventClaimed?.meta.changes ?? 0) !== 1 ||
      (draftUpdated && (draftUpdated.meta.changes ?? 0) !== 1) ||
      (speakerClaimed?.meta.changes ?? 0) !== 1 ||
      (acceptedPropagationIndex !== null &&
        (results[acceptedPropagationIndex]?.meta.changes ?? 0) !== 1) ||
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

  private async draftConflictRebuildForClaim(input: {
    organisationId: string;
    eventId: string;
    sessionId: string | null;
    personId: string;
    personName: string;
    operationId: string;
  }) {
    const empty = {
      versionGuardSql: "",
      versionGuardBindings: [] as Array<string | number>,
      speakerGuardSql: "",
      speakerGuardBindings: [] as Array<string | number>,
      statements: [] as D1PreparedStatement[],
    };
    if (!input.sessionId) return empty;
    const unscheduledGuards = unscheduledClaimDraftEntryGuards(
      input.eventId,
      input.sessionId,
    );
    const draftEntry = await this.env.DB.prepare(
      `
      SELECT 1 AS present
        FROM schedule_versions version
        JOIN schedule_entries entry
          ON entry.schedule_version_id = version.id
         AND entry.event_id = version.event_id
       WHERE version.event_id = ?
         AND version.status = 'draft'
         AND entry.session_id = ?
       LIMIT 1
    `,
    )
      .bind(input.eventId, input.sessionId)
      .first();
    if (!draftEntry) return unscheduledGuards;
    let workspace: ScheduleWorkspace;
    try {
      workspace = await loadScheduleWorkspaceD1(
        this.env,
        {
          organisationId: input.organisationId,
          eventId: input.eventId,
        },
        { includePublicationConflicts: false },
      );
    } catch (error) {
      if (error instanceof ScheduleConfigurationError) {
        throw new SubmissionStateError(error.message);
      }
      throw error;
    }
    const draft =
      workspace.version?.status === "draft" ? workspace.version : null;
    if (
      !draft ||
      !workspace.entries.some((entry) => entry.sessionId === input.sessionId)
    ) {
      return unscheduledGuards;
    }
    return {
      versionGuardSql: `AND EXISTS (
           SELECT 1 FROM schedule_versions current_version
            WHERE current_version.id = ? AND current_version.event_id = events.id
              AND current_version.status = 'draft' AND current_version.revision = ?
         )`,
      versionGuardBindings: [draft.id, draft.revision],
      speakerGuardSql: `AND EXISTS (
           SELECT 1 FROM schedule_versions current_version
            WHERE current_version.event_id = ?
              AND current_version.status = 'draft'
              AND current_version.publication_operation_id = ?
         )`,
      speakerGuardBindings: [input.eventId, input.operationId],
      statements: scheduleDraftConflictRebuildStatements(this.env, {
        organisationId: input.organisationId,
        eventId: input.eventId,
        operationId: input.operationId,
        draft,
        conflicts: detectWorkspaceConflicts(
          withAddedSessionSpeaker(workspace, {
            sessionId: input.sessionId,
            personId: input.personId,
            name: input.personName,
          }),
        ),
      }),
    };
  }
}
