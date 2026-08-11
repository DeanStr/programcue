import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { hashApplicantToken } from "./applicant-session.server";
import { SubmissionApplicantWorkflows } from "./submission-applicant-workflows.server";
import {
  D1SubmissionRepository,
  SubmissionStateError,
  type FormWorkspace,
} from "./submission-repository.server";
import {
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
  async listAdminSubmissions(
    viewer: Viewer,
    filters: { status?: string; category?: string; query?: string },
  ) {
    await this.airtable.assertReadable(viewer);
    return this.repository.listAdminSubmissions(
      viewer.organisationId,
      viewer.eventId,
      filters,
    );
  }

  async listAdminSubmissionPage(
    viewer: Viewer,
    filters: { status?: string; category?: string; query?: string },
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
    return row.entityId;
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
      return row.entityId;
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
    const result = await this.executeDirectSession(viewer, rawInput);
    return result.sessionId;
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
      return { sessionId: prepared.replay, replayed: true };
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
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
      ),
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
          crypto.randomUUID(),
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
            session_id, event_id, person_id, position, role_label
          ) SELECT ?, ?, id, ?, ? FROM people
             WHERE email = ? COLLATE NOCASE
               AND EXISTS (
                 SELECT 1 FROM sessions WHERE id = ? AND event_id = ?
               )
        `,
        ).bind(
          sessionId,
          actor.eventId,
          position,
          position === 0 ? "Primary speaker" : "Co-speaker",
          speaker.email,
          sessionId,
          actor.eventId,
        ),
      );
    });
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
          entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, ?, 'session.direct.created', 'session', ?, ?, unixepoch()
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
    statements.push(...preparedWebhook.statements);
    const results = await this.env.DB.batch(statements);
    if ((results[sessionInsertIndex]?.meta.changes ?? 0) !== 1) {
      const replay = await this.resolveAdminMutationRace(command);
      if (replay) return { sessionId: replay, replayed: true };
      throw new SubmissionStateError(
        "The event changed before the direct session was created. Refresh and try again.",
      );
    }
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return { sessionId, replayed: false };
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
    if (prepared.replay) return prepared.replay;
    const command = prepared.command!;
    const event = await this.env.DB.prepare(
      `SELECT id FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ id: string }>();
    if (!event) throw new Response("Event not found", { status: 404 });
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
      formVersionId: "manual-administrator-entry",
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
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status, created_at, updated_at
         ) SELECT ?, ?, ?, 0, 'draft', unixepoch(), unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM submissions
               WHERE id = ? AND event_id = ? AND last_operation_id = ?
            )
         ON CONFLICT(email) DO NOTHING`,
      ).bind(
        crypto.randomUUID(),
        input.submitterEmail,
        input.submitterName,
        submissionId,
        viewer.eventId,
        operationId,
      ),
    );
    for (const speaker of input.speakers) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, biography, profile_status,
             created_at, updated_at
           ) SELECT ?, ?, ?, 0, ?, 'draft', unixepoch(), unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM submissions
                 WHERE id = ? AND event_id = ? AND last_operation_id = ?
              )
           ON CONFLICT(email) DO NOTHING`,
        ).bind(
          crypto.randomUUID(),
          speaker.email,
          speaker.name,
          speaker.biography || null,
          submissionId,
          viewer.eventId,
          operationId,
        ),
      );
    }
    const submitterLinkedIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `UPDATE submissions
            SET submitter_person_id = (
              SELECT person.id FROM people person
               WHERE person.email = ? COLLATE NOCASE
            ), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM people person
               WHERE person.email = ? COLLATE NOCASE
            )`,
      ).bind(
        input.submitterEmail,
        submissionId,
        viewer.eventId,
        operationId,
        input.submitterEmail,
      ),
    );
    input.speakers.forEach((speaker, position) => {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO submission_speakers (
             id, event_id, submission_id, person_id, email, display_name,
             position, invitation_status, is_primary, claimed_at, created_at, updated_at
           ) SELECT ?, ?, ?, person.id, ?, ?, ?, 'claimed', ?, unixepoch(), unixepoch(), unixepoch()
               FROM people person
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
          position,
          position === 0 ? 1 : 0,
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
      if (replay) return replay;
      throw new SubmissionStateError(
        "The event tracks, review teams, or session formats changed before the manual application was created. Refresh and try again.",
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
