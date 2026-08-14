import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import {
  dispatchSpeakerInvitationsForCommand,
  existingPersonOrganisationRelationshipSql,
  organisationRelationshipBindings,
  prepareSpeakerInvitations,
  SpeakerInvitationAddressError,
  unacceptedEventParticipantEmails,
  unavailableDirectSessionSpeakerEmails,
} from "~/modules/speakers/speaker-invitation.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { hashApplicantToken } from "./applicant-session.server";
import { SubmissionApplicantWorkflows } from "./submission-applicant-workflows.server";
import {
  D1SubmissionRepository,
  SubmissionStateError,
  type FormWorkspace,
} from "./submission-repository.server";
import type { AdminSubmissionFilters } from "./submission-repository-shared";
import {
  ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
  DEFAULT_FORM_SCHEMA,
  type SaveFormInput,
  type SubmissionFormSchema,
} from "./submission-schema";
import {
  directSessionSchema,
  isSubmissionApiActor,
  manualApplicationSchema,
  slugify,
  type AdminMutationRecord,
  type PreparedAdminMutation,
  type SubmissionAdminActor,
  type SubmissionApiActor,
} from "./submission-service-foundation.server";

export abstract class SubmissionAdministrationWorkflows extends SubmissionApplicantWorkflows {
  async listAdminSubmissions(viewer: Viewer, filters: AdminSubmissionFilters) {
    await this.airtable.assertReadable(viewer);
    return this.repository.listAdminSubmissions(
      viewer.organisationId,
      viewer.eventId,
      filters,
    );
  }

  async listAdminSubmissionPage(
    viewer: Viewer,
    filters: AdminSubmissionFilters,
    page: number,
  ) {
    await this.airtable.assertReadable(viewer);
    if (!Number.isInteger(page) || page < 1) {
      throw new Response("Invalid submissions page", { status: 400 });
    }
    const pageSize = 50;
    const [rows, categories] = await Promise.all([
      this.repository.listAdminSubmissions(
        viewer.organisationId,
        viewer.eventId,
        filters,
        { limit: pageSize + 1, offset: (page - 1) * pageSize },
      ),
      this.repository.listAdminSubmissionCategories(
        viewer.organisationId,
        viewer.eventId,
      ),
    ]);
    return {
      submissions: rows.slice(0, pageSize),
      categories,
      page,
      hasNext: rows.length > pageSize,
    };
  }

  async getAdminSubmissionQueueContext(
    viewer: Viewer,
    submissionId: string,
    filters: AdminSubmissionFilters,
    page: number,
  ) {
    await this.airtable.assertReadable(viewer);
    if (!Number.isInteger(page) || page < 1) {
      throw new Response("Invalid submissions page", { status: 400 });
    }
    const pageSize = 50;
    const offset = Math.max(0, (page - 1) * pageSize - 1);
    const expectedPageStart = page === 1 ? 0 : 1;
    const rows = await this.repository.listAdminSubmissions(
      viewer.organisationId,
      viewer.eventId,
      filters,
      {
        limit: page === 1 ? pageSize + 1 : pageSize + 2,
        offset,
      },
    );
    const currentIndex = rows.findIndex((row) => row.id === submissionId);
    if (
      currentIndex < expectedPageStart ||
      currentIndex >= expectedPageStart + pageSize
    ) {
      throw new Response(
        "The submission is no longer on the requested queue page. Return to the queue and refresh the working set.",
        { status: 409 },
      );
    }
    const neighbour = (index: number) => {
      const row = rows[index];
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        page: Math.floor((offset + index) / pageSize) + 1,
      };
    };
    return {
      previous: neighbour(currentIndex - 1),
      next: neighbour(currentIndex + 1),
    };
  }

  async getAdminSubmission(viewer: Viewer, submissionId: string) {
    await this.airtable.assertReadable(viewer);
    return this.repository.getAdminSubmission(
      viewer.organisationId,
      viewer.eventId,
      submissionId,
    );
  }

  protected async readAdminMutation(
    command: Omit<PreparedAdminMutation, "recordId">,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT id, request_hash AS requestHash, status, entity_id AS entityId
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
      )
      .first<AdminMutationRecord>();
    if (!row) return null;
    if (row.requestHash !== command.requestHash) {
      throw new SubmissionStateError(
        "This idempotency key was already used with different record details. Refresh before trying again.",
      );
    }
    if (row.status !== "completed") {
      throw new SubmissionStateError(
        "This record creation request is already being processed. Wait for it to finish before retrying.",
      );
    }
    if (!row.entityId) {
      throw new Error(
        "A completed submission administration idempotency record is missing its entity ID.",
      );
    }
    return { entityId: row.entityId, recordId: row.id };
  }

  protected async prepareAdminMutation(
    actor: SubmissionAdminActor,
    scope: PreparedAdminMutation["scope"],
    idempotencyKey: string,
    requestPayload: unknown,
  ) {
    if (isSubmissionApiActor(actor) && !actor.actorId.startsWith("api_key:")) {
      throw new Error("Submission API actor IDs must identify an API key.");
    }
    const requestHash = await hashApplicantToken(
      JSON.stringify(requestPayload),
    );
    const identity = {
      scope,
      idempotencyKey,
      requestHash,
      organisationId: actor.organisationId,
      eventId: actor.eventId,
      actorId: isSubmissionApiActor(actor) ? actor.actorId : actor.personId,
    };
    const replay = await this.readAdminMutation(identity);
    return replay
      ? { replay, command: null }
      : {
          replay: null,
          command: { ...identity, recordId: crypto.randomUUID() },
        };
  }

  protected adminMutationClaimStatements(command: PreparedAdminMutation) {
    return [
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = ? AND idempotency_key = ?
            AND expires_at <= unixepoch()`,
      ).bind(
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
                   unixepoch() + 2592000, unixepoch())`,
      ).bind(
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
      ),
    ];
  }

  protected async resolveAdminMutationRace(command: PreparedAdminMutation) {
    const row = await this.env.DB.prepare(
      `SELECT id, request_hash AS requestHash, status, entity_id AS entityId
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
      )
      .first<AdminMutationRecord>();
    if (!row) return null;
    if (row.requestHash !== command.requestHash) {
      throw new SubmissionStateError(
        "This idempotency key was already used with different record details. Refresh before trying again.",
      );
    }
    if (row.status === "completed") {
      if (!row.entityId) {
        throw new Error(
          "A completed submission administration idempotency record is missing its entity ID.",
        );
      }
      return { entityId: row.entityId, recordId: row.id };
    }
    if (row.id !== command.recordId) {
      throw new SubmissionStateError(
        "This record creation request is already being processed. Wait for it to finish before retrying.",
      );
    }
    await this.env.DB.prepare(
      `DELETE FROM idempotency_records
        WHERE id = ? AND organisation_id = ? AND event_id = ?
          AND actor_id = ? AND status = 'processing'`,
    )
      .bind(
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
      )
      .run();
    return null;
  }

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
          id, organisation_id, event_id, actor_person_id, actor_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, ?, 'session.direct.created', 'session', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM sessions WHERE id = ? AND event_id = ?
            )
      `,
      ).bind(
        auditEventId,
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

  async createManualApplication(viewer: Viewer, rawInput: unknown) {
    return this.projectCommand(
      viewer,
      "submission.manual_application.create",
      rawInput,
      () => this.createManualApplicationD1(viewer, rawInput),
    );
  }

  protected async createManualApplicationD1(viewer: Viewer, rawInput: unknown) {
    const parsed = manualApplicationSchema.parse(rawInput);
    const { idempotencyKey, ...input } = parsed;
    const prepared = await this.prepareAdminMutation(
      viewer,
      "submission.admin.manual.create",
      idempotencyKey,
      input,
    );
    if (prepared.replay) return prepared.replay.entityId;
    const command = prepared.command!;
    const event = await this.env.DB.prepare(
      `SELECT id FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ id: string }>();
    if (!event) throw new Response("Event not found", { status: 404 });
    const unacceptedParticipants = await unacceptedEventParticipantEmails({
      env: this.env,
      eventId: viewer.eventId,
      emails: [
        input.submitterEmail,
        ...input.speakers.map((speaker) => speaker.email),
      ],
    });
    if (unacceptedParticipants.length) {
      throw new SubmissionStateError(
        `Invite these participants and wait for acceptance before entering an application for them: ${unacceptedParticipants.join(", ")}.`,
      );
    }
    const uniqueTrackIds = [...new Set(input.trackIds)];
    const tracksResult = await this.env.DB.prepare(
      `SELECT track.id, track.name
         FROM tracks track
        WHERE track.event_id = ?
          AND track.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
    )
      .bind(viewer.eventId, JSON.stringify(uniqueTrackIds))
      .all<{ id: string; name: string }>();
    if (tracksResult.results.length !== uniqueTrackIds.length) {
      throw new SubmissionStateError(
        "One or more selected tracks are unavailable in this event.",
      );
    }
    const tracksById = new Map(
      tracksResult.results.map((track) => [track.id, track]),
    );
    const tracks = uniqueTrackIds.map((trackId) => tracksById.get(trackId)!);
    const uniqueTeamIds = [...new Set(input.routedTeamIds)];
    const teamsResult = uniqueTeamIds.length
      ? await this.env.DB.prepare(
          `SELECT id, name FROM evaluation_teams
            WHERE event_id = ? AND status = 'active'
              AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
        )
          .bind(viewer.eventId, JSON.stringify(uniqueTeamIds))
          .all<{ id: string; name: string }>()
      : { results: [] as Array<{ id: string; name: string }> };
    if (teamsResult.results.length !== uniqueTeamIds.length) {
      throw new SubmissionStateError(
        "One or more selected review teams are unavailable in this event.",
      );
    }
    const teamsById = new Map(
      teamsResult.results.map((team) => [team.id, team]),
    );
    const teams = uniqueTeamIds.map((teamId) => teamsById.get(teamId)!);
    const formatSnapshot =
      await this.getConfiguredSessionFormatSnapshotD1(viewer);
    const configuredFormat = formatSnapshot.formats.find(
      (format) => format.key === input.format,
    );
    if (!configuredFormat) {
      throw new SubmissionStateError(
        `Session format “${input.format}” is not configured for this event.`,
      );
    }
    const submissionId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const webhookInput = {
      source: "administrator_manual_entry",
      status: "submitted",
      routedTeamIds: uniqueTeamIds,
    };
    const preparedWebhooks = await Promise.all([
      webhookService.prepareEventForAudit(
        viewer,
        {
          eventType: "submission.created",
          entityType: "submission",
          entityId: submissionId,
          idempotencyKey: `submission.created:${submissionId}`,
          correlationId: operationId,
          data: webhookInput,
        },
        auditEventId,
      ),
      webhookService.prepareEventForAudit(
        viewer,
        {
          eventType: "submission.submitted",
          entityType: "submission",
          entityId: submissionId,
          idempotencyKey: `submission.submitted:${submissionId}`,
          correlationId: operationId,
          data: webhookInput,
        },
        auditEventId,
      ),
    ]);
    const answers = {
      title: input.title,
      description: input.description,
      category: tracks.map((track) => track.name),
      format: configuredFormat.key,
    };
    const manualSchema = {
      introduction: "Entered manually by an administrator.",
      presentation: DEFAULT_FORM_SCHEMA.presentation,
      fields: DEFAULT_FORM_SCHEMA.fields
        .filter((field) =>
          ["title", "description", "category", "format"].includes(field.id),
        )
        .map((field) => ({
          ...field,
          required: true,
          condition: null,
          ...(field.id === "category"
            ? { options: tracks.map((track) => track.name) }
            : field.id === "format"
              ? { options: [configuredFormat.key] }
              : {}),
        })),
    } satisfies SubmissionFormSchema;
    const snapshot = {
      formVersionId: ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
      versionNumber: 1,
      schema: manualSchema,
      routing: {
        categories: {},
        trackIds: Object.fromEntries(
          tracks.map((track) => [track.name, track.id]),
        ),
        trackNames: Object.fromEntries(
          tracks.map((track) => [track.id, track.name]),
        ),
        teamNames: Object.fromEntries(
          teams.map((team) => [team.id, team.name]),
        ),
        directSessionDurationMinutes: null,
        passwordHash: null,
      },
      answers,
      speakers: input.speakers,
      uploads: {},
    };
    const statements: D1PreparedStatement[] = [
      ...this.adminMutationClaimStatements(command),
    ];
    const submissionInsertIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, form_version_id, submitter_person_id, submitter_email,
           public_reference, title, category, format, status,
           answers_json, submitted_snapshot_json, revision, last_operation_id,
           submitted_at, created_at, updated_at
         ) SELECT ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'submitted', ?, ?, 1, ?,
                  unixepoch(), unixepoch(), unixepoch()
            WHERE EXISTS (
                SELECT 1 FROM events
                 WHERE id = ? AND organisation_id = ?
                   AND session_formats_json = ?
              )
              AND NOT EXISTS (
                SELECT 1 FROM json_each(?) expected_track
                 WHERE NOT EXISTS (
                   SELECT 1 FROM tracks track
                    WHERE track.id = CAST(expected_track.value AS TEXT)
                      AND track.event_id = ?
                 )
              )
              AND NOT EXISTS (
                SELECT 1 FROM json_each(?) expected_team
                 WHERE NOT EXISTS (
                   SELECT 1 FROM evaluation_teams team
                    WHERE team.id = CAST(expected_team.value AS TEXT)
                      AND team.event_id = ? AND team.status = 'active'
                 )
              )
              AND NOT EXISTS (
                SELECT 1 FROM json_each(?) requested_participant
                 WHERE NOT EXISTS (
                   SELECT 1 FROM people person
                   JOIN memberships membership
                     ON membership.person_id = person.id
                    AND membership.event_id = ?
                    AND membership.role IN ('speaker', 'submitter')
                    AND membership.accepted_at IS NOT NULL
                    AND membership.revoked_at IS NULL
                    WHERE lower(person.email) =
                          lower(CAST(requested_participant.value AS TEXT))
                 )
              )
              AND EXISTS (
                SELECT 1 FROM idempotency_records command
                 WHERE command.id = ? AND command.organisation_id = ?
                   AND command.event_id = ? AND command.actor_id = ?
                   AND command.scope = ? AND command.idempotency_key = ?
                   AND command.request_hash = ? AND command.status = 'processing'
              )`,
      ).bind(
        submissionId,
        viewer.eventId,
        input.submitterEmail,
        `PC-MANUAL-${submissionId.slice(0, 8).toUpperCase()}`,
        input.title,
        tracks.map((track) => track.name).join(", "),
        configuredFormat.key,
        JSON.stringify(answers),
        JSON.stringify(snapshot),
        operationId,
        viewer.eventId,
        viewer.organisationId,
        formatSnapshot.serialized,
        JSON.stringify(uniqueTrackIds),
        viewer.eventId,
        JSON.stringify(uniqueTeamIds),
        viewer.eventId,
        JSON.stringify([
          input.submitterEmail,
          ...input.speakers.map((speaker) => speaker.email),
        ]),
        viewer.eventId,
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
      ),
    );
    for (const team of teams) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO submission_routing_teams (submission_id, event_id, team_id)
           SELECT ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM submissions
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )`,
        ).bind(
          submissionId,
          viewer.eventId,
          team.id,
          submissionId,
          viewer.eventId,
          operationId,
        ),
      );
    }
    tracks.forEach((track, position) => {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO submission_track_selections (
             submission_id, event_id, track_id, track_name_snapshot, position
           )
           SELECT ?, ?, ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM submissions
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
                AND status <> 'draft'
           ) AND EXISTS (
             SELECT 1 FROM tracks
              WHERE id = ? AND event_id = ?
           )`,
        ).bind(
          submissionId,
          viewer.eventId,
          track.id,
          track.name,
          position,
          submissionId,
          viewer.eventId,
          operationId,
          track.id,
          viewer.eventId,
        ),
      );
    });
    const submitterLinkedIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `UPDATE submissions
            SET submitter_person_id = (
              SELECT person.id FROM people person
              JOIN memberships membership
                ON membership.person_id = person.id
               AND membership.event_id = ?
               AND membership.role IN ('speaker', 'submitter')
               AND membership.accepted_at IS NOT NULL
               AND membership.revoked_at IS NULL
               WHERE person.email = ? COLLATE NOCASE
            ), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM people person
              JOIN memberships membership
                ON membership.person_id = person.id
               AND membership.event_id = ?
               AND membership.role IN ('speaker', 'submitter')
               AND membership.accepted_at IS NOT NULL
               AND membership.revoked_at IS NULL
               WHERE person.email = ? COLLATE NOCASE
            )`,
      ).bind(
        viewer.eventId,
        input.submitterEmail,
        submissionId,
        viewer.eventId,
        operationId,
        viewer.eventId,
        input.submitterEmail,
      ),
    );
    input.speakers.forEach((speaker, position) => {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO submission_speakers (
             id, event_id, submission_id, person_id, email, display_name,
             role_label, position, invitation_status, is_primary, claimed_at,
             created_at, updated_at
           ) SELECT ?, ?, ?, person.id, ?, ?, ?, ?, 'claimed', ?,
                    unixepoch(), unixepoch(), unixepoch()
               FROM people person
               JOIN memberships membership
                 ON membership.person_id = person.id
                AND membership.event_id = ?
                AND membership.role IN ('speaker', 'submitter')
                AND membership.accepted_at IS NOT NULL
                AND membership.revoked_at IS NULL
              WHERE person.email = ? COLLATE NOCASE
                AND EXISTS (
                  SELECT 1 FROM submissions
                   WHERE id = ? AND event_id = ? AND last_operation_id = ?
                )`,
        ).bind(
          crypto.randomUUID(),
          viewer.eventId,
          submissionId,
          speaker.email,
          speaker.name,
          position === 0 ? "Primary speaker" : "Co-speaker",
          position,
          position === 0 ? 1 : 0,
          viewer.eventId,
          speaker.email,
          submissionId,
          viewer.eventId,
          operationId,
        ),
      );
    });
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'submission.manual.created', 'submission', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM submissions
               WHERE id = ? AND event_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        submissionId,
        operationId,
        JSON.stringify({
          trackIds: uniqueTrackIds,
          routedTeamIds: uniqueTeamIds,
          format: configuredFormat.key,
        }),
        submissionId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'submission', entity_id = ?,
                completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = ? AND idempotency_key = ?
            AND request_hash = ? AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM submissions
               WHERE id = ? AND event_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        JSON.stringify({ entityId: submissionId }),
        submissionId,
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
        submissionId,
        viewer.eventId,
        operationId,
      ),
    );
    statements.push(
      ...preparedWebhooks.flatMap((webhook) => webhook.statements),
    );
    const results = await this.env.DB.batch(statements);
    if (
      (results[submissionInsertIndex]?.meta.changes ?? 0) !== 1 ||
      (results[submitterLinkedIndex]?.meta.changes ?? 0) !== 1
    ) {
      const replay = await this.resolveAdminMutationRace(command);
      if (replay) return replay.entityId;
      throw new SubmissionStateError(
        "The event tracks, review teams, session formats, or participant acceptances changed before the manual application was created. Refresh and try again.",
      );
    }
    await Promise.all(
      preparedWebhooks.map((webhook) =>
        webhookService.dispatchPreparedEvent(webhook),
      ),
    );
    return submissionId;
  }

  static workspaceToInput(workspace: FormWorkspace): SaveFormInput {
    return {
      id: workspace.id,
      revision: workspace.revision,
      draftRevision: workspace.draftVersion.revision,
      name: workspace.name,
      kind: workspace.kind,
      publicSlug: workspace.publicSlug,
      closeDate: D1SubmissionRepository.closeDateFromEpoch(
        workspace.closesAt,
        workspace.eventTimezone,
      ),
      submissionLimit: workspace.submissionLimit,
      minSpeakers: workspace.minSpeakers,
      maxSpeakers: workspace.maxSpeakers,
      accessMode: workspace.accessMode,
      accessPassword: "",
      schema: workspace.draftVersion.schema,
      routing: { ...workspace.draftVersion.routing, passwordHash: null },
    };
  }

  static synchronizeFormTrackChoices(
    input: SaveFormInput,
    currentTracks: Array<{ id: string; name: string }>,
  ): SaveFormInput {
    const trackField = input.schema.fields.find(
      (field) => field.id === "category",
    );
    if (!trackField) {
      throw new SubmissionStateError(
        "This form draft is missing its protected tracks field.",
      );
    }
    if (
      new Set(currentTracks.map((track) => track.id)).size !==
        currentTracks.length ||
      new Set(currentTracks.map((track) => track.name)).size !==
        currentTracks.length
    ) {
      throw new SubmissionStateError(
        "Event track IDs and names must be unique before editing submission forms.",
      );
    }
    const trackIdForSavedName = (trackName: string) => {
      const trackId = input.routing.trackIds[trackName];
      if (!trackId || input.routing.trackNames[trackId] !== trackName) {
        throw new SubmissionStateError(
          "This form draft has inconsistent saved event-track identity. Repair the draft before editing it.",
        );
      }
      return trackId;
    };
    const selectedTrackIds = new Set(
      trackField.options.map(trackIdForSavedName),
    );
    if (selectedTrackIds.size !== trackField.options.length) {
      throw new SubmissionStateError(
        "This form draft maps multiple track choices to the same event track.",
      );
    }
    const routedTeamByTrackId = new Map<string, string>();
    for (const [trackName, teamId] of Object.entries(
      input.routing.categories,
    )) {
      if (!trackField.options.includes(trackName)) {
        throw new SubmissionStateError(
          "This form draft contains a review route for an unavailable track choice.",
        );
      }
      routedTeamByTrackId.set(trackIdForSavedName(trackName), teamId);
    }
    const selectedTracks = currentTracks.filter((track) =>
      selectedTrackIds.has(track.id),
    );
    return {
      ...input,
      schema: {
        ...input.schema,
        fields: input.schema.fields.map((field) =>
          field.id === "category"
            ? { ...field, options: selectedTracks.map((track) => track.name) }
            : field,
        ),
      },
      routing: {
        ...input.routing,
        categories: Object.fromEntries(
          selectedTracks.flatMap((track) => {
            const teamId = routedTeamByTrackId.get(track.id);
            return teamId ? [[track.name, teamId]] : [];
          }),
        ),
        trackIds: Object.fromEntries(
          selectedTracks.map((track) => [track.name, track.id]),
        ),
        trackNames: Object.fromEntries(
          selectedTracks.map((track) => [track.id, track.name]),
        ),
      },
    };
  }
}
