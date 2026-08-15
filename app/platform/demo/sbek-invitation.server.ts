import { SBEK_FIXTURE_PEOPLE, isSbekFixturePerson } from "./demo-identities";
import type { ViewerRole } from "~/platform/auth/authorize.server";

type DemoInvitationActivation = {
  membershipId: string;
  organisationId: string;
  eventId: string;
  actorPersonId: string;
  role: Extract<ViewerRole, "evaluator" | "speaker">;
};

export type SbekDemoActivationOutcome =
  "not_fixture" | "already_active" | "activated";

export class SbekDemoActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SbekDemoActivationError";
  }
}

function fixturePersonCanActivate(
  role: DemoInvitationActivation["role"],
  personId: string,
) {
  if (!isSbekFixturePerson(personId)) return false;
  if (role === "evaluator") {
    return personId === SBEK_FIXTURE_PEOPLE.reviewer.personId;
  }
  return (
    personId === SBEK_FIXTURE_PEOPLE.speaker.personId ||
    personId === SBEK_FIXTURE_PEOPLE.speaker2.personId
  );
}

/**
 * Activates only the exact SBEK fixture person's pending local-demo access
 * after the organiser has already performed the consequential invite or
 * acceptance mutation. This is an authentication handoff, not evidence that
 * an email was sent or consumed.
 */
export async function activateSbekDemoInvitation(
  env: CloudflareEnvironment,
  input: DemoInvitationActivation,
): Promise<SbekDemoActivationOutcome> {
  if (String(env.DEMO_MODE) !== "true" || env.APP_ENV === "production") {
    throw new SbekDemoActivationError(
      "SBEK fixture activation is available only in the explicit non-production demo runtime.",
    );
  }
  const membership = await env.DB.prepare(
    `SELECT person_id AS personId, invited_at AS invitedAt,
            invitation_expires_at AS expiresAt, accepted_at AS acceptedAt,
            revoked_at AS revokedAt
       FROM memberships
      WHERE id = ? AND organisation_id = ? AND event_id = ? AND role = ?
      LIMIT 1`,
  )
    .bind(input.membershipId, input.organisationId, input.eventId, input.role)
    .first<{
      personId: string;
      invitedAt: number | null;
      expiresAt: number | null;
      acceptedAt: number | null;
      revokedAt: number | null;
    }>();
  if (!membership) {
    throw new SbekDemoActivationError(
      "The committed demo invitation could not be found for local fixture activation.",
    );
  }
  if (!fixturePersonCanActivate(input.role, membership.personId)) {
    return "not_fixture";
  }
  if (membership.revokedAt !== null) {
    throw new SbekDemoActivationError(
      "The exact SBEK fixture invitation was revoked before local activation.",
    );
  }
  if (membership.acceptedAt !== null) return "already_active";
  const now = Math.floor(Date.now() / 1_000);
  if (
    membership.invitedAt === null ||
    membership.expiresAt === null ||
    membership.expiresAt <= now
  ) {
    throw new SbekDemoActivationError(
      "The exact SBEK fixture invitation is not pending and valid for local activation.",
    );
  }

  const correlationId = `demo-sbek-activation:${crypto.randomUUID()}`;
  const [activated, audited] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE memberships
          SET accepted_at = unixepoch(), invitation_expires_at = NULL,
              last_operation_id = ?
        WHERE id = ? AND organisation_id = ? AND event_id = ? AND role = ?
          AND person_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
          AND invitation_expires_at > unixepoch()
      RETURNING id`,
    ).bind(
      correlationId,
      input.membershipId,
      input.organisationId,
      input.eventId,
      input.role,
      membership.personId,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, correlation_id, metadata_json, created_at
       )
       SELECT ?, 'person', 'internal', 1, ?, ?, ?, 'membership.demo_fixture_activated',
              'membership', ?, ?, ?, unixepoch()
        WHERE EXISTS (
          SELECT 1 FROM memberships membership
           WHERE membership.id = ?
             AND membership.organisation_id = ?
             AND membership.event_id = ?
             AND membership.person_id = ?
             AND membership.role = ?
             AND membership.accepted_at IS NOT NULL
             AND membership.revoked_at IS NULL
             AND membership.last_operation_id = ?
        )`,
    ).bind(
      crypto.randomUUID(),
      input.organisationId,
      input.eventId,
      input.actorPersonId,
      input.membershipId,
      correlationId,
      JSON.stringify({
        role: input.role,
        personId: membership.personId,
        emailDelivery: "not_sent",
        fixture: "sbek",
      }),
      input.membershipId,
      input.organisationId,
      input.eventId,
      membership.personId,
      input.role,
      correlationId,
    ),
  ]);
  if (activated.results.length !== 1 || (audited.meta.changes ?? 0) !== 1) {
    throw new SbekDemoActivationError(
      "The exact SBEK fixture invitation and activation audit could not be committed together.",
    );
  }
  return "activated";
}
