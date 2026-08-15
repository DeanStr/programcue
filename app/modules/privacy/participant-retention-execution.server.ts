import { z } from "zod";
import { airtableCommandKey } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ParticipantRetentionAnalysis } from "./participant-retention-analysis.server";
import { buildParticipantRetentionFinalisationStatements } from "./participant-retention-finalisation-statements.server";
import {
  MAX_PARTICIPANTS_PER_BATCH,
  ParticipantRetentionConfirmationError,
  ParticipantRetentionStateError,
  RETAINED_PERSON_PREFIX,
  completionId,
  eventClaimGuard,
  mapStatement,
  participantIdBindings,
  participantPredicateSql,
  requireOwner,
  type CompletionMetadata,
  type ParticipantCandidate,
} from "./participant-retention-foundation.server";

export abstract class ParticipantRetentionExecution extends ParticipantRetentionAnalysis {
  protected claimStatement(
    viewer: Viewer,
    operationId: string,
    confirmedEventName: string,
    requireNoParticipants = false,
  ) {
    return this.env.DB.prepare(
      `UPDATE events
          SET last_operation_id = ?, updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ?
          AND name = ?
          AND file_retention_hold_at IS NULL
          AND participant_retention_completed_at IS NULL
          AND unixepoch(datetime(ends_at, 'unixepoch',
                '+' || retention_months || ' months')) <= unixepoch()
          AND NOT EXISTS (
            SELECT 1 FROM audit_events WHERE id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM form_definitions
             WHERE event_id = events.id AND status = 'published'
          )
          AND NOT EXISTS (
            SELECT 1 FROM file_assets asset
             WHERE asset.event_id = events.id
               AND NOT EXISTS (
                 SELECT 1 FROM audit_events erased
                  WHERE erased.id = 'file-erasure-complete:' || asset.id
               )
          )
          AND NOT EXISTS (
            SELECT 1 FROM operation_jobs operation
             WHERE operation.event_id = events.id
               AND operation.status = 'running'
          )
          AND NOT EXISTS (
            SELECT 1 FROM communications
             WHERE event_id = events.id AND status = 'sending'
          )
          AND NOT EXISTS (
            SELECT 1 FROM calendar_sync_attempts attempt
             JOIN calendar_invitations invitation ON invitation.id = attempt.invitation_id
             WHERE invitation.event_id = events.id AND attempt.status = 'running'
          )
          AND NOT EXISTS (
            SELECT 1 FROM calendar_invitations invitation
             WHERE invitation.event_id = events.id
               AND invitation.method <> 'CANCEL'
               AND invitation.status IN ('pending','queued','sent','confirmed','failed')
          )
          AND NOT EXISTS (
            SELECT 1 FROM integration_runs run
             JOIN integration_connections connection ON connection.id = run.connection_id
             WHERE connection.event_id = events.id AND run.status = 'running'
               AND NOT (
                 json_extract(run.summary_json, '$.kind') = 'airtable_event_projection'
                 AND json_extract(run.summary_json, '$.operation') =
                     'participant.retention.anonymise'
               )
          )
          AND NOT EXISTS (
            SELECT 1 FROM webhook_deliveries delivery
             JOIN webhook_endpoints endpoint ON endpoint.id = delivery.endpoint_id
             WHERE endpoint.event_id = events.id AND delivery.status = 'delivering'
          )
          ${
            requireNoParticipants
              ? `AND NOT EXISTS (
                   SELECT 1 FROM people person
                    WHERE ${participantPredicateSql}
                      AND person.id NOT LIKE '${RETAINED_PERSON_PREFIX}%'
                 )`
              : ""
          }`,
    ).bind(
      operationId,
      viewer.eventId,
      viewer.organisationId,
      confirmedEventName,
      completionId(viewer.eventId),
      ...(requireNoParticipants ? participantIdBindings(viewer.eventId) : []),
    );
  }

  protected async remapBatch(
    viewer: Viewer,
    candidates: ParticipantCandidate[],
    confirmedEventName: string,
  ) {
    const operationId = crypto.randomUUID();
    const mappings = await this.buildMappings(viewer, operationId, candidates);
    if (mappings.length === 0) return;

    const existing = await this.env.DB.prepare(
      `SELECT id, email FROM people WHERE id IN (${mappings.map(() => "?").join(",")})`,
    )
      .bind(...mappings.map((mapping) => mapping.pseudonymId))
      .all<{ id: string; email: string }>();
    for (const row of existing.results) {
      const expected = mappings.find(
        (mapping) => mapping.pseudonymId === row.id,
      );
      if (!expected || row.email !== expected.pseudonymEmail) {
        throw new ParticipantRetentionStateError(
          "A retained participant identifier collides with an existing identity.",
        );
      }
    }

    const statements = [
      this.claimStatement(viewer, operationId, confirmedEventName),
      this.env.DB.prepare(
        `DELETE FROM event_participant_profiles
          WHERE event_id = ? AND organisation_id = ?
            AND person_id IN (${mappings.map(() => "?").join(",")})
            AND ${eventClaimGuard()}`,
      ).bind(
        viewer.eventId,
        viewer.organisationId,
        ...mappings.map((mapping) => mapping.id),
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      ...mappings.map((mapping) =>
        this.env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, image_url, biography,
             pronunciation, organisation_name, job_title, profile_status,
             created_at, updated_at
           )
           SELECT ?, ?, 'Anonymised participant', 0, NULL, NULL, NULL, NULL,
                  NULL, 'archived', unixepoch(), unixepoch()
            WHERE ${eventClaimGuard()}
              AND EXISTS (
                SELECT 1 FROM people person
                 WHERE person.id = ? AND ${participantPredicateSql}
              )`,
        ).bind(
          mapping.pseudonymId,
          mapping.pseudonymEmail,
          viewer.eventId,
          viewer.organisationId,
          operationId,
          mapping.id,
          ...participantIdBindings(viewer.eventId),
        ),
      ),
      mapStatement(
        this.env,
        mappings,
        "memberships",
        "person_id",
        "event_id = ?",
        "role IN ('submitter','speaker')",
      ),
      mapStatement(this.env, mappings, "submissions", "submitter_person_id"),
      mapStatement(
        this.env,
        mappings,
        "submission_revisions",
        "saved_by_person_id",
      ),
      mapStatement(this.env, mappings, "submission_speakers", "person_id"),
      mapStatement(this.env, mappings, "session_speakers", "person_id"),
      mapStatement(this.env, mappings, "event_speaker_workflows", "person_id"),
      mapStatement(
        this.env,
        mappings,
        "event_speaker_workflows",
        "updated_by_person_id",
      ),
      mapStatement(this.env, mappings, "public_itineraries", "person_id"),
      mapStatement(
        this.env,
        mappings,
        "task_instances",
        "owner_person_id",
        "event_id = ?",
        "target_type = 'speaker'",
      ),
      mapStatement(
        this.env,
        mappings,
        "task_instances",
        "completed_by_person_id",
        "event_id = ?",
        "target_type = 'speaker'",
      ),
      mapStatement(
        this.env,
        mappings,
        "task_comments",
        "author_person_id",
        "event_id = ?",
        "task_id IN (SELECT id FROM task_instances WHERE event_id = task_comments.event_id AND target_type = 'speaker')",
      ),
      mapStatement(
        this.env,
        mappings,
        "evaluation_discussion_messages",
        "author_person_id",
        "event_id = ?",
      ),
      mapStatement(
        this.env,
        mappings,
        "file_assets",
        "owner_person_id",
        "event_id = ?",
        "target_type IN ('person','submission','session','task')",
      ),
      mapStatement(
        this.env,
        mappings,
        "file_versions",
        "created_by_person_id",
        "event_id = ?",
        "asset_id IN (SELECT id FROM file_assets WHERE event_id = file_versions.event_id AND target_type IN ('person','submission','session','task'))",
      ),
      mapStatement(
        this.env,
        mappings,
        "task_evidence",
        "submitted_by_person_id",
        "event_id = ?",
        "task_id IN (SELECT id FROM task_instances WHERE event_id = task_evidence.event_id AND target_type = 'speaker')",
      ),
      mapStatement(
        this.env,
        mappings,
        "resource_acknowledgements",
        "person_id",
      ),
      mapStatement(this.env, mappings, "communication_deliveries", "person_id"),
      mapStatement(
        this.env,
        mappings,
        "communication_unsubscribes",
        "person_id",
      ),
      mapStatement(
        this.env,
        mappings,
        "calendar_connections",
        "person_id",
        "event_id = ?",
      ),
      mapStatement(this.env, mappings, "calendar_invitations", "person_id"),
      mapStatement(
        this.env,
        mappings,
        "task_instances",
        "target_id",
        "event_id = ?",
        "target_type = 'speaker'",
      ),
      mapStatement(
        this.env,
        mappings,
        "file_assets",
        "target_id",
        "event_id = ?",
        "target_type = 'person'",
      ),
      mapStatement(
        this.env,
        mappings,
        "resource_audiences",
        "target_id",
        "event_id = ?",
        "target_type = 'person'",
      ),
      this.env.DB.prepare(
        `UPDATE memberships
            SET revoked_at = COALESCE(revoked_at, unixepoch())
          WHERE event_id = ?
            AND person_id IN (${mappings.map(() => "?").join(",")})
            AND ${eventClaimGuard()}`,
      ).bind(
        viewer.eventId,
        ...mappings.map((mapping) => mapping.pseudonymId),
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      ...mappings
        .filter((mapping) => !mapping.shared)
        .flatMap((mapping) => [
          this.env.DB.prepare(
            `UPDATE people
                SET email = ?, display_name = 'Anonymised participant',
                    email_verified = 0, image_url = NULL, biography = NULL,
                    pronunciation = NULL, organisation_name = NULL,
                    job_title = NULL, linkedin_url = NULL, x_handle = NULL,
                    profile_status = 'archived',
                    last_operation_id = ?, updated_at = unixepoch()
              WHERE id = ? AND ${eventClaimGuard()}
                AND EXISTS (SELECT 1 FROM people retained WHERE retained.id = ?)
                AND NOT EXISTS (
                  SELECT 1 FROM memberships other WHERE other.person_id = people.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM submissions other
                   WHERE other.submitter_person_id = people.id AND other.event_id <> ?
                )
                AND NOT EXISTS (
                  SELECT 1 FROM submission_speakers other
                   WHERE other.person_id = people.id AND other.event_id <> ?
                )
                AND NOT EXISTS (
                  SELECT 1 FROM session_speakers other
                   WHERE other.person_id = people.id AND other.event_id <> ?
                )
                AND NOT EXISTS (
                  SELECT 1 FROM audit_events other
                   WHERE other.actor_person_id = people.id
                     AND (other.event_id IS NULL OR other.event_id <> ?)
                )`,
          ).bind(
            mapping.retiredEmail,
            `participant-retention:${viewer.eventId}`,
            mapping.id,
            viewer.eventId,
            viewer.organisationId,
            operationId,
            mapping.pseudonymId,
            viewer.eventId,
            viewer.eventId,
            viewer.eventId,
            viewer.eventId,
          ),
          this.env.DB.prepare(
            `DELETE FROM auth_sessions
              WHERE person_id = ?
                AND EXISTS (SELECT 1 FROM people WHERE id = ? AND email = ?)
                AND ${eventClaimGuard()}`,
          ).bind(
            mapping.id,
            mapping.id,
            mapping.retiredEmail,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
          this.env.DB.prepare(
            `DELETE FROM auth_accounts
              WHERE person_id = ?
                AND EXISTS (SELECT 1 FROM people WHERE id = ? AND email = ?)
                AND ${eventClaimGuard()}`,
          ).bind(
            mapping.id,
            mapping.id,
            mapping.retiredEmail,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
          this.env.DB.prepare(
            `DELETE FROM verification_tokens
              WHERE identifier = ? COLLATE NOCASE
                AND EXISTS (SELECT 1 FROM people WHERE id = ? AND email = ?)
                AND ${eventClaimGuard()}`,
          ).bind(
            mapping.email,
            mapping.id,
            mapping.retiredEmail,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
          this.env.DB.prepare(
            `UPDATE calendar_connections
                SET status = 'disconnected', account_reference = 'retained-' || id,
                    encrypted_credentials = NULL, scopes_json = '[]',
                    expires_at = NULL, last_synced_at = NULL,
                    updated_at = unixepoch()
              WHERE person_id = ? AND organisation_id = ?
                AND EXISTS (SELECT 1 FROM people WHERE id = ? AND email = ?)
                AND ${eventClaimGuard()}`,
          ).bind(
            mapping.id,
            viewer.organisationId,
            mapping.id,
            mapping.retiredEmail,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
        ]),
      ...mappings.map((mapping) =>
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, ?, 'participant.retention.subject_anonymised',
                  'person', ?, ?, unixepoch()
            WHERE ${eventClaimGuard()}
              AND EXISTS (SELECT 1 FROM people WHERE id = ?)`,
        ).bind(
          mapping.subjectAuditId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          mapping.pseudonymId,
          JSON.stringify({
            version: 1,
            sharedIdentity: mapping.shared,
            immutableAuditRows: mapping.immutableAuditRows,
          }),
          viewer.eventId,
          viewer.organisationId,
          operationId,
          mapping.pseudonymId,
        ),
      ),
    ];
    const results = await this.env.DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const latest = await this.preview(viewer);
      if (latest.completed) return;
      throw new ParticipantRetentionStateError(
        latest.blockers[0] ??
          "Participant retention changed concurrently. Review the latest preview before retrying.",
      );
    }
  }

  protected async finalise(
    viewer: Viewer,
    preview: Awaited<ReturnType<ParticipantRetentionAnalysis["preview"]>>,
  ) {
    const operationId = crypto.randomUUID();
    const completionMetadata: CompletionMetadata = {
      version: 1,
      scope: "local_event_data",
      repositoryProvider: preview.repositoryProvider,
      externalProviderErasureRequired: preview.externalProviderErasureRequired,
      immutableAuditRecords: preview.immutableAuditRecords,
      sharedIdentityAuditLinks: preview.sharedIdentityAuditLinks,
      retainedProgrammeRecords: preview.retainedProgrammeRecords,
      unscopedStoresNotAutomaticallyRedacted:
        preview.unscopedStoresNotAutomaticallyRedacted,
    };
    const statements = buildParticipantRetentionFinalisationStatements(
      this.env,
      viewer,
      operationId,
      completionMetadata,
      this.claimStatement(viewer, operationId, preview.name, true),
    );
    const results = await this.env.DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const latest = await this.preview(viewer);
      if (latest.completed) return { duplicate: true };
      throw new ParticipantRetentionStateError(
        latest.blockers[0] ??
          "Participant retention changed concurrently. Review the latest preview before retrying.",
      );
    }
    const marker = results.at(-2);
    const completion = results.at(-1);
    if (
      (marker?.meta.changes ?? 0) !== 1 ||
      (completion?.meta.changes ?? 0) !== 1
    ) {
      throw new ParticipantRetentionStateError(
        "Participant records changed during final anonymisation. Review and retry.",
      );
    }
    return { duplicate: false };
  }

  async anonymiseExpiredParticipants(
    viewer: Viewer,
    input: { confirmation: string; acknowledged: boolean; limit?: number },
  ) {
    requireOwner(viewer);
    const preview = await this.preview(viewer);
    if (!input.acknowledged || input.confirmation !== preview.name)
      throw new ParticipantRetentionConfirmationError();
    if (preview.integrityViolations.length > 0) {
      throw new ParticipantRetentionStateError(
        `Participant-retention integrity check failed: ${preview.integrityViolations[0]}`,
      );
    }
    if (preview.completed) {
      return { duplicate: true, complete: true, state: preview };
    }
    if (preview.blockers.length > 0)
      throw new ParticipantRetentionStateError(preview.blockers[0]!);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(MAX_PARTICIPANTS_PER_BATCH)
      .parse(input.limit ?? MAX_PARTICIPANTS_PER_BATCH);
    const operation = "participant.retention.anonymise";
    const idempotencyKey = await airtableCommandKey(operation, viewer, {
      confirmation: input.confirmation,
      acknowledged: input.acknowledged,
      limit,
      pendingParticipants: preview.pendingParticipants,
      anonymisedParticipants: preview.anonymisedParticipants,
      completed: preview.completed,
    });
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation },
      async () => {
        this.projectionDepth += 1;
        try {
          return await this.anonymiseExpiredParticipantsD1(
            viewer,
            preview,
            limit,
          );
        } finally {
          this.projectionDepth -= 1;
        }
      },
    );
  }

  protected async anonymiseExpiredParticipantsD1(
    viewer: Viewer,
    preview: Awaited<ReturnType<ParticipantRetentionAnalysis["preview"]>>,
    limit: number,
  ) {
    const batch = await this.candidates(viewer, limit);
    if (batch.length > 0) await this.remapBatch(viewer, batch, preview.name);
    const afterBatch = await this.preview(viewer);
    if (afterBatch.completed) {
      return { duplicate: true, complete: true, state: afterBatch };
    }
    if (afterBatch.pendingParticipants > 0) {
      return { duplicate: false, complete: false, state: afterBatch };
    }
    if (afterBatch.blockers.length > 0)
      throw new ParticipantRetentionStateError(afterBatch.blockers[0]!);
    const finalised = await this.finalise(viewer, afterBatch);
    return {
      duplicate: finalised.duplicate,
      complete: true,
      state: await this.preview(viewer),
    };
  }
}
