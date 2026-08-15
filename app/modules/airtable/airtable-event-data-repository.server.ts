import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { AirtableRepositoryReconciliationError } from "./airtable-room-repository.server";
import {
  activeLeaseSummary,
  AirtableEventDataProjectionRepository,
  AirtableEventDataUnsynchronizedError,
  AirtableEventProjectionCommitError,
  COMMAND_EXECUTION_LEASE_SECONDS,
  projectionRunSummarySchema,
  sha256,
  stableJson,
  type AirtableEventDataSnapshot,
  type AirtableProjectionCommandResult,
  type AirtableProjectionCommandToken,
  type AirtableProjectionCompletion,
  type ProjectionRunSummary,
} from "./airtable-event-data-projection-repository.server";

export {
  AirtableEventDataSchemaError,
  AirtableEventDataUnsynchronizedError,
  AirtableEventProjectionCommitError,
  type AirtableEventDataEntity,
  type AirtableEventDataPlanItem,
  type AirtableEventDataSnapshot,
  type AirtableProjectionCommandResult,
  type AirtableProjectionCommandToken,
  type AirtableProjectionCompletion,
} from "./airtable-event-data-projection-repository.server";

export class AirtableEventDataRepository extends AirtableEventDataProjectionRepository {
  async beginCommand(
    scope: Pick<Viewer, "organisationId" | "eventId"> & {
      personId: string | null;
    },
    input: {
      idempotencyKey: string;
      operation: string;
      requestHash?: string;
    },
  ): Promise<AirtableProjectionCommandToken> {
    const requestHash =
      input.requestHash ??
      (await sha256(
        stableJson({
          idempotencyKey: input.idempotencyKey,
          operation: input.operation,
        }),
      ));
    const state = await this.assertSynchronized(
      scope.organisationId,
      scope.eventId,
      { bypassCache: true },
    );
    const existing = await this.env.DB.prepare(
      `SELECT id, status, summary_json AS summaryJson FROM integration_runs
        WHERE connection_id = ? AND idempotency_key = ?`,
    )
      .bind(state.connection.id, input.idempotencyKey)
      .first<{ id: string; status: string; summaryJson: string }>();
    if (existing) {
      const summary = projectionRunSummarySchema.parse(
        JSON.parse(existing.summaryJson),
      );
      if (
        summary.eventId !== scope.eventId ||
        summary.operation !== input.operation ||
        summary.requestHash !== requestHash
      )
        throw new AirtableEventDataUnsynchronizedError(
          `Airtable command run ${existing.id} does not match this event operation and request payload.`,
        );
      if (existing.status === "cancelled" && summary.phase === "aborted") {
        const executionLease = crypto.randomUUID();
        const executionLeaseExpiresAt =
          Math.floor(this.now() / 1_000) + COMMAND_EXECUTION_LEASE_SECONDS;
        const restartedSummary: ProjectionRunSummary = {
          kind: "airtable_event_projection",
          phase: "intent_recorded",
          eventId: scope.eventId,
          operation: input.operation,
          requestHash,
          beforeHash: state.d1.hash,
          executionLease,
          executionLeaseExpiresAt,
        };
        const restarted = await this.env.DB.prepare(
          `UPDATE integration_runs
              SET status = 'running', summary_json = ?, completed_at = NULL,
                  started_at = unixepoch()
            WHERE id = ? AND connection_id = ? AND status = 'cancelled'
              AND NOT EXISTS (
                SELECT 1 FROM integration_runs pending
                 WHERE pending.connection_id = ? AND pending.id <> ?
                   AND json_extract(pending.summary_json, '$.kind') = 'airtable_event_projection'
                   AND (
                     pending.status = 'running'
                     OR (
                       pending.status IN ('failed','partially_failed')
                       AND json_extract(pending.summary_json, '$.phase') IN (
                         'd1_committed','external_committed'
                       )
                     )
                   )
              )`,
        )
          .bind(
            JSON.stringify(restartedSummary),
            existing.id,
            state.connection.id,
            state.connection.id,
            existing.id,
          )
          .run();
        if ((restarted.meta.changes ?? 0) !== 1)
          throw new AirtableEventDataUnsynchronizedError(
            `Airtable command run ${existing.id} could not restart safely.`,
          );
        return {
          runId: existing.id,
          connectionId: state.connection.id,
          connectionRevision: state.connection.revision,
          organisationId: scope.organisationId,
          eventId: scope.eventId,
          actorPersonId: scope.personId,
          operation: input.operation,
          requestHash,
          beforeHash: state.d1.hash,
          replayed: false,
          executionLease,
          executionLeaseExpiresAt,
        };
      }
      if (existing.status !== "succeeded")
        throw new AirtableEventDataUnsynchronizedError(
          `Airtable command run ${existing.id} is ${existing.status}; recover it before replaying the command.`,
        );
      return {
        runId: existing.id,
        connectionId: state.connection.id,
        connectionRevision: state.connection.revision,
        organisationId: scope.organisationId,
        eventId: scope.eventId,
        actorPersonId: scope.personId,
        operation: summary.operation,
        requestHash: summary.requestHash,
        beforeHash: summary.beforeHash,
        replayed: true,
        commandResult: summary.commandResult ?? {
          kind: "unavailable",
          reason: "not_recorded",
        },
      };
    }
    const runId = crypto.randomUUID();
    const executionLease = crypto.randomUUID();
    const executionLeaseExpiresAt =
      Math.floor(this.now() / 1_000) + COMMAND_EXECUTION_LEASE_SECONDS;
    const summary: ProjectionRunSummary = {
      kind: "airtable_event_projection",
      phase: "intent_recorded",
      eventId: scope.eventId,
      operation: input.operation,
      requestHash,
      beforeHash: state.d1.hash,
      executionLease,
      executionLeaseExpiresAt,
    };
    const result = await this.env.DB.prepare(
      `INSERT INTO integration_runs (
         id, connection_id, operation_id, idempotency_key, status, direction,
         dry_run, summary_json, started_at, created_at
       )
       SELECT ?, ?, ?, ?, 'running', 'bidirectional', 0, ?, unixepoch(), unixepoch()
        WHERE NOT EXISTS (
          SELECT 1 FROM integration_runs pending
           WHERE pending.connection_id = ?
             AND json_extract(pending.summary_json, '$.kind') = 'airtable_event_projection'
             AND (
               pending.status = 'running'
               OR (
                 pending.status IN ('failed','partially_failed')
                 AND json_extract(pending.summary_json, '$.phase') IN (
                   'd1_committed','external_committed'
                 )
               )
             )
        )`,
    )
      .bind(
        runId,
        state.connection.id,
        input.idempotencyKey,
        input.idempotencyKey,
        JSON.stringify(summary),
        state.connection.id,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1)
      throw new AirtableEventDataUnsynchronizedError(
        "This Airtable event already has an active or recoverable projection command. Complete or recover it before starting another change.",
      );
    return {
      runId,
      connectionId: state.connection.id,
      connectionRevision: state.connection.revision,
      organisationId: scope.organisationId,
      eventId: scope.eventId,
      actorPersonId: scope.personId,
      operation: input.operation,
      requestHash,
      beforeHash: state.d1.hash,
      replayed: false,
      executionLease,
      executionLeaseExpiresAt,
    };
  }

  private async recordCommittedProjection(
    token: AirtableProjectionCommandToken,
    desired: AirtableEventDataSnapshot,
    current: AirtableEventDataSnapshot,
  ) {
    const plan = this.plan(desired, current);
    const summary: ProjectionRunSummary = {
      kind: "airtable_event_projection",
      phase: "d1_committed",
      eventId: token.eventId,
      operation: token.operation,
      requestHash: token.requestHash,
      beforeHash: token.beforeHash,
      afterHash: desired.hash,
      commandResult: token.commandResult ?? {
        kind: "unavailable",
        reason: "not_recorded",
      },
      ...activeLeaseSummary(token),
    };
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE integration_runs SET summary_json = ?
          WHERE id = ? AND connection_id = ? AND status = 'running'`,
      ).bind(JSON.stringify(summary), token.runId, token.connectionId),
      ...plan
        .filter((item) => item.action !== "noop")
        .map((item) =>
          this.env.DB.prepare(
            `INSERT INTO integration_run_items (
               id, run_id, entity_type, entity_id, action, status, diff_json,
               attempt_count, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'running', ?, 0, unixepoch())
             ON CONFLICT(run_id, entity_type, entity_id) DO UPDATE SET
               action = excluded.action, status = 'running',
               diff_json = excluded.diff_json, error_code = NULL,
               error_message = NULL, updated_at = unixepoch()`,
          ).bind(
            crypto.randomUUID(),
            token.runId,
            item.entityType,
            item.entityId,
            item.action,
            JSON.stringify(
              token.operation === "participant.retention.anonymise"
                ? {
                    redacted: true,
                    reason: "participant_retention",
                    beforeHash: token.beforeHash,
                    afterHash: desired.hash,
                  }
                : { before: item.before, after: item.after },
            ),
          ),
        ),
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1))
      throw new AirtableEventProjectionCommitError(
        token.runId,
        "The committed Program Cue copy could not be recorded as a durable Airtable run.",
      );
    return plan;
  }

  async prepareCommandCompletion(
    token: AirtableProjectionCommandToken,
    options: { recovery?: boolean } = {},
  ): Promise<AirtableProjectionCompletion> {
    if (token.replayed)
      throw new AirtableEventDataUnsynchronizedError(
        `Airtable command run ${token.runId} already succeeded; replay the domain command through its idempotency key instead of applying it again.`,
      );
    try {
      const connection = await this.rooms.getConnection(
        token.organisationId,
        token.eventId,
        {
          requireConnected: true,
          allowNeedsAttention: options.recovery,
        },
      );
      if (
        !connection ||
        connection.id !== token.connectionId ||
        connection.revision !== token.connectionRevision
      )
        throw new AirtableEventDataUnsynchronizedError(
          "The Airtable connection changed after the command intent was persisted.",
        );
      const [desired, current] = await Promise.all([
        this.readD1Projection(token.eventId),
        this.readAuthoritative(token.organisationId, token.eventId, {
          bypassCache: true,
          allowNeedsAttention: options.recovery,
        }),
      ]);
      if (current.hash !== token.beforeHash)
        throw new AirtableEventDataUnsynchronizedError(
          "Airtable changed while the Program Cue copy command was running.",
        );
      await this.recordCommittedProjection(token, desired, current);
      await this.writePlan(
        connection,
        token.organisationId,
        token.eventId,
        desired,
        current,
      );
      const summary: ProjectionRunSummary = {
        kind: "airtable_event_projection",
        phase: "external_committed",
        eventId: token.eventId,
        operation: token.operation,
        requestHash: token.requestHash,
        beforeHash: token.beforeHash,
        afterHash: desired.hash,
        commandResult: token.commandResult ?? {
          kind: "unavailable",
          reason: "not_recorded",
        },
        ...activeLeaseSummary(token),
      };
      const result = await this.env.DB.prepare(
        `UPDATE integration_runs SET summary_json = ?
          WHERE id = ? AND connection_id = ? AND status = 'running'`,
      )
        .bind(JSON.stringify(summary), token.runId, token.connectionId)
        .run();
      if ((result.meta.changes ?? 0) !== 1)
        throw new AirtableRepositoryReconciliationError(
          "Airtable committed, but the projection run checkpoint was not recorded.",
        );
      return { ...token, afterHash: desired.hash };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await Promise.all([
        this.env.DB.prepare(
          `UPDATE integration_runs
              SET status = 'partially_failed', completed_at = unixepoch(),
                  summary_json = json_remove(
                    json_set(summary_json, '$.error', ?),
                    '$.executionLease', '$.executionLeaseExpiresAt',
                    '$.recoveryLease'
                  )
            WHERE id = ? AND status = 'running'`,
        )
          .bind(reason, token.runId)
          .run(),
        this.rooms.markNeedsAttention(
          token.organisationId,
          token.eventId,
          reason,
        ),
      ]);
      throw new AirtableEventProjectionCommitError(token.runId, error);
    }
  }

  async finalizeCommand(completion: AirtableProjectionCompletion) {
    const connection = await this.rooms.getConnection(
      completion.organisationId,
      completion.eventId,
      { requireConnected: true, allowNeedsAttention: true },
    );
    if (!connection || connection.id !== completion.connectionId)
      throw new AirtableEventDataUnsynchronizedError(
        "The Airtable connection for this projection run is no longer available.",
      );
    const d1 = await this.readD1Projection(completion.eventId);
    if (d1.hash !== completion.afterHash)
      throw new AirtableEventDataUnsynchronizedError(
        "The Program Cue copy changed before the Airtable command could finalize.",
      );
    // prepareCommandCompletion has already read the provider back and matched
    // its complete snapshot hash. A later external edit is detected at the next
    // read boundary; repeating all managed table reads here only narrows that
    // race and materially increases Airtable request amplification.
    const summary: ProjectionRunSummary = {
      kind: "airtable_event_projection",
      phase: "finalized",
      eventId: completion.eventId,
      operation: completion.operation,
      requestHash: completion.requestHash,
      beforeHash: completion.beforeHash,
      afterHash: completion.afterHash,
      commandResult: completion.commandResult ?? {
        kind: "unavailable",
        reason: "not_recorded",
      },
    };
    const results = await this.env.DB.batch([
      this.mappingStatement(
        completion.connectionId,
        completion.eventId,
        completion.afterHash,
      ),
      this.env.DB.prepare(
        `UPDATE integration_run_items
            SET status = 'succeeded', attempt_count = 1,
                updated_at = unixepoch()
          WHERE run_id = ? AND status = 'running'`,
      ).bind(completion.runId),
      this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = 'succeeded', summary_json = ?, completed_at = unixepoch()
          WHERE id = ? AND connection_id = ?
            AND status IN ('running','partially_failed')`,
      ).bind(
        JSON.stringify(summary),
        completion.runId,
        completion.connectionId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, 'person', 'admin_ui', 1, ?, ?, ?, 'airtable.event_data.command_reconciled',
                   'event', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        completion.organisationId,
        completion.eventId,
        completion.actorPersonId,
        completion.eventId,
        completion.runId,
        JSON.stringify({
          operation: completion.operation,
          beforeHash: completion.beforeHash,
          afterHash: completion.afterHash,
        }),
      ),
      this.env.DB.prepare(
        `UPDATE integration_connections
            SET status = 'connected', updated_at = unixepoch()
          WHERE id = ? AND status = 'needs_attention'`,
      ).bind(completion.connectionId),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    )
      throw new AirtableEventDataUnsynchronizedError(
        "The Airtable command reconciled but its mapping, run, or audit did not finalize.",
      );
    return { runId: completion.runId, hash: completion.afterHash };
  }

  async completeCommand(
    token: AirtableProjectionCommandToken,
    commandResult: AirtableProjectionCommandResult = {
      kind: "unavailable",
      reason: "not_recorded",
    },
  ) {
    const completion = await this.prepareCommandCompletion({
      ...token,
      commandResult,
    });
    return this.finalizeCommand(completion);
  }

  async failCommandResult(
    token: AirtableProjectionCommandToken,
    cause: unknown,
  ): Promise<never> {
    const desired = await this.readD1Projection(token.eventId);
    const reason = cause instanceof Error ? cause.message : String(cause);
    const summary: ProjectionRunSummary = {
      kind: "airtable_event_projection",
      phase: "d1_committed",
      eventId: token.eventId,
      operation: token.operation,
      requestHash: token.requestHash,
      beforeHash: token.beforeHash,
      afterHash: desired.hash,
      commandResult: { kind: "unavailable", reason: "not_recorded" },
      error: reason,
    };
    const [recorded] = await Promise.all([
      this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = 'partially_failed', completed_at = unixepoch(),
                summary_json = ?
          WHERE id = ? AND connection_id = ? AND status = 'running'`,
      )
        .bind(JSON.stringify(summary), token.runId, token.connectionId)
        .run(),
      this.rooms.markNeedsAttention(
        token.organisationId,
        token.eventId,
        reason,
      ),
    ]);
    if ((recorded.meta.changes ?? 0) !== 1)
      throw new AirtableEventProjectionCommitError(
        token.runId,
        "The committed Program Cue copy could not be checkpointed for Airtable recovery.",
      );
    throw new AirtableEventProjectionCommitError(token.runId, cause);
  }

  async abortCommand(token: AirtableProjectionCommandToken, cause: unknown) {
    const d1 = await this.readD1Projection(token.eventId);
    if (d1.hash !== token.beforeHash) {
      return this.failCommandResult(
        token,
        cause instanceof Error
          ? cause
          : new Error(
              "The domain command reported failure after changing the Program Cue copy.",
            ),
      );
    }
    const summary: ProjectionRunSummary = {
      kind: "airtable_event_projection",
      phase: "aborted",
      eventId: token.eventId,
      operation: token.operation,
      requestHash: token.requestHash,
      beforeHash: token.beforeHash,
      error: cause instanceof Error ? cause.message : String(cause),
    };
    await this.env.DB.prepare(
      `UPDATE integration_runs
          SET status = 'cancelled', summary_json = ?, completed_at = unixepoch()
        WHERE id = ? AND status = 'running'`,
    )
      .bind(JSON.stringify(summary), token.runId)
      .run();
  }

  async recoverCommand(
    scope: Pick<Viewer, "organisationId" | "eventId"> & {
      personId: string | null;
    },
    runId: string,
  ) {
    const connection = await this.rooms.getConnection(
      scope.organisationId,
      scope.eventId,
      { requireConnected: true, allowNeedsAttention: true },
    );
    if (!connection)
      throw new AirtableEventDataUnsynchronizedError(
        "Airtable event repository connection not found.",
      );
    const row = await this.env.DB.prepare(
      `SELECT status, summary_json AS summaryJson FROM integration_runs
        WHERE id = ? AND connection_id = ?`,
    )
      .bind(runId, connection.id)
      .first<{ status: string; summaryJson: string }>();
    if (!row)
      throw new AirtableEventDataUnsynchronizedError(
        "Airtable projection run not found.",
      );
    if (row.status === "succeeded") return { runId, idempotent: true };
    const summary = projectionRunSummarySchema.parse(
      JSON.parse(row.summaryJson),
    );
    if (summary.operation === "event_setup.save") {
      const [event, roomRows] = await Promise.all([
        this.env.DB.prepare(
          `SELECT revision FROM events
            WHERE id = ? AND organisation_id = ?`,
        )
          .bind(scope.eventId, scope.organisationId)
          .first<{ revision: number }>(),
        this.env.DB.prepare(
          `SELECT id, name, capacity, resources_json AS resourcesJson, position
             FROM rooms
            WHERE event_id = ? AND status = 'active'
            ORDER BY position, name, id`,
        )
          .bind(scope.eventId)
          .all<{
            id: string;
            name: string;
            capacity: number;
            resourcesJson: string;
            position: number;
          }>(),
      ]);
      if (!event)
        throw new AirtableEventDataUnsynchronizedError(
          "The event for this Airtable projection no longer exists.",
        );
      await this.rooms.replaceRooms(
        scope.organisationId,
        scope.eventId,
        roomRows.results.map((room) => ({
          id: room.id,
          name: room.name,
          capacity: room.capacity,
          resources: z.array(z.string()).parse(JSON.parse(room.resourcesJson)),
          position: room.position,
        })),
        event.revision,
        { allowNeedsAttention: true },
      );
    }
    const [d1, airtable] = await Promise.all([
      this.readD1Projection(scope.eventId),
      this.readAuthoritative(scope.organisationId, scope.eventId, {
        bypassCache: true,
        allowNeedsAttention: true,
      }),
    ]);
    if (
      d1.hash === summary.beforeHash &&
      airtable.hash === summary.beforeHash &&
      summary.phase === "intent_recorded"
    ) {
      await this.env.DB.prepare(
        `UPDATE integration_runs SET status = 'cancelled', completed_at = unixepoch(),
                summary_json = json_set(summary_json, '$.phase', 'aborted')
          WHERE id = ? AND status IN ('running','failed','partially_failed')`,
      )
        .bind(runId)
        .run();
      return { runId, idempotent: false, aborted: true };
    }
    const afterHash = summary.afterHash ?? d1.hash;
    if (d1.hash !== afterHash)
      throw new AirtableEventDataUnsynchronizedError(
        "The Program Cue copy changed again after the interrupted Airtable command.",
      );
    const token: AirtableProjectionCommandToken = {
      runId,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      organisationId: scope.organisationId,
      eventId: scope.eventId,
      actorPersonId: scope.personId,
      operation: summary.operation,
      requestHash: summary.requestHash,
      beforeHash: summary.beforeHash,
      replayed: false,
      commandResult: summary.commandResult ?? {
        kind: "unavailable",
        reason: "not_recorded",
      },
      recoveryLease: summary.recoveryLease,
    };
    if (airtable.hash !== afterHash) {
      if (airtable.hash !== summary.beforeHash)
        throw new AirtableEventDataUnsynchronizedError(
          "Airtable diverged from both the before and committed projection hashes.",
        );
      await this.env.DB.prepare(
        `UPDATE integration_runs SET status = 'running', completed_at = NULL
          WHERE id = ? AND status IN ('failed','partially_failed')`,
      )
        .bind(runId)
        .run();
      const completion = await this.prepareCommandCompletion(token, {
        recovery: true,
      });
      return this.finalizeCommand(completion);
    }
    const completion: AirtableProjectionCompletion = { ...token, afterHash };
    return this.finalizeCommand(completion);
  }
}
