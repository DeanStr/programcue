import type { Viewer } from "~/platform/auth/authorize.server";
import { scheduleConflictInsert } from "./schedule-conflict-statement.server";
import {
  ScheduleIdempotencyConflictError,
  ScheduleNotFoundError,
  ScheduleRevisionConflictError,
  ScheduleConfigurationError,
} from "./schedule-errors";
import {
  AUTO_ENTRY_PREFIX,
  canonicalAutoPlacementPlan,
  canonicalAutoPlacementSessionRevisions,
  computeAutoPlacements,
  plannedAutoEntryId,
  revalidateSelectedAutoPlacements,
  type AutoPlacementPreview,
  type AutoPlacementProposal,
  type AutoPlacementUnplaced,
} from "./schedule-auto-placement";
import {
  MAX_AUTO_PLACEMENT_SESSIONS,
  scheduleAutoPlacementConfirmSchema,
  type ScheduleAutoPlacementConfirmInput,
} from "./schedule-schema";
import type {
  ScheduleAutoPlacementResult,
  ScheduleEventScope,
  ScheduleWorkspace,
} from "./schedule-service.server";

const AUTO_PLACEMENT_SCOPE = "schedule.auto_place";

// Keep room below Workers' per-invocation D1 query limit for the workspace,
// authority and replay queries surrounding the atomic placement batch.
export const MAX_AUTO_PLACEMENT_D1_STATEMENTS = 800;

export function autoPlacementD1StatementCount(
  computation: Pick<ReturnType<typeof computeAutoPlacements>, "placements">,
) {
  if (!computation.placements.length) return 3;
  return (
    6 +
    computation.placements.reduce(
      (count, placement) => count + 2 + placement.warnings.length,
      0,
    )
  );
}

function parseResult(value: unknown): ScheduleAutoPlacementResult {
  if (!value || typeof value !== "object") {
    throw new Error(
      "The completed auto-placement command is missing its durable result.",
    );
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.scheduleVersionId !== "string" ||
    typeof result.scheduleRevision !== "number" ||
    !Number.isSafeInteger(result.scheduleRevision) ||
    typeof result.appliedCount !== "number" ||
    !Number.isSafeInteger(result.appliedCount) ||
    result.appliedCount < 0 ||
    typeof result.excludedCount !== "number" ||
    !Number.isSafeInteger(result.excludedCount) ||
    result.excludedCount < 0 ||
    typeof result.unplacedCount !== "number" ||
    !Number.isSafeInteger(result.unplacedCount) ||
    result.unplacedCount < 0
  ) {
    throw new Error(
      "The completed auto-placement command has an invalid durable result.",
    );
  }
  return result as ScheduleAutoPlacementResult;
}

function sameSessionRevisions(
  left: ReadonlyArray<{ sessionId: string; revision: number }>,
  right: ReadonlyArray<{ sessionId: string; revision: number }>,
) {
  return (
    JSON.stringify(canonicalAutoPlacementSessionRevisions(left)) ===
    JSON.stringify(canonicalAutoPlacementSessionRevisions(right))
  );
}

function samePlan(
  input: Pick<ScheduleAutoPlacementConfirmInput, "placements" | "unplaced">,
  computation: Pick<
    ReturnType<typeof computeAutoPlacements>,
    "placements" | "unplaced"
  >,
) {
  return (
    JSON.stringify(canonicalAutoPlacementPlan(input)) ===
    JSON.stringify(canonicalAutoPlacementPlan(computation))
  );
}

function previewStale(message: string) {
  return new ScheduleRevisionConflictError(message);
}

function assertSupportedSessionCount(workspace: ScheduleWorkspace) {
  const scheduledIds = new Set(
    workspace.entries.map((entry) => entry.sessionId),
  );
  const unscheduledCount = workspace.sessions.filter(
    (session) =>
      session.status === "unscheduled" && !scheduledIds.has(session.id),
  ).length;
  if (unscheduledCount > MAX_AUTO_PLACEMENT_SESSIONS) {
    throw new ScheduleConfigurationError(
      `Auto-place preview supports at most ${MAX_AUTO_PLACEMENT_SESSIONS} unscheduled sessions. Place some sessions manually before preparing another preview.`,
    );
  }
}

function assertAutoPlacementBatchFits(
  computation: Pick<ReturnType<typeof computeAutoPlacements>, "placements">,
) {
  const statementCount = autoPlacementD1StatementCount(computation);
  if (statementCount > MAX_AUTO_PLACEMENT_D1_STATEMENTS) {
    throw new ScheduleConfigurationError(
      `Auto-place cannot apply this proposal atomically because it requires ${statementCount} D1 statements; the safe limit is ${MAX_AUTO_PLACEMENT_D1_STATEMENTS}. Prepare a fresh preview and select fewer proposed placements.`,
    );
  }
}

export class ScheduleAutoPlacementWorkflow {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: {
      getWorkspace: (viewer: ScheduleEventScope) => Promise<ScheduleWorkspace>;
    },
  ) {}

  private getWorkspace(viewer: ScheduleEventScope) {
    return this.dependencies.getWorkspace(viewer);
  }

  private assertDraft(
    workspace: ScheduleWorkspace,
    scheduleVersionId: string,
    scheduleRevision: number,
  ) {
    if (
      !workspace.version ||
      workspace.version.id !== scheduleVersionId ||
      workspace.version.status !== "draft"
    ) {
      throw new ScheduleNotFoundError(
        "Auto-place assistance requires an active draft schedule. Create the next draft before placing sessions.",
      );
    }
    if (workspace.version.revision !== scheduleRevision) {
      throw previewStale(
        "The draft schedule changed after this auto-place preview. Prepare a fresh preview before confirming placements.",
      );
    }
  }

  async preview(viewer: ScheduleEventScope): Promise<AutoPlacementPreview> {
    const workspace = await this.getWorkspace(viewer);
    if (!workspace.version || workspace.version.status !== "draft") {
      throw new ScheduleNotFoundError(
        "Auto-place assistance requires an active draft schedule. Create the next draft before placing sessions.",
      );
    }
    assertSupportedSessionCount(workspace);
    const computation = computeAutoPlacements(workspace);
    return {
      idempotencyKey: crypto.randomUUID(),
      scheduleVersionId: workspace.version.id,
      scheduleRevision: workspace.version.revision,
      eventRevision: workspace.event.revision,
      policyRevision: workspace.policyRevision,
      ...computation,
      selectedSessionIds: computation.placements.map(
        (placement) => placement.sessionId,
      ),
    };
  }

  private async replay(
    viewer: Viewer,
    parsed: ScheduleAutoPlacementConfirmInput,
    requestHash: string,
  ): Promise<ScheduleAutoPlacementResult | null> {
    const record = await this.env.DB.prepare(
      `SELECT request_hash AS requestHash, status, response_json AS responseJson
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        AUTO_PLACEMENT_SCOPE,
        parsed.idempotencyKey,
      )
      .first<{
        requestHash: string;
        status: "processing" | "completed" | "failed";
        responseJson: string | null;
      }>();
    if (!record) return null;
    if (record.requestHash !== requestHash) {
      throw new ScheduleIdempotencyConflictError(
        "IDEMPOTENCY_KEY_REUSED",
        "This auto-place confirmation identifier was already used for a different preview.",
      );
    }
    if (record.status !== "completed") {
      throw new ScheduleIdempotencyConflictError(
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        record.status === "failed"
          ? "This auto-place confirmation did not complete. Prepare a fresh preview before retrying."
          : "This auto-place confirmation is still being processed. Retry the same confirmation shortly.",
      );
    }
    if (!record.responseJson) {
      throw new Error(
        "The completed auto-placement command is missing its durable response.",
      );
    }
    try {
      return parseResult(JSON.parse(record.responseJson));
    } catch (error) {
      if (error instanceof Error && error.message.includes("durable"))
        throw error;
      throw new Error(
        "The completed auto-placement command has an invalid durable response.",
      );
    }
  }

  async confirmD1(
    viewer: Viewer,
    input: unknown,
    requestHash: string,
  ): Promise<ScheduleAutoPlacementResult> {
    const parsed = scheduleAutoPlacementConfirmSchema.parse(input);
    const replay = await this.replay(viewer, parsed, requestHash);
    if (replay) return replay;

    const workspace = await this.getWorkspace(viewer);
    this.assertDraft(
      workspace,
      parsed.scheduleVersionId,
      parsed.scheduleRevision,
    );
    if (workspace.event.revision !== parsed.eventRevision) {
      throw previewStale(
        "Event configuration changed after this auto-place preview. Prepare a fresh preview before confirming placements.",
      );
    }
    if (workspace.policyRevision !== parsed.policyRevision) {
      throw previewStale(
        "Schedule conflict policy changed after this auto-place preview. Prepare a fresh preview before confirming placements.",
      );
    }

    assertSupportedSessionCount(workspace);
    const computation = computeAutoPlacements(workspace);
    if (
      !sameSessionRevisions(
        parsed.sessionRevisions,
        computation.sessionRevisions,
      )
    ) {
      throw previewStale(
        "One or more unscheduled sessions changed after this auto-place preview. Prepare a fresh preview before confirming placements.",
      );
    }
    if (!samePlan(parsed, computation)) {
      throw previewStale(
        "The auto-place proposal no longer matches the current draft. Prepare a fresh preview before confirming placements.",
      );
    }

    const proposedSessionIds = new Set(
      computation.placements.map((placement) => placement.sessionId),
    );
    if (
      parsed.selectedSessionIds.some(
        (sessionId) => !proposedSessionIds.has(sessionId),
      )
    ) {
      throw previewStale(
        "The selected sessions are not part of this verified auto-place proposal. Prepare a fresh preview.",
      );
    }
    const selectedIds = new Set(parsed.selectedSessionIds);
    const selectedPlacements = computation.placements.filter((placement) =>
      selectedIds.has(placement.sessionId),
    );
    const revalidatedPlacements = revalidateSelectedAutoPlacements(
      workspace,
      selectedPlacements,
    );
    if (!revalidatedPlacements) {
      throw previewStale(
        "A selected placement now conflicts with the draft schedule. Prepare a fresh preview.",
      );
    }
    assertAutoPlacementBatchFits({ placements: revalidatedPlacements });
    const result: ScheduleAutoPlacementResult = {
      scheduleVersionId: parsed.scheduleVersionId,
      scheduleRevision:
        parsed.scheduleRevision + (revalidatedPlacements.length ? 1 : 0),
      appliedCount: revalidatedPlacements.length,
      excludedCount:
        computation.placements.length - revalidatedPlacements.length,
      unplacedCount: computation.unplaced.length,
    };

    const commandId = crypto.randomUUID();
    if (!revalidatedPlacements.length) {
      const results = await this.env.DB.batch([
        this.env.DB.prepare(
          `DELETE FROM idempotency_records
            WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
              AND scope = ? AND idempotency_key = ?
              AND expires_at <= unixepoch()`,
        ).bind(
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          AUTO_PLACEMENT_SCOPE,
          parsed.idempotencyKey,
        ),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO idempotency_records (
             id, organisation_id, event_id, actor_id, scope, idempotency_key,
             request_hash, status, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
                     unixepoch() + 2592000, unixepoch())`,
        ).bind(
          commandId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          AUTO_PLACEMENT_SCOPE,
          parsed.idempotencyKey,
          requestHash,
        ),
        this.env.DB.prepare(
          `UPDATE idempotency_records
              SET status = 'completed', response_status = 200,
                  response_json = ?, entity_type = 'schedule_version',
                  entity_id = ?, completed_at = unixepoch()
            WHERE id = ? AND organisation_id = ? AND event_id = ?
              AND actor_id = ? AND scope = ? AND idempotency_key = ?
              AND request_hash = ? AND status = 'processing'`,
        ).bind(
          JSON.stringify(result),
          parsed.scheduleVersionId,
          commandId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          AUTO_PLACEMENT_SCOPE,
          parsed.idempotencyKey,
          requestHash,
        ),
      ]);
      if ((results[2]?.meta.changes ?? 0) !== 1) {
        const racedReplay = await this.replay(viewer, parsed, requestHash);
        if (racedReplay) return racedReplay;
        throw new ScheduleRevisionConflictError();
      }
      return result;
    }

    const entryIds = new Map(
      revalidatedPlacements.map((placement) => [
        placement.sessionId,
        crypto.randomUUID(),
      ]),
    );
    const sessionRevisions = new Map(
      computation.sessionRevisions.map((item) => [
        item.sessionId,
        item.revision,
      ]),
    );
    const commandGuard = `AND EXISTS (
           SELECT 1 FROM idempotency_records command
            WHERE command.id = ? AND command.organisation_id = ?
              AND command.event_id = ? AND command.actor_id = ?
              AND command.scope = ? AND command.idempotency_key = ?
              AND command.request_hash = ? AND command.status = 'processing'
         )`;
    const sessionRevisionGuard = `AND NOT EXISTS (
           SELECT 1
             FROM json_each(?) expected
             LEFT JOIN sessions candidate
               ON candidate.id = json_extract(expected.value, '$.sessionId')
              AND candidate.event_id = schedule_versions.event_id
            WHERE candidate.id IS NULL
               OR candidate.revision <> json_extract(expected.value, '$.revision')
               OR candidate.status <> 'unscheduled'
               OR EXISTS (
                    SELECT 1 FROM schedule_entries current_entry
                     WHERE current_entry.event_id = schedule_versions.event_id
                       AND current_entry.schedule_version_id = schedule_versions.id
                       AND current_entry.session_id = candidate.id
               )
         )`;
    const sessionRevisionJson = JSON.stringify(computation.sessionRevisions);
    const commandGuardBindings = [
      commandId,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      AUTO_PLACEMENT_SCOPE,
      parsed.idempotencyKey,
      requestHash,
    ];
    const operationId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = ? AND idempotency_key = ?
            AND expires_at <= unixepoch()`,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        AUTO_PLACEMENT_SCOPE,
        parsed.idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
                   unixepoch() + 2592000, unixepoch())`,
      ).bind(
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        AUTO_PLACEMENT_SCOPE,
        parsed.idempotencyKey,
        requestHash,
      ),
    ];
    const versionIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `UPDATE schedule_versions
            SET revision = revision + 1, publication_operation_id = ?
          WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = schedule_versions.event_id AND organisation_id = ?
                 AND revision = ?
            )
            ${sessionRevisionGuard}
            ${commandGuard}`,
      ).bind(
        operationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        viewer.organisationId,
        workspace.event.revision,
        sessionRevisionJson,
        ...commandGuardBindings,
      ),
    );

    const appliedPlacements: Array<
      AutoPlacementProposal & { entryId: string }
    > = [];
    for (const placement of revalidatedPlacements) {
      const entryId = entryIds.get(placement.sessionId)!;
      const resolvedWarnings = placement.warnings.map((conflict) => {
        const plannedId = conflict.conflictingEntryId;
        const plannedSessionId = plannedId?.startsWith(AUTO_ENTRY_PREFIX)
          ? plannedId.slice(AUTO_ENTRY_PREFIX.length)
          : null;
        const conflictingEntryId = plannedSessionId
          ? entryIds.get(plannedSessionId)
          : plannedId;
        return {
          ...conflict,
          ...(conflictingEntryId ? { conflictingEntryId } : {}),
        };
      });
      appliedPlacements.push({
        ...placement,
        entryId,
        warnings: resolvedWarnings,
      });
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO schedule_entries (
             id, event_id, schedule_version_id, session_id, room_id,
             starts_at, ends_at, revision, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND status = 'draft'
                 AND publication_operation_id = ?
            )`,
        ).bind(
          entryId,
          viewer.eventId,
          parsed.scheduleVersionId,
          placement.sessionId,
          placement.roomId,
          placement.startsAt,
          placement.endsAt,
          parsed.scheduleVersionId,
          viewer.eventId,
          operationId,
        ),
        ...resolvedWarnings.map((conflict) =>
          scheduleConflictInsert(
            this.env,
            viewer.eventId,
            parsed.scheduleVersionId,
            entryId,
            conflict,
            operationId,
          ),
        ),
        this.env.DB.prepare(
          `UPDATE sessions
              SET status = 'scheduled', revision = revision + 1, updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND status = 'unscheduled'
              AND revision = ?
              AND EXISTS (
                SELECT 1 FROM schedule_versions
                 WHERE id = ? AND event_id = ? AND status = 'draft'
                   AND publication_operation_id = ?
              )`,
        ).bind(
          placement.sessionId,
          viewer.eventId,
          sessionRevisions.get(placement.sessionId),
          parsed.scheduleVersionId,
          viewer.eventId,
          operationId,
        ),
      );
    }

    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.auto_place.confirmed', 'schedule_version', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM schedule_versions
             WHERE id = ? AND event_id = ? AND status = 'draft'
               AND publication_operation_id = ?
          )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.scheduleVersionId,
        JSON.stringify({
          scheduleRevision: result.scheduleRevision,
          appliedCount: result.appliedCount,
          placements: appliedPlacements.map(
            ({ sessionId, roomId, startsAt, endsAt, entryId }) => ({
              sessionId,
              roomId,
              startsAt,
              endsAt,
              entryId,
            }),
          ),
          unplaced: computation.unplaced,
          excludedSessionIds: computation.placements
            .filter((placement) => !selectedIds.has(placement.sessionId))
            .map((placement) => placement.sessionId),
        }),
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
    );
    const completionIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'schedule_version',
                entity_id = ?, completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = ? AND idempotency_key = ?
            AND request_hash = ? AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND status = 'draft'
                 AND publication_operation_id = ?
            )`,
      ).bind(
        JSON.stringify(result),
        parsed.scheduleVersionId,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        AUTO_PLACEMENT_SCOPE,
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
    );
    statements.push(
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = ? AND idempotency_key = ?
            AND request_hash = ? AND status = 'processing'
            AND NOT EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND status = 'draft'
                 AND publication_operation_id = ?
            )`,
      ).bind(
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        AUTO_PLACEMENT_SCOPE,
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
    );

    const results = await this.env.DB.batch(statements);
    if ((results[versionIndex]?.meta.changes ?? 0) !== 1) {
      const racedReplay = await this.replay(viewer, parsed, requestHash);
      if (racedReplay) return racedReplay;
      throw previewStale(
        "The draft schedule changed while auto-place confirmations were being applied. Prepare a fresh preview.",
      );
    }
    if ((results[completionIndex]?.meta.changes ?? 0) !== 1) {
      throw new Error(
        "The auto-placement batch committed without its durable idempotency result.",
      );
    }
    return result;
  }
}
