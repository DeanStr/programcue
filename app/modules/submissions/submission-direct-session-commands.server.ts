import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import {
  dispatchSpeakerInvitationsForCommand,
  existingPersonOrganisationRelationshipSql,
  organisationRelationshipBindings,
  prepareSpeakerInvitations,
  SpeakerInvitationAddressError,
  unavailableDirectSessionSpeakerEmails,
} from "~/modules/speakers/speaker-invitation.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { SubmissionAdministrationCommandFoundation } from "./submission-administration-command-foundation.server";
import { SubmissionStateError } from "./submission-repository.server";
import {
  directSessionSchema,
  isSubmissionApiActor,
  type SubmissionAdminActor,
  type SubmissionApiActor,
  slugify,
} from "./submission-service-foundation.server";

export class SubmissionDirectSessionCommands extends SubmissionAdministrationCommandFoundation {
  async createDirectSession(viewer: Viewer, rawInput: unknown) {
    return this.executeDirectSession(viewer, rawInput);
  }

  private async resumeDirectSessionSideEffects(
    actor: SubmissionAdminActor,
    sessionId: string,
    commandId: string,
    replayed: boolean,
  ) {
    const committed = await this.env.DB.prepare(
      `SELECT session.track_id AS trackId, audit.id AS auditEventId
         FROM sessions session
         JOIN events event
           ON event.id = session.event_id AND event.organisation_id = ?
         JOIN audit_events audit
           ON audit.organisation_id = event.organisation_id
          AND audit.event_id = session.event_id
          AND audit.action = 'session.direct.created'
          AND audit.entity_type = 'session' AND audit.entity_id = session.id
          AND audit.correlation_id = ?
        WHERE session.id = ? AND session.event_id = ?
        LIMIT 1`,
    )
      .bind(actor.organisationId, commandId, sessionId, actor.eventId)
      .first<{ trackId: string; auditEventId: string }>();
    if (!committed) {
      throw new Error(
        "The committed direct session is missing its audited side-effect boundary.",
      );
    }
    const webhookDeliveries = await new WebhookService(
      this.env,
    ).resumePreparedEventForAudit(
      {
        organisationId: actor.organisationId,
        eventId: actor.eventId,
        personId: isSubmissionApiActor(actor) ? null : actor.personId,
        actorId: isSubmissionApiActor(actor) ? actor.actorId : undefined,
      },
      {
        eventType: "session.created",
        entityType: "session",
        entityId: sessionId,
        idempotencyKey: `session.created:${sessionId}`,
        correlationId: commandId,
        data: {
          source: isSubmissionApiActor(actor)
            ? "api_direct_entry"
            : "administrator_direct_entry",
          trackId: committed.trackId,
        },
      },
      committed.auditEventId,
    );
    const invitationOutcomes = await dispatchSpeakerInvitationsForCommand({
      env: this.env,
      organisationId: actor.organisationId,
      eventId: actor.eventId,
      commandId,
    });
    const invitationNeedsAttention = invitationOutcomes.some((outcome) =>
      ["queue_failed", "failed", "cancelled"].includes(outcome.status),
    );
    const webhookNeedsAttention = webhookDeliveries.some((delivery) =>
      ["queue_failed", "partially_failed", "failed", "cancelled"].includes(
        delivery.status,
      ),
    );
    return {
      sessionId,
      replayed,
      invitationDeliveries: invitationOutcomes.map((outcome) => outcome.status),
      invitationWarning: invitationNeedsAttention
        ? "The session was created, but one or more durable portal invitation operations need attention in Speakers administration. Participation confirmation remains separate."
        : null,
      webhookDeliveries,
      webhookWarning: webhookNeedsAttention
        ? "The session was created, but one or more outbound webhook deliveries require retry."
        : null,
    };
  }

  createDirectSessionForApi(actor: SubmissionApiActor, rawInput: unknown) {
    return this.executeDirectSession(actor, rawInput);
  }

  protected executeDirectSession(
    actor: SubmissionAdminActor,
    rawInput: unknown,
  ) {
    return this.projectCommand(
      actor,
      "submission.direct_session.create",
      rawInput,
      () => this.createDirectSessionD1(actor, rawInput),
    );
  }

  protected async createDirectSessionD1(
    actor: SubmissionAdminActor,
    rawInput: unknown,
  ) {
    const parsed = directSessionSchema.parse(rawInput);
    const { idempotencyKey, ...inputWithoutDuration } = parsed;
    const prepared = await this.prepareAdminMutation(
      actor,
      "submission.admin.direct_session.create",
      idempotencyKey,
      inputWithoutDuration,
    );
    if (prepared.replay) {
      return this.resumeDirectSessionSideEffects(
        actor,
        prepared.replay.entityId,
        prepared.replay.recordId,
        true,
      );
    }
    const formatSnapshot =
      await this.getConfiguredSessionFormatSnapshotD1(actor);
    const configuredFormat = formatSnapshot.formats.find(
      (format) => format.key === parsed.format,
    );
    if (!configuredFormat) {
      throw new SubmissionStateError(
        `Session format “${parsed.format}” is not configured for this event.`,
      );
    }
    const track = await this.env.DB.prepare(
      `SELECT id, name FROM tracks WHERE id = ? AND event_id = ?`,
    )
      .bind(parsed.trackId, actor.eventId)
      .first<{ id: string; name: string }>();
    if (!track) {
      throw new SubmissionStateError(
        "The selected track is unavailable in this event.",
      );
    }
    const input = {
      ...inputWithoutDuration,
      durationMinutes:
        parsed.durationMinutes ?? configuredFormat.defaultDurationMinutes,
    };
    const unavailableEmails = await unavailableDirectSessionSpeakerEmails({
      env: this.env,
      organisationId: actor.organisationId,
      emails: input.speakers.map((speaker) => speaker.email),
    });
    if (unavailableEmails.length) {
      throw new SubmissionStateError(
        `Invite ${unavailableEmails.join(", ")} to the event and wait for acceptance before attaching that existing identity to a direct session.`,
      );
    }
    const command = prepared.command!;
    const sessionId = crypto.randomUUID();
    const slug = `${slugify(input.title)}-${sessionId.slice(0, 6)}`;
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      {
        organisationId: actor.organisationId,
        eventId: actor.eventId,
        personId: isSubmissionApiActor(actor) ? null : actor.personId,
        actorId: isSubmissionApiActor(actor) ? actor.actorId : undefined,
      },
      {
        eventType: "session.created",
        entityType: "session",
        entityId: sessionId,
        idempotencyKey: `session.created:${sessionId}`,
        correlationId: command.recordId,
        data: {
          source: isSubmissionApiActor(actor)
            ? "api_direct_entry"
            : "administrator_direct_entry",
          trackId: track.id,
        },
      },
      auditEventId,
    );
    let invitationPlans: Awaited<ReturnType<typeof prepareSpeakerInvitations>>;
    try {
      invitationPlans = await prepareSpeakerInvitations({
        env: this.env,
        actor: {
          organisationId: actor.organisationId,
          eventId: actor.eventId,
          personId: isSubmissionApiActor(actor) ? null : actor.personId,
          actorId: isSubmissionApiActor(actor) ? actor.actorId : undefined,
        },
        commandId: command.recordId,
        source: "direct_session",
        emails: input.speakers.map((speaker) => speaker.email),
      });
    } catch (error) {
      if (error instanceof SpeakerInvitationAddressError) {
        throw new SubmissionStateError(error.message);
      }
      throw error;
    }
    const statements: D1PreparedStatement[] = [
      ...this.adminMutationClaimStatements(command),
    ];
    const sessionInsertIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, track_id, title, slug, description, format, duration_minutes,
           status, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'unscheduled', unixepoch(), unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM events
             WHERE id = ? AND organisation_id = ?
               AND session_formats_json = ?
          )
            AND EXISTS (
              SELECT 1 FROM tracks
               WHERE id = ? AND event_id = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) requested_speaker
              JOIN people person
                ON lower(person.email) =
                   lower(json_extract(requested_speaker.value, '$.email'))
             WHERE NOT ${existingPersonOrganisationRelationshipSql}
            )
            AND EXISTS (
              SELECT 1 FROM idempotency_records command
               WHERE command.id = ? AND command.organisation_id = ?
                 AND command.event_id = ? AND command.actor_id = ?
                 AND command.scope = ? AND command.idempotency_key = ?
                 AND command.request_hash = ? AND command.status = 'processing'
            )`,
      ).bind(
        sessionId,
        actor.eventId,
        track.id,
        input.title,
        slug,
        input.description || null,
        input.format,
        input.durationMinutes,
        actor.eventId,
        actor.organisationId,
        formatSnapshot.serialized,
        track.id,
        actor.eventId,
        JSON.stringify(input.speakers),
        ...organisationRelationshipBindings(actor.organisationId),
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
      ),
    );
    const proposedPersonIds = new Map(
      input.speakers.map((speaker) => [speaker.email, crypto.randomUUID()]),
    );
    for (const speaker of input.speakers) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO people (
            id, email, display_name, email_verified, biography, profile_status,
            created_at, updated_at
          ) SELECT ?, ?, ?, 0, ?, 'draft', unixepoch(), unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM sessions WHERE id = ? AND event_id = ?
              )
          ON CONFLICT(email) DO NOTHING
        `,
        ).bind(
          proposedPersonIds.get(speaker.email),
          speaker.email,
          speaker.name,
          speaker.biography || null,
          sessionId,
          actor.eventId,
        ),
      );
    }
    input.speakers.forEach((speaker, position) => {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO session_speakers (
            session_id, event_id, person_id, position, role_label,
            participation_status, participation_confirmed_at
          )
          SELECT session.id, session.event_id, person.id, ?, ?,
                 'pending', NULL
            FROM sessions session
            JOIN people person ON person.email = ? COLLATE NOCASE
           WHERE session.id = ? AND session.event_id = ?
             AND (person.id = ? OR ${existingPersonOrganisationRelationshipSql})
        `,
        ).bind(
          position,
          position === 0 ? "Primary speaker" : "Co-speaker",
          speaker.email,
          sessionId,
          actor.eventId,
          proposedPersonIds.get(speaker.email),
          ...organisationRelationshipBindings(actor.organisationId),
        ),
      );
    });
    for (const speaker of input.speakers) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO memberships (
             id, organisation_id, event_id, person_id, role,
             invited_at, invitation_expires_at, accepted_at, revoked_at,
             last_operation_id, created_at
           )
           SELECT ?, ?, ?, person.id, 'speaker', unixepoch(),
                  unixepoch() + 604800, NULL, NULL, ?, unixepoch()
             FROM people person
             JOIN session_speakers relationship
               ON relationship.person_id = person.id
              AND relationship.event_id = ?
              AND relationship.session_id = ?
            WHERE person.email = ? COLLATE NOCASE
           ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
           DO UPDATE SET
                         invited_at = CASE
                           WHEN memberships.accepted_at IS NOT NULL
                            AND memberships.revoked_at IS NULL
                           THEN memberships.invited_at ELSE unixepoch() END,
                         invitation_expires_at = CASE
                           WHEN memberships.accepted_at IS NOT NULL
                            AND memberships.revoked_at IS NULL
                           THEN memberships.invitation_expires_at
                           ELSE unixepoch() + 604800 END,
                         accepted_at = CASE
                           WHEN memberships.accepted_at IS NOT NULL
                            AND memberships.revoked_at IS NULL
                           THEN memberships.accepted_at ELSE NULL END,
                         revoked_at = NULL,
                         last_operation_id = excluded.last_operation_id
            WHERE memberships.organisation_id = excluded.organisation_id`,
        ).bind(
          crypto.randomUUID(),
          actor.organisationId,
          actor.eventId,
          command.recordId,
          actor.eventId,
          sessionId,
          speaker.email,
        ),
      );
    }
    statements.push(
      ...materializePublishedResourceAcknowledgementsForSession(
        this.env,
        actor.eventId,
        sessionId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, 1, ?, ?, ?, ?, 'session.direct.created', 'session', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM sessions WHERE id = ? AND event_id = ?
            )
      `,
      ).bind(
        auditEventId,
        isSubmissionApiActor(actor) ? "api_key" : "person",
        isSubmissionApiActor(actor) ? "api" : "admin_ui",
        actor.organisationId,
        actor.eventId,
        isSubmissionApiActor(actor) ? null : actor.personId,
        isSubmissionApiActor(actor) ? actor.actorId : null,
        sessionId,
        command.recordId,
        JSON.stringify({
          title: input.title,
          trackId: track.id,
          trackName: track.name,
          speakerEmails: input.speakers.map((speaker) => speaker.email),
        }),
        sessionId,
        actor.eventId,
      ),
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'session', entity_id = ?,
                completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = ? AND idempotency_key = ?
            AND request_hash = ? AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM sessions WHERE id = ? AND event_id = ?
            )`,
      ).bind(
        JSON.stringify({ entityId: sessionId }),
        sessionId,
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
        sessionId,
        actor.eventId,
      ),
    );
    statements.push(
      ...preparedWebhook.statements,
      ...invitationPlans.flatMap((plan) => plan.statements),
    );
    const results = await this.env.DB.batch(statements);
    if ((results[sessionInsertIndex]?.meta.changes ?? 0) !== 1) {
      const replay = await this.resolveAdminMutationRace(command);
      if (replay) {
        return this.resumeDirectSessionSideEffects(
          actor,
          replay.entityId,
          replay.recordId,
          true,
        );
      }
      throw new SubmissionStateError(
        "The event changed before the direct session was created. Refresh and try again.",
      );
    }
    return this.resumeDirectSessionSideEffects(
      actor,
      sessionId,
      command.recordId,
      false,
    );
  }
}
