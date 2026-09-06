import { requireValue } from "~/lib/required-value";
import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import { buildAcceptanceTaskPlanStatements } from "./evaluation-acceptance-task-plan.server";
import type { DecisionStatementInput } from "./evaluation-decision-statements.server";

export function buildAcceptedSessionStatements(
  input: Pick<
    DecisionStatementInput,
    | "env"
    | "viewer"
    | "submission"
    | "sessionId"
    | "sessionTrack"
    | "sessionTitle"
    | "slug"
    | "sessionDescription"
    | "format"
    | "sessionDurationMinutes"
    | "decisionId"
    | "speakerMemberships"
    | "speakerInvitationPlans"
  >,
): D1PreparedStatement[] {
  const {
    env,
    viewer,
    submission,
    sessionId,
    sessionTrack,
    sessionTitle,
    slug,
    sessionDescription,
    format,
    sessionDurationMinutes,
    decisionId,
    speakerMemberships,
    speakerInvitationPlans,
  } = input;
  return sessionId
    ? [
        env.DB.prepare(
          `
          INSERT INTO sessions (
            id, event_id, source_submission_id, track_id, title, slug, description, format,
            duration_minutes, status, visibility, revision, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unscheduled', 'public', 1, unixepoch(), unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM submission_decisions
              WHERE id = ? AND event_id = ? AND status = 'published' AND decision = 'accepted'
           )
             AND EXISTS (
               SELECT 1 FROM submission_track_selections selection
               JOIN tracks current_track
                 ON current_track.id = selection.track_id
                AND current_track.event_id = selection.event_id
                WHERE selection.submission_id = ? AND selection.event_id = ?
                  AND selection.track_id = ?
                  AND current_track.name = ?
             )
        `,
        ).bind(
          sessionId,
          viewer.eventId,
          submission.id,
          requireValue(sessionTrack, "Required sessionTrack is unavailable.")
            .id,
          sessionTitle,
          slug,
          sessionDescription,
          format,
          sessionDurationMinutes,
          decisionId,
          viewer.eventId,
          submission.id,
          viewer.eventId,
          requireValue(sessionTrack, "Required sessionTrack is unavailable.")
            .id,
          requireValue(sessionTrack, "Required sessionTrack is unavailable.")
            .name,
        ),
        env.DB.prepare(
          `
          INSERT INTO session_speakers (
            session_id, event_id, person_id, position, role_label,
            participation_status, participation_confirmed_at, visibility
          )
          SELECT ?, event_id, person_id, position,
                 CASE WHEN is_primary = 1 THEN 'Primary speaker' ELSE 'Co-speaker' END,
                 'confirmed', unixepoch(), 'public'
            FROM submission_speakers
           WHERE submission_id = ? AND event_id = ? AND person_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND event_id = ?)
        `,
        ).bind(
          sessionId,
          submission.id,
          viewer.eventId,
          sessionId,
          viewer.eventId,
        ),
        ...materializePublishedResourceAcknowledgementsForSession(
          env,
          viewer.eventId,
          sessionId,
        ),
        ...speakerMemberships.flatMap(({ membershipId, personId }) => [
          env.DB.prepare(
            `
              INSERT INTO memberships (
                id, organisation_id, event_id, person_id, role, invited_at,
                invitation_expires_at, accepted_at, revoked_at, created_at
              )
              SELECT ?, ?, ?, ?, 'speaker', unixepoch(),
                     unixepoch() + 604800, NULL, NULL, unixepoch()
               WHERE EXISTS (
                 SELECT 1 FROM sessions
                  WHERE id = ? AND event_id = ?
               )
              ON CONFLICT(event_id, person_id, role)
              WHERE event_id IS NOT NULL DO UPDATE SET
                invited_at = CASE
                  WHEN memberships.accepted_at IS NULL
                    OR memberships.revoked_at IS NOT NULL
                  THEN unixepoch() ELSE memberships.invited_at END,
                invitation_expires_at = CASE
                  WHEN memberships.accepted_at IS NULL
                    OR memberships.revoked_at IS NOT NULL
                  THEN unixepoch() + 604800
                  ELSE memberships.invitation_expires_at END,
                accepted_at = CASE
                  WHEN memberships.revoked_at IS NOT NULL THEN NULL
                  ELSE memberships.accepted_at END,
                revoked_at = NULL
            `,
          ).bind(
            membershipId,
            viewer.organisationId,
            viewer.eventId,
            personId,
            sessionId,
            viewer.eventId,
          ),
          env.DB.prepare(
            `
              INSERT INTO audit_events (
                id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
                entity_type, entity_id, metadata_json, created_at
              )
              SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'membership.speaker.invited',
                     'membership', membership.id, ?, unixepoch()
                FROM memberships membership
               WHERE membership.event_id = ? AND membership.person_id = ?
                 AND membership.role = 'speaker'
                 AND membership.accepted_at IS NULL
                 AND membership.revoked_at IS NULL
                 AND membership.invitation_expires_at > unixepoch()
                 AND EXISTS (
                   SELECT 1 FROM sessions
                    WHERE id = ? AND event_id = ?
                 )
            `,
          ).bind(
            crypto.randomUUID(),
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            JSON.stringify({ sessionId, submissionId: submission.id }),
            viewer.eventId,
            personId,
            sessionId,
            viewer.eventId,
          ),
        ]),
        ...speakerInvitationPlans.flatMap((plan) => plan.statements),
        ...buildAcceptanceTaskPlanStatements({
          env,
          viewer,
          submissionId: submission.id,
          sessionId,
          decisionId,
        }),
      ]
    : [];
}
