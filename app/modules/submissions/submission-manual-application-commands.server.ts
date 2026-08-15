import { unacceptedEventParticipantEmails } from "~/modules/speakers/speaker-invitation.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { SubmissionStateError } from "./submission-repository.server";
import {
  ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
  DEFAULT_FORM_SCHEMA,
  type SubmissionFormSchema,
} from "./submission-schema";
import { manualApplicationSchema } from "./submission-service-foundation.server";

import { SubmissionAdministrationCommandFoundation } from "./submission-administration-command-foundation.server";

export class SubmissionManualApplicationCommands extends SubmissionAdministrationCommandFoundation {
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
    if (!event)
      throw new Response("This event could not be found.", { status: 404 });
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
}
