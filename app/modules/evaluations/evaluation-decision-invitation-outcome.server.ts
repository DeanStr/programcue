import type { Viewer } from "~/platform/auth/authorize.server";
import { activateSbekDemoInvitation } from "~/platform/demo/sbek-invitation.server";

export async function acceptedSpeakerInvitationOutcome(
  env: CloudflareEnvironment,
  viewer: Viewer,
  decisionId: string,
  sessionId: string | null,
) {
  if (!sessionId) {
    return {
      speakerInvitationStatus: "not_required" as const,
      speakerInvitationCount: 0,
    };
  }
  if (String(env.DEMO_MODE) === "true") {
    const memberships = await env.DB.prepare(
      `SELECT membership.id AS membershipId,
              membership.accepted_at AS acceptedAt,
              membership.revoked_at AS revokedAt,
              membership.invitation_expires_at AS expiresAt
         FROM session_speakers speaker
         LEFT JOIN memberships membership
           ON membership.event_id = speaker.event_id
          AND membership.person_id = speaker.person_id
          AND membership.organisation_id = ?
          AND membership.role = 'speaker'
        WHERE speaker.session_id = ? AND speaker.event_id = ?`,
    )
      .bind(viewer.organisationId, sessionId, viewer.eventId)
      .all<{
        membershipId: string | null;
        acceptedAt: number | null;
        revokedAt: number | null;
        expiresAt: number | null;
      }>();
    let activationFailed = false;
    let count = 0;
    const now = Math.floor(Date.now() / 1_000);
    for (const membership of memberships.results) {
      if (
        membership.acceptedAt === null &&
        membership.revokedAt === null &&
        membership.expiresAt !== null &&
        membership.expiresAt > now
      ) {
        count += 1;
      }
      if (!membership.membershipId) {
        activationFailed = true;
        break;
      }
      try {
        await activateSbekDemoInvitation(env, {
          membershipId: membership.membershipId,
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          actorPersonId: viewer.personId,
          role: "speaker",
        });
      } catch {
        activationFailed = true;
        break;
      }
    }
    return {
      speakerInvitationStatus: activationFailed
        ? ("demo_activation_failed" as const)
        : count > 0
          ? ("demo_not_sent" as const)
          : ("not_required" as const),
      speakerInvitationCount: count,
    };
  }
  const summary = await env.DB.prepare(
    `SELECT COUNT(*) AS count,
            SUM(CASE WHEN operation.status IN (
                  'queue_failed','failed','partially_failed'
                ) THEN 1 ELSE 0 END) AS retryCount
       FROM communications communication
       JOIN operation_jobs operation
         ON operation.id = communication.operation_id
        AND operation.event_id = communication.event_id
        AND operation.organisation_id = ?
      WHERE communication.event_id = ?
        AND json_extract(communication.audience_json, '$.type') =
            'accepted_speaker_invitation'
        AND json_extract(communication.audience_json, '$.decisionId') = ?`,
  )
    .bind(viewer.organisationId, viewer.eventId, decisionId)
    .first<{ count: number; retryCount: number | null }>();
  const count = Number(summary?.count ?? 0);
  return {
    speakerInvitationStatus:
      count === 0
        ? ("not_required" as const)
        : Number(summary?.retryCount ?? 0) > 0
          ? ("queue_failed" as const)
          : ("queued" as const),
    speakerInvitationCount: count,
  };
}
