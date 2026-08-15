import type { AdministratorInvitationInput } from "./event-schema";

export class EventAdministratorAlreadyActiveError extends Error {
  constructor(scope: "event" | "organisation") {
    super(
      scope === "organisation"
        ? "That person already administers this organisation."
        : "That person already administers this event through an event or organisation role.",
    );
    this.name = "EventAdministratorAlreadyActiveError";
  }
}

export class EventAdministratorNotFoundError extends Error {
  constructor() {
    super("The administrator membership is no longer active in this scope.");
    this.name = "EventAdministratorNotFoundError";
  }
}

export class EventAdministratorRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async inviteAdministrator(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    input: AdministratorInvitationInput,
    command?: {
      operationId: string;
      personId: string;
      membershipId: string;
      auditId: string;
    },
  ): Promise<{ membershipId: string }> {
    if (command) {
      const recovered = await this.env.DB.prepare(
        `SELECT membership.id
           FROM memberships membership
           JOIN people person ON person.id = membership.person_id
          WHERE membership.organisation_id = ?
            AND membership.role = 'administrator'
            AND membership.last_operation_id = ?
            AND person.email = ? COLLATE NOCASE
            AND ((? = 'event' AND membership.event_id = ?)
              OR (? = 'organisation' AND membership.event_id IS NULL))`,
      )
        .bind(
          organisationId,
          command.operationId,
          input.email,
          input.scope,
          eventId,
          input.scope,
        )
        .first<{ id: string }>();
      if (recovered) return { membershipId: recovered.id };
    }
    const personId = command?.personId ?? crypto.randomUUID();
    await this.env.DB.prepare(
      `
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'draft', unixepoch(), unixepoch())
        ON CONFLICT(email) DO NOTHING
      `,
    )
      .bind(personId, input.email, input.name)
      .run();

    const person = await this.env.DB.prepare(
      `
      SELECT p.id
        FROM people p
        JOIN events e ON e.id = ? AND e.organisation_id = ?
       WHERE p.email = ? COLLATE NOCASE
    `,
    )
      .bind(eventId, organisationId, input.email)
      .first<{ id: string }>();
    if (!person)
      throw new Error(
        "The administrator could not be added to the authorised event.",
      );

    const activeAccessPredicate =
      input.scope === "organisation"
        ? "membership.event_id IS NULL AND membership.role IN ('owner', 'administrator')"
        : "((membership.event_id IS NULL AND membership.role IN ('owner', 'administrator')) OR (membership.event_id = ? AND membership.role = 'administrator'))";
    const active = await this.env.DB.prepare(
      `
      SELECT membership.id
        FROM memberships membership
       WHERE membership.organisation_id = ?
         AND membership.person_id = ?
         AND membership.accepted_at IS NOT NULL
         AND membership.revoked_at IS NULL
         AND (${activeAccessPredicate})
       LIMIT 1
    `,
    )
      .bind(
        organisationId,
        person.id,
        ...(input.scope === "event" ? [eventId] : []),
      )
      .first<{ id: string }>();
    if (active) throw new EventAdministratorAlreadyActiveError(input.scope);

    const targetPredicate =
      input.scope === "organisation" ? "event_id IS NULL" : "event_id = ?";
    const existing = await this.env.DB.prepare(
      `
      SELECT id
        FROM memberships
       WHERE organisation_id = ? AND person_id = ? AND role = 'administrator'
         AND ${targetPredicate}
    `,
    )
      .bind(
        organisationId,
        person.id,
        ...(input.scope === "event" ? [eventId] : []),
      )
      .first<{
        id: string;
      }>();

    const membershipId =
      existing?.id ?? command?.membershipId ?? crypto.randomUUID();
    const membershipStatement = existing
      ? this.env.DB.prepare(
          `
        UPDATE memberships
           SET invited_at = unixepoch(), invitation_expires_at = unixepoch() + 604800,
               accepted_at = NULL, revoked_at = NULL, last_operation_id = ?
         WHERE id = ? AND organisation_id = ? AND role = 'administrator'
           AND ${targetPredicate}
      `,
        ).bind(
          command?.operationId ?? null,
          membershipId,
          organisationId,
          ...(input.scope === "event" ? [eventId] : []),
        )
      : this.env.DB.prepare(
          `
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role, invited_at,
          invitation_expires_at, accepted_at, last_operation_id, created_at
        )
        VALUES (?, ?, ?, ?, 'administrator', unixepoch(), unixepoch() + 604800, NULL, ?, unixepoch())
      `,
        ).bind(
          membershipId,
          organisationId,
          input.scope === "event" ? eventId : null,
          person.id,
          command?.operationId ?? null,
        );
    const results = await this.env.DB.batch([
      membershipStatement,
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'membership.administrator.invited',
               'membership', ?, ?, ?, unixepoch()
         WHERE changes() = 1
      `,
      ).bind(
        command?.auditId ?? crypto.randomUUID(),
        organisationId,
        eventId,
        actorPersonId,
        membershipId,
        command?.operationId ?? null,
        JSON.stringify({
          email: input.email,
          scope: input.scope,
          targetEventId: input.scope === "event" ? eventId : null,
        }),
      ),
    ]);
    if (
      (results[0].meta.changes ?? 0) !== 1 ||
      (results[1].meta.changes ?? 0) !== 1
    )
      throw new Error(
        "The administrator invitation was not persisted atomically.",
      );
    return { membershipId };
  }

  async revokeAdministrator(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    membershipId: string,
    command?: { operationId: string; auditId: string },
  ): Promise<{ membershipId: string; scope: "event" | "organisation" }> {
    const membership = await this.env.DB.prepare(
      `
      SELECT membership.id, person.email,
             CASE WHEN membership.event_id IS NULL
                  THEN 'organisation' ELSE 'event' END AS scope
        FROM memberships membership
        JOIN people person ON person.id = membership.person_id
       WHERE membership.id = ? AND membership.organisation_id = ?
         AND membership.role = 'administrator'
         AND membership.revoked_at IS NULL
         AND (membership.event_id = ? OR membership.event_id IS NULL)
    `,
    )
      .bind(membershipId, organisationId, eventId)
      .first<{
        id: string;
        email: string;
        scope: "event" | "organisation";
      }>();
    if (!membership) {
      if (command) {
        const recovered = await this.env.DB.prepare(
          `SELECT CASE WHEN event_id IS NULL THEN 'organisation' ELSE 'event' END AS scope
             FROM memberships
            WHERE id = ? AND organisation_id = ? AND role = 'administrator'
              AND revoked_at IS NOT NULL AND last_operation_id = ?
              AND (event_id = ? OR event_id IS NULL)`,
        )
          .bind(membershipId, organisationId, command.operationId, eventId)
          .first<{ scope: "event" | "organisation" }>();
        if (recovered) return { membershipId, scope: recovered.scope };
      }
      throw new EventAdministratorNotFoundError();
    }

    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE memberships
           SET revoked_at = unixepoch(), invitation_expires_at = NULL,
               last_operation_id = ?
         WHERE id = ? AND organisation_id = ? AND role = 'administrator'
           AND revoked_at IS NULL
           AND (event_id = ? OR event_id IS NULL)
      `,
      ).bind(
        command?.operationId ?? null,
        membershipId,
        organisationId,
        eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'membership.administrator.revoked',
               'membership', ?, ?, ?, unixepoch()
         WHERE changes() = 1
      `,
      ).bind(
        command?.auditId ?? crypto.randomUUID(),
        organisationId,
        eventId,
        actorPersonId,
        membershipId,
        command?.operationId ?? null,
        JSON.stringify({
          email: membership.email,
          scope: membership.scope,
        }),
      ),
    ]);
    if (
      (results[0].meta.changes ?? 0) !== 1 ||
      (results[1].meta.changes ?? 0) !== 1
    )
      throw new EventAdministratorNotFoundError();
    return { membershipId, scope: membership.scope };
  }
}
