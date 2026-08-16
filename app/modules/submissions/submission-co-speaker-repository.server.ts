import { requireValue } from "~/lib/required-value";
import {
  acceptanceTaskPlanBindings,
  acceptanceTaskPlanCteSql,
  acceptanceTaskPlanGuardSql,
  buildAcceptanceTaskPlanStatements,
} from "~/modules/evaluations/evaluation-decision-statements.server";
import { materializePublishedResourceAcknowledgementsForClaimedSpeaker } from "~/modules/resources/resource-service-shared";
import type { PreparedApplicantSession } from "./applicant-session.server";
import {
  type Applicant,
  type CoSpeakerInvitation,
  SubmissionStateError,
} from "./submission-repository-shared";

function buildAcceptedClaimPropagationAuditStatement(
  env: CloudflareEnvironment,
  input: {
    organisationId: string;
    eventId: string;
    submissionId: string;
    sessionId: string;
    decisionId: string;
    speakerId: string;
    personId: string;
    operationId: string;
  },
) {
  return env.DB.prepare(
    `${acceptanceTaskPlanCteSql}
     INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
       entity_type, entity_id, correlation_id, metadata_json, created_at
     )
     SELECT lower(hex(randomblob(16))), 'person', 'public_form', 1, ?, scope.event_id, ?,
            'submission.speaker.acceptance_propagated',
            'submission_speaker', ?, ?,
            json_object(
              'decisionId', scope.decision_id,
              'sessionId', scope.session_id
            ), unixepoch()
       FROM acceptance_scope scope
      WHERE EXISTS (
        SELECT 1 FROM submission_speakers speaker
        JOIN submissions submission
          ON submission.id = speaker.submission_id
         AND submission.event_id = speaker.event_id
         AND submission.status = 'accepted'
         WHERE speaker.id = ? AND speaker.event_id = scope.event_id
           AND speaker.submission_id = scope.submission_id
           AND speaker.person_id = ?
           AND speaker.invitation_status = 'claimed'
      )
        AND 1 = (
          SELECT COUNT(*) FROM session_speakers relationship
           WHERE relationship.session_id = scope.session_id
             AND relationship.event_id = scope.event_id
             AND relationship.person_id = ?
        )
        AND 1 = (
          SELECT COUNT(*) FROM memberships membership
           WHERE membership.event_id = scope.event_id
             AND membership.person_id = ?
             AND membership.role = 'speaker'
             AND membership.accepted_at IS NOT NULL
             AND membership.revoked_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM acceptance_task_plan plan
            JOIN task_templates template ON template.id = plan.template_id
            JOIN acceptance_targets target
              ON target.target_type = template.target_type
           WHERE NOT EXISTS (
             SELECT 1 FROM task_instances task
              WHERE task.event_id = scope.event_id
                AND task.template_id = template.id
                AND task.target_type = target.target_type
                AND task.target_id = target.target_id
           )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM acceptance_task_plan plan
            JOIN task_template_dependencies dependency
              ON dependency.template_id = plan.template_id
            JOIN task_templates template ON template.id = dependency.template_id
            JOIN acceptance_targets target
              ON target.target_type = template.target_type
            JOIN task_instances task
              ON task.event_id = scope.event_id
             AND task.template_id = dependency.template_id
             AND task.target_type = target.target_type
             AND task.target_id = target.target_id
            JOIN task_instances prerequisite
              ON prerequisite.event_id = task.event_id
             AND prerequisite.template_id = dependency.depends_on_template_id
             AND prerequisite.target_type = task.target_type
             AND prerequisite.target_id = task.target_id
           WHERE NOT EXISTS (
             SELECT 1 FROM task_instance_dependencies edge
              WHERE edge.task_id = task.id
                AND edge.depends_on_task_id = prerequisite.id
           )
        )`,
  ).bind(
    ...acceptanceTaskPlanBindings({
      eventId: input.eventId,
      submissionId: input.submissionId,
      sessionId: input.sessionId,
      decisionId: input.decisionId,
    }),
    input.organisationId,
    input.personId,
    input.speakerId,
    input.operationId,
    input.speakerId,
    input.personId,
    input.personId,
    input.personId,
  );
}

function buildAcceptedDirectClaimPropagationAuditStatement(
  env: CloudflareEnvironment,
  input: {
    organisationId: string;
    eventId: string;
    sessionId: string;
    speakerId: string;
    personId: string;
    operationId: string;
  },
) {
  return env.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
       entity_type, entity_id, correlation_id, metadata_json, created_at
     )
     SELECT lower(hex(randomblob(16))), 'person', 'public_form', 1, ?, speaker.event_id, ?,
            'submission.speaker.acceptance_propagated',
            'submission_speaker', speaker.id, ?,
            json_object('sessionId', session.id, 'source', 'direct_session'),
            unixepoch()
       FROM submission_speakers speaker
       JOIN submissions submission
         ON submission.id = speaker.submission_id
        AND submission.event_id = speaker.event_id
        AND submission.status = 'accepted'
       JOIN form_versions version
         ON version.id = submission.form_version_id
        AND version.event_id = submission.event_id
       JOIN form_definitions form
         ON form.id = version.form_id
        AND form.event_id = version.event_id
        AND form.kind = 'direct_session'
       JOIN sessions session
         ON session.source_submission_id = submission.id
        AND session.event_id = submission.event_id
        AND session.id = ?
        AND session.status IN ('unscheduled','scheduled')
      WHERE speaker.id = ? AND speaker.event_id = ?
        AND speaker.person_id = ?
        AND speaker.invitation_status = 'claimed'
        AND 1 = (
          SELECT COUNT(*) FROM sessions derived
           WHERE derived.source_submission_id = submission.id
             AND derived.event_id = submission.event_id
        )
        AND 1 = (
          SELECT COUNT(*) FROM session_speakers relationship
           WHERE relationship.session_id = session.id
             AND relationship.event_id = session.event_id
             AND relationship.person_id = speaker.person_id
        )
        AND 1 = (
          SELECT COUNT(*) FROM memberships membership
           WHERE membership.event_id = speaker.event_id
             AND membership.person_id = speaker.person_id
             AND membership.role = 'speaker'
             AND membership.accepted_at IS NOT NULL
             AND membership.revoked_at IS NULL
        )`,
  ).bind(
    input.organisationId,
    input.personId,
    input.operationId,
    input.sessionId,
    input.speakerId,
    input.eventId,
    input.personId,
  );
}

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
             ) AS acceptanceDecisionId
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
      }>();
    if (!invitation) {
      throw new SubmissionStateError(
        "This co-speaker invitation is no longer available.",
      );
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
    const [eventClaimed, speakerClaimed] = results;
    if (
      (eventClaimed.meta.changes ?? 0) !== 1 ||
      (speakerClaimed.meta.changes ?? 0) !== 1 ||
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
}
