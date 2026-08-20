import { requireValue } from "~/lib/required-value";
import type { Viewer } from "~/platform/auth/authorize.server";
import { scheduleConflictInsert } from "./schedule-conflict-statement.server";
import {
  ScheduleConfigurationError,
  ScheduleIdempotencyConflictError,
  ScheduleNotFoundError,
  SchedulePlacementBlockedError,
  ScheduleRevisionConflictError,
  ScheduleUndoUnavailableError,
} from "./schedule-errors";
import {
  detectScheduleConflicts,
  type ScheduleConflict,
  type ScheduledItem,
} from "./schedule-rules";
import {
  scheduleMutationSchema,
  schedulePlacementSchema,
  scheduleUndoSchema,
} from "./schedule-schema";
import type {
  ScheduleEntry,
  ScheduleEventScope,
  SchedulePlacementCommand,
  SchedulePlacementResult,
  SchedulePlacementSessionUpdate,
  SchedulePlacementWarning,
  ScheduleSession,
  ScheduleUnassignmentResult,
  ScheduleWorkspace,
} from "./schedule-service.server";
import { detectWorkspaceConflicts } from "./schedule-workspace.server";

type ScheduleEntrySnapshot = Pick<
  ScheduleEntry,
  "id" | "sessionId" | "roomId" | "startsAt" | "endsAt" | "revision"
>;

type ContentApprovalSource = "editorial" | "legacy_publication";

type ScheduleUndoMetadata = {
  undoToken: string;
  expiresAt: number;
  scheduleVersionId: string;
  previous: ScheduleEntrySnapshot | null;
  next: ScheduleEntrySnapshot | null;
  previousDurationMinutes: number | null;
  previousContentRevision: number | null;
  previousContentStatus: ScheduleSession["contentStatus"] | null;
  previousApprovedByPersonId: string | null;
  previousApprovedAt: number | null;
  previousApprovalSource: ContentApprovalSource | null;
};

function entrySnapshot(value: unknown): ScheduleEntrySnapshot | null {
  if (value === null) return null;
  if (!value || typeof value !== "object")
    throw new ScheduleUndoUnavailableError();
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.roomId !== "string" ||
    typeof candidate.startsAt !== "number" ||
    !Number.isSafeInteger(candidate.startsAt) ||
    typeof candidate.endsAt !== "number" ||
    !Number.isSafeInteger(candidate.endsAt) ||
    typeof candidate.revision !== "number" ||
    !Number.isSafeInteger(candidate.revision)
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  return candidate as ScheduleEntrySnapshot;
}

const contentStatuses = new Set<ScheduleSession["contentStatus"]>([
  "draft",
  "in_review",
  "approved",
  "changes_requested",
]);

function durationMinutesSnapshot(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1_440
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  return value;
}

function contentRevisionSnapshot(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ScheduleUndoUnavailableError();
  }
  return value;
}

function epochSnapshot(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ScheduleUndoUnavailableError();
  }
  return value;
}

function contentStatusSnapshot(
  value: unknown,
): ScheduleSession["contentStatus"] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !contentStatuses.has(value as never)) {
    throw new ScheduleUndoUnavailableError();
  }
  return value as ScheduleSession["contentStatus"];
}

function optionalStringSnapshot(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new ScheduleUndoUnavailableError();
  }
  return value;
}

function approvalSourceSnapshot(value: unknown): ContentApprovalSource | null {
  if (value === undefined || value === null) return null;
  if (value !== "editorial" && value !== "legacy_publication") {
    throw new ScheduleUndoUnavailableError();
  }
  return value;
}

function parseUndoMetadata(value: string): ScheduleUndoMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ScheduleUndoUnavailableError();
  }
  if (!parsed || typeof parsed !== "object")
    throw new ScheduleUndoUnavailableError();
  const metadata = parsed as Record<string, unknown>;
  if (
    typeof metadata.undoToken !== "string" ||
    typeof metadata.expiresAt !== "number" ||
    !Number.isSafeInteger(metadata.expiresAt) ||
    typeof metadata.scheduleVersionId !== "string"
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  return {
    undoToken: metadata.undoToken,
    expiresAt: metadata.expiresAt,
    scheduleVersionId: metadata.scheduleVersionId,
    previous: entrySnapshot(metadata.previous),
    next: entrySnapshot(metadata.next),
    previousDurationMinutes: durationMinutesSnapshot(
      metadata.previousDurationMinutes,
    ),
    previousContentRevision: contentRevisionSnapshot(
      metadata.previousContentRevision,
    ),
    previousContentStatus: contentStatusSnapshot(
      metadata.previousContentStatus,
    ),
    previousApprovedByPersonId: optionalStringSnapshot(
      metadata.previousApprovedByPersonId,
    ),
    previousApprovedAt: epochSnapshot(metadata.previousApprovedAt),
    previousApprovalSource: approvalSourceSnapshot(
      metadata.previousApprovalSource,
    ),
  };
}

const scheduleConflictTypes = new Set<ScheduleConflict["type"]>([
  "event_boundary",
  "room",
  "speaker",
  "track",
  "capacity",
  "required_resource",
  "resource_configuration",
  "room_resource",
  "turnaround",
]);

function parseSchedulePlacementResult(value: unknown): SchedulePlacementResult {
  if (!value || typeof value !== "object") {
    throw new Error(
      "The completed schedule placement is missing its durable result.",
    );
  }
  const candidate = value as Record<string, unknown>;
  const undo = candidate.undo;
  const entry = candidate.entry;
  const session = candidate.session;
  if (
    typeof candidate.entryId !== "string" ||
    candidate.entryId.length === 0 ||
    !entry ||
    typeof entry !== "object" ||
    typeof candidate.movedExistingEntry !== "boolean" ||
    typeof candidate.scheduleRevision !== "number" ||
    !Number.isSafeInteger(candidate.scheduleRevision) ||
    candidate.scheduleRevision < 1 ||
    !Array.isArray(candidate.warnings) ||
    !undo ||
    typeof undo !== "object"
  ) {
    throw new Error(
      "The completed schedule placement has an invalid durable result.",
    );
  }
  let parsedSession: SchedulePlacementSessionUpdate | undefined;
  if (session !== undefined) {
    if (!session || typeof session !== "object") {
      throw new Error(
        "The completed schedule placement has invalid durable session data.",
      );
    }
    const candidateSession = session as Record<string, unknown>;
    if (
      typeof candidateSession.id !== "string" ||
      candidateSession.id.length === 0 ||
      typeof candidateSession.durationMinutes !== "number" ||
      !Number.isSafeInteger(candidateSession.durationMinutes) ||
      candidateSession.durationMinutes < 5 ||
      candidateSession.durationMinutes > 480 ||
      typeof candidateSession.contentStatus !== "string" ||
      !contentStatuses.has(candidateSession.contentStatus as never) ||
      typeof candidateSession.contentRevision !== "number" ||
      !Number.isSafeInteger(candidateSession.contentRevision) ||
      candidateSession.contentRevision < 1 ||
      (candidateSession.status !== "scheduled" &&
        candidateSession.status !== "published") ||
      typeof candidateSession.revision !== "number" ||
      !Number.isSafeInteger(candidateSession.revision) ||
      candidateSession.revision < 1
    ) {
      throw new Error(
        "The completed schedule placement has invalid durable session data.",
      );
    }
    parsedSession = candidateSession as SchedulePlacementSessionUpdate;
  }
  const parsedEntry = entry as Record<string, unknown>;
  if (
    typeof parsedEntry.id !== "string" ||
    parsedEntry.id !== candidate.entryId ||
    typeof parsedEntry.sessionId !== "string" ||
    parsedEntry.sessionId.length === 0 ||
    typeof parsedEntry.roomId !== "string" ||
    parsedEntry.roomId.length === 0 ||
    typeof parsedEntry.startsAt !== "number" ||
    !Number.isSafeInteger(parsedEntry.startsAt) ||
    parsedEntry.startsAt <= 0 ||
    typeof parsedEntry.endsAt !== "number" ||
    !Number.isSafeInteger(parsedEntry.endsAt) ||
    parsedEntry.endsAt <= parsedEntry.startsAt ||
    typeof parsedEntry.revision !== "number" ||
    !Number.isSafeInteger(parsedEntry.revision) ||
    parsedEntry.revision < 1
  ) {
    throw new Error(
      "The completed schedule placement has invalid durable entry data.",
    );
  }
  if (
    parsedSession &&
    (parsedSession.id !== parsedEntry.sessionId ||
      parsedSession.durationMinutes * 60 !==
        (parsedEntry.endsAt as number) - (parsedEntry.startsAt as number))
  ) {
    throw new Error(
      "The completed schedule placement session does not match its entry.",
    );
  }
  const parsedWarnings = candidate.warnings.map((warning) => {
    if (!warning || typeof warning !== "object") {
      throw new Error(
        "The completed schedule placement has an invalid durable warning.",
      );
    }
    const parsed = warning as Record<string, unknown>;
    if (
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      typeof parsed.type !== "string" ||
      !scheduleConflictTypes.has(parsed.type as ScheduleConflict["type"]) ||
      parsed.severity !== "warning" ||
      typeof parsed.message !== "string" ||
      parsed.message.length === 0 ||
      (parsed.conflictingEntryId !== undefined &&
        typeof parsed.conflictingEntryId !== "string")
    ) {
      throw new Error(
        "The completed schedule placement has an invalid durable warning.",
      );
    }
    return {
      id: parsed.id,
      type: parsed.type,
      severity: parsed.severity,
      message: parsed.message,
      ...(parsed.conflictingEntryId === undefined
        ? {}
        : { conflictingEntryId: parsed.conflictingEntryId }),
    } as SchedulePlacementWarning;
  });
  const parsedUndo = undo as Record<string, unknown>;
  if (
    typeof parsedUndo.token !== "string" ||
    parsedUndo.token.length === 0 ||
    typeof parsedUndo.expiresAt !== "number" ||
    !Number.isSafeInteger(parsedUndo.expiresAt) ||
    parsedUndo.expiresAt < 1
  ) {
    throw new Error(
      "The completed schedule placement has invalid durable undo metadata.",
    );
  }
  return {
    entryId: candidate.entryId,
    entry: parsedEntry as ScheduleEntrySnapshot,
    ...(parsedSession ? { session: parsedSession } : {}),
    movedExistingEntry: candidate.movedExistingEntry,
    scheduleRevision: candidate.scheduleRevision,
    warnings: parsedWarnings,
    undo: { token: parsedUndo.token, expiresAt: parsedUndo.expiresAt },
  };
}

export class SchedulePlacementWorkflow {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: {
      getWorkspace: (viewer: ScheduleEventScope) => Promise<ScheduleWorkspace>;
    },
  ) {}

  private getWorkspace(viewer: ScheduleEventScope) {
    return this.dependencies.getWorkspace(viewer);
  }

  private async replayPlacement(
    viewer: Viewer,
    command: SchedulePlacementCommand,
  ): Promise<SchedulePlacementResult | null> {
    const record = await this.env.DB.prepare(
      `SELECT request_hash AS requestHash, status, response_json AS responseJson
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = 'schedule.entry.place' AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
      )
      .first<{
        requestHash: string;
        status: "processing" | "completed" | "failed";
        responseJson: string | null;
      }>();
    if (!record) return null;
    if (record.requestHash !== command.requestHash) {
      throw new ScheduleIdempotencyConflictError(
        "IDEMPOTENCY_KEY_REUSED",
        "This assistant placement identifier was already used for a different request.",
      );
    }
    if (record.status !== "completed") {
      throw new ScheduleIdempotencyConflictError(
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        record.status === "failed"
          ? "This assistant placement did not complete. Prepare a fresh proposal before retrying."
          : "This assistant placement is still being processed. Retry the same approved proposal shortly.",
      );
    }
    if (!record.responseJson) {
      throw new Error(
        "The completed schedule placement is missing its durable response.",
      );
    }
    let response: unknown;
    try {
      response = JSON.parse(record.responseJson);
    } catch {
      throw new Error(
        "The completed schedule placement has an invalid durable response.",
      );
    }
    return parseSchedulePlacementResult(response);
  }

  async placeD1(
    viewer: Viewer,
    input: unknown,
    command?: SchedulePlacementCommand,
  ): Promise<SchedulePlacementResult> {
    const parsed = schedulePlacementSchema.parse(input);
    if (command) {
      const replay = await this.replayPlacement(viewer, command);
      if (replay) return replay;
    }
    const workspace = await this.getWorkspace(viewer);
    if (
      !workspace.version ||
      workspace.version.id !== parsed.scheduleVersionId ||
      workspace.version.status !== "draft"
    ) {
      throw new Error(
        "Choose an active draft schedule before placing sessions.",
      );
    }
    if (workspace.version.revision !== parsed.scheduleRevision)
      throw new ScheduleRevisionConflictError();
    const session = workspace.sessions.find(
      (item) => item.id === parsed.sessionId,
    );
    if (!session) throw new Error("Session not found in this event.");
    const currentEntry = workspace.entries.find(
      (entry) => entry.sessionId === parsed.sessionId,
    );
    const sessionById = new Map(
      workspace.sessions.map((item) => [item.id, item]),
    );
    const existing: ScheduledItem[] = workspace.entries.map((entry) => {
      const item = sessionById.get(entry.sessionId);
      if (!item)
        throw new Error(
          `Schedule entry ${entry.id} references an unavailable session.`,
        );
      return {
        entryId: entry.id,
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        trackId: item.trackId,
        trackExclusive: item.trackExclusive,
        speakerIds: item.speakerIds,
        speakerNames: item.speakerNames,
        requiredResources: item.requiredResources,
        expectedAttendance: item.expectedAttendance,
        title: item.title,
      };
    });
    const conflicts = detectScheduleConflicts({
      candidate: {
        sessionId: session.id,
        title: session.title,
        roomId: parsed.roomId,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        trackId: session.trackId,
        trackExclusive: session.trackExclusive,
        speakerIds: session.speakerIds,
        speakerNames: session.speakerNames,
        requiredResources: session.requiredResources,
        expectedAttendance: session.expectedAttendance,
      },
      existing,
      rooms: workspace.rooms,
      eventStartsAt: workspace.event.startsAt,
      eventEndsAt: workspace.event.endsAt,
      eventTimezone: workspace.event.timezone,
      policies: workspace.policies,
      excludeEntryId: currentEntry?.id,
    });
    const blockingConflicts = conflicts.filter(
      (conflict) => conflict.severity === "blocking",
    );
    if (blockingConflicts.length)
      throw new SchedulePlacementBlockedError(blockingConflicts);
    const warnings: SchedulePlacementWarning[] = conflicts.map((conflict) => ({
      ...conflict,
      id: crypto.randomUUID(),
      severity: "warning",
    }));
    const durationMinutes = (parsed.endsAt - parsed.startsAt) / 60;
    if (
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 5 ||
      durationMinutes > 480
    ) {
      throw new ScheduleConfigurationError(
        "A placed session must last a whole number of minutes between 5 and 480.",
      );
    }
    const durationChanged = durationMinutes !== session.durationMinutes;
    const durationContentGuard = durationChanged
      ? `AND EXISTS (
           SELECT 1 FROM schedule_session_contents current_content
            WHERE current_content.schedule_version_id = schedule_versions.id
              AND current_content.event_id = schedule_versions.event_id
              AND current_content.session_id = ?
              AND current_content.content_revision = ?
         )`
      : "";
    const durationContentGuardBindings = durationChanged
      ? [parsed.sessionId, session.contentRevision]
      : [];
    const previousContentApproval = durationChanged
      ? ((await this.env.DB.prepare(
          `SELECT approved_by_person_id AS approvedByPersonId,
                  approved_at AS approvedAt,
                  approval_source AS approvalSource
             FROM schedule_session_contents
            WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?`,
        )
          .bind(parsed.scheduleVersionId, viewer.eventId, parsed.sessionId)
          .first<{
            approvedByPersonId: string | null;
            approvedAt: number | null;
            approvalSource: ContentApprovalSource | null;
          }>()) ?? {
          approvedByPersonId: null,
          approvedAt: null,
          approvalSource: null,
        })
      : null;

    const entryId = currentEntry?.id ?? crypto.randomUUID();
    const versionOperationId = crypto.randomUUID();
    const undoExpiresAt = Math.floor(Date.now() / 1_000) + 30;
    const nextEntry: ScheduleEntrySnapshot = {
      id: entryId,
      sessionId: parsed.sessionId,
      roomId: parsed.roomId,
      startsAt: parsed.startsAt,
      endsAt: parsed.endsAt,
      revision: currentEntry ? currentEntry.revision + 1 : 1,
    };
    const nextSession: SchedulePlacementSessionUpdate = {
      id: session.id,
      durationMinutes,
      contentStatus: durationChanged ? "draft" : session.contentStatus,
      contentRevision: session.contentRevision + (durationChanged ? 1 : 0),
      status: session.status === "published" ? "published" : "scheduled",
      revision: session.revision + 1,
    };
    const result: SchedulePlacementResult = {
      entryId,
      entry: nextEntry,
      session: nextSession,
      movedExistingEntry: currentEntry !== undefined,
      scheduleRevision: parsed.scheduleRevision + 1,
      warnings,
      undo: { token: versionOperationId, expiresAt: undoExpiresAt },
    };
    const commandRecordId = command ? crypto.randomUUID() : null;
    const commandGuard = command
      ? `AND EXISTS (
           SELECT 1 FROM idempotency_records placement_command
            WHERE placement_command.id = ?
              AND placement_command.organisation_id = ?
              AND placement_command.event_id = ?
              AND placement_command.actor_id = ?
              AND placement_command.scope = 'schedule.entry.place'
              AND placement_command.idempotency_key = ?
              AND placement_command.request_hash = ?
              AND placement_command.status = 'processing'
         )`
      : "";
    const commandGuardBindings = command
      ? [
          commandRecordId,
          viewer.organisationId,
          viewer.eventId,
          command.actorId,
          command.idempotencyKey,
          command.requestHash,
        ]
      : [];
    const statements: D1PreparedStatement[] = [];
    if (command) {
      statements.push(
        this.env.DB.prepare(
          `DELETE FROM idempotency_records
            WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
              AND scope = 'schedule.entry.place' AND idempotency_key = ?
              AND expires_at <= unixepoch()`,
        ).bind(
          viewer.organisationId,
          viewer.eventId,
          command.actorId,
          command.idempotencyKey,
        ),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO idempotency_records (
             id, organisation_id, event_id, actor_id, scope, idempotency_key,
             request_hash, status, expires_at, created_at
           ) VALUES (?, ?, ?, ?, 'schedule.entry.place', ?, ?, 'processing',
                     unixepoch() + 2592000, unixepoch())`,
        ).bind(
          commandRecordId,
          viewer.organisationId,
          viewer.eventId,
          command.actorId,
          command.idempotencyKey,
          command.requestHash,
        ),
      );
    }
    const updateIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `
        UPDATE schedule_versions
           SET revision = revision + 1, publication_operation_id = ?
         WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events current_event
              WHERE current_event.id = schedule_versions.event_id
                AND current_event.organisation_id = ?
                AND current_event.revision = ?
           )
           AND EXISTS (
             SELECT 1 FROM sessions placeable_session
              WHERE placeable_session.id = ?
                AND placeable_session.event_id = schedule_versions.event_id
                AND placeable_session.status IN ('unscheduled','scheduled','published')
           )
           ${durationContentGuard}
           ${commandGuard}
      `,
      ).bind(
        versionOperationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        viewer.organisationId,
        workspace.event.revision,
        parsed.sessionId,
        ...durationContentGuardBindings,
        ...commandGuardBindings,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id, starts_at, ends_at, revision, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch()
         WHERE EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
        ON CONFLICT(schedule_version_id, session_id) DO UPDATE SET
          room_id = excluded.room_id, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
          revision = schedule_entries.revision + 1, updated_at = unixepoch()
      `,
      ).bind(
        entryId,
        viewer.eventId,
        parsed.scheduleVersionId,
        parsed.sessionId,
        parsed.roomId,
        parsed.startsAt,
        parsed.endsAt,
        parsed.scheduleVersionId,
        versionOperationId,
      ),
      this.env.DB.prepare(
        `
        DELETE FROM schedule_conflicts
         WHERE event_id = ? AND schedule_version_id = ?
           AND (primary_entry_id = ? OR conflicting_entry_id = ?)
           AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
      ).bind(
        viewer.eventId,
        parsed.scheduleVersionId,
        entryId,
        entryId,
        parsed.scheduleVersionId,
        versionOperationId,
      ),
      ...warnings.map((conflict) =>
        this.conflictInsert(
          viewer.eventId,
          parsed.scheduleVersionId,
          entryId,
          conflict,
          versionOperationId,
          conflict.id,
        ),
      ),
      this.env.DB.prepare(
        `
        UPDATE sessions
           SET status = CASE
                 WHEN status = 'published' THEN status
                 ELSE 'scheduled'
               END,
               duration_minutes = ?,
               revision = revision + 1,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ?
           AND status IN ('unscheduled','scheduled','published')
           AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
      ).bind(
        durationMinutes,
        parsed.sessionId,
        viewer.eventId,
        parsed.scheduleVersionId,
        versionOperationId,
      ),
      ...this.sessionContentDurationStatements({
        scheduleVersionId: parsed.scheduleVersionId,
        eventId: viewer.eventId,
        sessionId: parsed.sessionId,
        durationMinutes,
        expectedContentRevision: session.contentRevision,
        contentStatus: "draft",
        approvedByPersonId: null,
        approvedAt: null,
        approvalSource: null,
        operationId: versionOperationId,
        editorPersonId: viewer.personId,
        changeKind: "edit",
        include: durationChanged,
      }),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.entry.placed', 'schedule_entry', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        entryId,
        JSON.stringify({
          undoToken: versionOperationId,
          expiresAt: undoExpiresAt,
          scheduleVersionId: parsed.scheduleVersionId,
          previous: currentEntry ?? null,
          next: nextEntry,
          previousDurationMinutes: durationChanged
            ? session.durationMinutes
            : null,
          previousContentRevision: durationChanged
            ? session.contentRevision
            : null,
          previousContentStatus: durationChanged ? session.contentStatus : null,
          previousApprovedByPersonId: durationChanged
            ? (previousContentApproval?.approvedByPersonId ?? null)
            : null,
          previousApprovedAt: durationChanged
            ? (previousContentApproval?.approvedAt ?? null)
            : null,
          previousApprovalSource: durationChanged
            ? (previousContentApproval?.approvalSource ?? null)
            : null,
        }),
        parsed.scheduleVersionId,
        versionOperationId,
      ),
    );
    const completionIndex = command ? statements.length : null;
    if (command) {
      statements.push(
        this.env.DB.prepare(
          `UPDATE idempotency_records
              SET status = 'completed', response_status = 200,
                  response_json = ?, entity_type = 'schedule_entry',
                  entity_id = ?, completed_at = unixepoch()
            WHERE id = ? AND organisation_id = ? AND event_id = ?
              AND actor_id = ? AND scope = 'schedule.entry.place'
              AND idempotency_key = ? AND request_hash = ?
              AND status = 'processing'
              AND EXISTS (
                SELECT 1 FROM schedule_versions version
                 WHERE version.id = ? AND version.event_id = ?
                   AND version.status = 'draft'
                   AND version.publication_operation_id = ?
              )`,
        ).bind(
          JSON.stringify(result),
          entryId,
          commandRecordId,
          viewer.organisationId,
          viewer.eventId,
          command.actorId,
          command.idempotencyKey,
          command.requestHash,
          parsed.scheduleVersionId,
          viewer.eventId,
          versionOperationId,
        ),
        this.env.DB.prepare(
          `DELETE FROM idempotency_records
            WHERE id = ? AND organisation_id = ? AND event_id = ?
              AND actor_id = ? AND scope = 'schedule.entry.place'
              AND idempotency_key = ? AND request_hash = ?
              AND status = 'processing'
              AND NOT EXISTS (
                SELECT 1 FROM schedule_versions version
                 WHERE version.id = ? AND version.event_id = ?
                   AND version.status = 'draft'
                   AND version.publication_operation_id = ?
              )`,
        ).bind(
          commandRecordId,
          viewer.organisationId,
          viewer.eventId,
          command.actorId,
          command.idempotencyKey,
          command.requestHash,
          parsed.scheduleVersionId,
          viewer.eventId,
          versionOperationId,
        ),
      );
    }
    const batch = await this.env.DB.batch(statements);
    const update = batch[updateIndex];
    if ((update?.meta.changes ?? 0) !== 1) {
      if (command) {
        const replay = await this.replayPlacement(viewer, command);
        if (replay) return replay;
      }
      throw new ScheduleRevisionConflictError();
    }
    if (
      completionIndex !== null &&
      (batch[completionIndex]?.meta.changes ?? 0) !== 1
    ) {
      throw new Error(
        "The schedule placement committed without its durable idempotency result.",
      );
    }
    return result;
  }

  async unassignD1(
    viewer: Viewer,
    input: unknown,
  ): Promise<ScheduleUnassignmentResult> {
    const parsed = scheduleMutationSchema.parse(input);
    const workspace = await this.getWorkspace(viewer);
    if (
      !workspace.version ||
      workspace.version.id !== parsed.scheduleVersionId ||
      workspace.version.status !== "draft"
    ) {
      throw new ScheduleNotFoundError();
    }
    if (workspace.version.revision !== parsed.scheduleRevision)
      throw new ScheduleRevisionConflictError();
    const entry = workspace.entries.find((item) => item.id === parsed.entryId);
    if (!entry) throw new ScheduleNotFoundError("Schedule entry not found.");

    const versionOperationId = crypto.randomUUID();
    const undoExpiresAt = Math.floor(Date.now() / 1_000) + 30;
    const prospective: ScheduleWorkspace = {
      ...workspace,
      entries: workspace.entries.filter((item) => item.id !== entry.id),
    };
    const conflicts = detectWorkspaceConflicts(prospective);
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE schedule_versions
           SET revision = revision + 1, publication_operation_id = ?
         WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events current_event
              WHERE current_event.id = schedule_versions.event_id
                AND current_event.organisation_id = ?
                AND current_event.revision = ?
           )
           AND EXISTS (
             SELECT 1 FROM schedule_entries current_entry
              WHERE current_entry.id = ?
                AND current_entry.event_id = schedule_versions.event_id
                AND current_entry.schedule_version_id = schedule_versions.id
                AND current_entry.session_id = ? AND current_entry.room_id = ?
                AND current_entry.starts_at = ? AND current_entry.ends_at = ?
                AND current_entry.revision = ?
           )
      `,
      ).bind(
        versionOperationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        viewer.organisationId,
        workspace.event.revision,
        entry.id,
        entry.sessionId,
        entry.roomId,
        entry.startsAt,
        entry.endsAt,
        entry.revision,
      ),
      this.env.DB.prepare(
        `
        DELETE FROM schedule_entries
         WHERE id = ? AND event_id = ? AND schedule_version_id = ?
           AND session_id = ? AND room_id = ? AND starts_at = ? AND ends_at = ?
           AND revision = ?
           AND EXISTS (
             SELECT 1 FROM schedule_versions
              WHERE id = ? AND event_id = ? AND publication_operation_id = ?
           )
      `,
      ).bind(
        entry.id,
        viewer.eventId,
        parsed.scheduleVersionId,
        entry.sessionId,
        entry.roomId,
        entry.startsAt,
        entry.endsAt,
        entry.revision,
        parsed.scheduleVersionId,
        viewer.eventId,
        versionOperationId,
      ),
      this.env.DB.prepare(
        `DELETE FROM schedule_conflicts
          WHERE event_id = ? AND schedule_version_id = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND publication_operation_id = ?
            )`,
      ).bind(
        viewer.eventId,
        parsed.scheduleVersionId,
        parsed.scheduleVersionId,
        viewer.eventId,
        versionOperationId,
      ),
      ...conflicts.map(({ entryId, conflict }) =>
        this.conflictInsert(
          viewer.eventId,
          parsed.scheduleVersionId,
          entryId,
          conflict,
          versionOperationId,
        ),
      ),
      this.env.DB.prepare(
        `
        UPDATE sessions
           SET status = 'unscheduled', revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'scheduled'
           AND EXISTS (
             SELECT 1 FROM schedule_versions
              WHERE id = ? AND event_id = ? AND publication_operation_id = ?
           )
      `,
      ).bind(
        entry.sessionId,
        viewer.eventId,
        parsed.scheduleVersionId,
        viewer.eventId,
        versionOperationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.entry.unassigned', 'schedule_entry', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = ? AND event_id = ? AND publication_operation_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        entry.id,
        JSON.stringify({
          undoToken: versionOperationId,
          expiresAt: undoExpiresAt,
          scheduleVersionId: parsed.scheduleVersionId,
          previous: entry,
          next: null,
        }),
        parsed.scheduleVersionId,
        viewer.eventId,
        versionOperationId,
      ),
    ];
    const [updated, deleted] = await this.env.DB.batch(statements);
    if (
      (updated.meta.changes ?? 0) !== 1 ||
      (deleted.meta.changes ?? 0) !== 1
    ) {
      throw new ScheduleRevisionConflictError();
    }
    return {
      entryId: entry.id,
      scheduleRevision: parsed.scheduleRevision + 1,
      undo: { token: versionOperationId, expiresAt: undoExpiresAt },
    };
  }

  async undoD1(viewer: Viewer, input: unknown) {
    const parsed = scheduleUndoSchema.parse(input);
    const audit = await this.env.DB.prepare(
      `
      SELECT action, metadata_json AS metadataJson
        FROM audit_events
       WHERE organisation_id = ? AND event_id = ? AND actor_person_id = ?
         AND entity_type = 'schedule_entry'
         AND action IN ('schedule.entry.placed','schedule.entry.unassigned')
         AND json_extract(metadata_json, '$.undoToken') = ?
         AND created_at >= unixepoch() - 30
       ORDER BY created_at DESC LIMIT 1
    `,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.undoToken,
      )
      .first<{ action: string; metadataJson: string }>();
    if (!audit) throw new ScheduleUndoUnavailableError();
    const metadata = parseUndoMetadata(audit.metadataJson);
    if (
      metadata.undoToken !== parsed.undoToken ||
      metadata.scheduleVersionId !== parsed.scheduleVersionId ||
      metadata.expiresAt < Math.floor(Date.now() / 1_000) ||
      (!metadata.previous && !metadata.next) ||
      (audit.action === "schedule.entry.placed" && !metadata.next) ||
      (audit.action === "schedule.entry.unassigned" && !metadata.previous)
    ) {
      throw new ScheduleUndoUnavailableError();
    }

    const workspace = await this.getWorkspace(viewer);
    if (
      !workspace.version ||
      workspace.version.id !== parsed.scheduleVersionId ||
      workspace.version.status !== "draft"
    ) {
      throw new ScheduleUndoUnavailableError();
    }
    if (workspace.version.revision !== parsed.scheduleRevision)
      throw new ScheduleRevisionConflictError();
    const durationSessionId = (metadata.previous ?? metadata.next)?.sessionId;
    const durationSession = durationSessionId
      ? workspace.sessions.find((item) => item.id === durationSessionId)
      : undefined;
    if (
      metadata.next &&
      (metadata.previousDurationMinutes === null) !==
        (metadata.previousContentRevision === null)
    ) {
      throw new ScheduleUndoUnavailableError();
    }
    if (
      metadata.next &&
      metadata.previousContentStatus === "approved" &&
      (metadata.previousApprovedAt === null ||
        metadata.previousApprovalSource === null ||
        (metadata.previousApprovalSource === "editorial" &&
          metadata.previousApprovedByPersonId === null) ||
        (metadata.previousApprovalSource === "legacy_publication" &&
          metadata.previousApprovedByPersonId !== null))
    ) {
      throw new ScheduleUndoUnavailableError();
    }
    if (
      metadata.next &&
      metadata.previousDurationMinutes !== null &&
      metadata.previousContentRevision !== null &&
      (!durationSession ||
        durationSession.contentRevision !==
          metadata.previousContentRevision + 1)
    ) {
      throw new ScheduleUndoUnavailableError();
    }

    const current = metadata.next
      ? workspace.entries.find(
          (entry) =>
            entry.id ===
            requireValue(
              metadata.next,
              "Required metadata.next is unavailable.",
            ).id,
        )
      : null;
    if (
      metadata.next &&
      (!current ||
        current.sessionId !== metadata.next.sessionId ||
        current.roomId !== metadata.next.roomId ||
        current.startsAt !== metadata.next.startsAt ||
        current.endsAt !== metadata.next.endsAt ||
        current.revision !== metadata.next.revision)
    ) {
      throw new ScheduleUndoUnavailableError();
    }
    if (
      !metadata.next &&
      workspace.entries.some(
        (entry) =>
          entry.id ===
            requireValue(
              metadata.previous,
              "Required metadata.previous is unavailable.",
            ).id ||
          entry.sessionId ===
            requireValue(
              metadata.previous,
              "Required metadata.previous is unavailable.",
            ).sessionId,
      )
    ) {
      throw new ScheduleUndoUnavailableError();
    }

    const restoredEntries = metadata.previous
      ? metadata.next
        ? workspace.entries.map((entry) =>
            entry.id ===
            requireValue(
              metadata.next,
              "Required metadata.next is unavailable.",
            ).id
              ? {
                  ...requireValue(
                    metadata.previous,
                    "Required metadata.previous is unavailable.",
                  ),
                  revision: entry.revision + 1,
                }
              : entry,
          )
        : [
            ...workspace.entries,
            { ...metadata.previous, revision: metadata.previous.revision + 1 },
          ]
      : workspace.entries.filter(
          (entry) =>
            entry.id !==
            requireValue(
              metadata.next,
              "Required metadata.next is unavailable.",
            ).id,
        );
    const prospective: ScheduleWorkspace = {
      ...workspace,
      entries: restoredEntries,
    };
    const conflicts = detectWorkspaceConflicts(prospective);
    const restoredEntryId = metadata.previous?.id ?? null;
    if (
      restoredEntryId &&
      conflicts.some(
        ({ entryId, conflict }) =>
          conflict.severity === "blocking" &&
          (entryId === restoredEntryId ||
            conflict.conflictingEntryId === restoredEntryId),
      )
    ) {
      throw new ScheduleUndoUnavailableError(
        "The schedule configuration changed and this undo would now create a blocking conflict.",
      );
    }

    const operationId = crypto.randomUUID();
    const stateGuard = metadata.next
      ? `EXISTS (
           SELECT 1 FROM schedule_entries current_entry
            WHERE current_entry.id = ? AND current_entry.event_id = schedule_versions.event_id
              AND current_entry.schedule_version_id = schedule_versions.id
              AND current_entry.session_id = ? AND current_entry.room_id = ?
              AND current_entry.starts_at = ? AND current_entry.ends_at = ?
              AND current_entry.revision = ?
         )`
      : `NOT EXISTS (
           SELECT 1 FROM schedule_entries current_entry
            WHERE current_entry.schedule_version_id = schedule_versions.id
              AND (current_entry.id = ? OR current_entry.session_id = ?)
         )`;
    const stateBindings = metadata.next
      ? [
          metadata.next.id,
          metadata.next.sessionId,
          metadata.next.roomId,
          metadata.next.startsAt,
          metadata.next.endsAt,
          metadata.next.revision,
        ]
      : [
          requireValue(
            metadata.previous,
            "Required metadata.previous is unavailable.",
          ).id,
          requireValue(
            metadata.previous,
            "Required metadata.previous is unavailable.",
          ).sessionId,
        ];
    const durationContentGuard =
      metadata.next && metadata.previousContentRevision !== null
        ? `AND EXISTS (
             SELECT 1 FROM schedule_session_contents current_content
              WHERE current_content.schedule_version_id = schedule_versions.id
                AND current_content.event_id = schedule_versions.event_id
                AND current_content.session_id = ?
                AND current_content.content_revision = ?
           )`
        : "";
    const durationContentGuardBindings =
      metadata.next && metadata.previousContentRevision !== null
        ? [metadata.next.sessionId, metadata.previousContentRevision + 1]
        : [];
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE schedule_versions
           SET revision = revision + 1, publication_operation_id = ?
         WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
           AND publication_operation_id = ?
           AND EXISTS (
             SELECT 1 FROM events current_event
              WHERE current_event.id = schedule_versions.event_id
                AND current_event.organisation_id = ?
                AND current_event.revision = ?
           )
           AND ${stateGuard}
           ${durationContentGuard}
      `,
      ).bind(
        operationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        parsed.undoToken,
        viewer.organisationId,
        workspace.event.revision,
        ...stateBindings,
        ...durationContentGuardBindings,
      ),
    ];

    if (metadata.previous && metadata.next) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE schedule_entries
             SET room_id = ?, starts_at = ?, ends_at = ?,
                 revision = revision + 1, updated_at = unixepoch()
           WHERE id = ? AND event_id = ? AND schedule_version_id = ?
             AND session_id = ? AND room_id = ? AND starts_at = ? AND ends_at = ?
             AND revision = ?
             AND EXISTS (
               SELECT 1 FROM schedule_versions
                WHERE id = ? AND event_id = ? AND publication_operation_id = ?
             )
        `,
        ).bind(
          metadata.previous.roomId,
          metadata.previous.startsAt,
          metadata.previous.endsAt,
          metadata.next.id,
          viewer.eventId,
          parsed.scheduleVersionId,
          metadata.next.sessionId,
          metadata.next.roomId,
          metadata.next.startsAt,
          metadata.next.endsAt,
          metadata.next.revision,
          parsed.scheduleVersionId,
          viewer.eventId,
          operationId,
        ),
      );
    } else if (metadata.previous) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO schedule_entries (
            id, event_id, schedule_version_id, session_id, room_id,
            starts_at, ends_at, revision, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM schedule_versions
              WHERE id = ? AND event_id = ? AND publication_operation_id = ?
           )
        `,
        ).bind(
          metadata.previous.id,
          viewer.eventId,
          parsed.scheduleVersionId,
          metadata.previous.sessionId,
          metadata.previous.roomId,
          metadata.previous.startsAt,
          metadata.previous.endsAt,
          metadata.previous.revision + 1,
          parsed.scheduleVersionId,
          viewer.eventId,
          operationId,
        ),
      );
    } else {
      statements.push(
        this.env.DB.prepare(
          `
          DELETE FROM schedule_entries
           WHERE id = ? AND event_id = ? AND schedule_version_id = ?
             AND session_id = ? AND room_id = ? AND starts_at = ? AND ends_at = ?
             AND revision = ?
             AND EXISTS (
               SELECT 1 FROM schedule_versions
                WHERE id = ? AND event_id = ? AND publication_operation_id = ?
             )
        `,
        ).bind(
          requireValue(metadata.next, "Required metadata.next is unavailable.")
            .id,
          viewer.eventId,
          parsed.scheduleVersionId,
          requireValue(metadata.next, "Required metadata.next is unavailable.")
            .sessionId,
          requireValue(metadata.next, "Required metadata.next is unavailable.")
            .roomId,
          requireValue(metadata.next, "Required metadata.next is unavailable.")
            .startsAt,
          requireValue(metadata.next, "Required metadata.next is unavailable.")
            .endsAt,
          requireValue(metadata.next, "Required metadata.next is unavailable.")
            .revision,
          parsed.scheduleVersionId,
          viewer.eventId,
          operationId,
        ),
      );
    }

    statements.push(
      this.env.DB.prepare(
        `DELETE FROM schedule_conflicts
          WHERE event_id = ? AND schedule_version_id = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND publication_operation_id = ?
            )`,
      ).bind(
        viewer.eventId,
        parsed.scheduleVersionId,
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
      ...conflicts.map(({ entryId, conflict }) =>
        this.conflictInsert(
          viewer.eventId,
          parsed.scheduleVersionId,
          entryId,
          conflict,
          operationId,
        ),
      ),
      this.env.DB.prepare(
        `
        UPDATE sessions
           SET status = ?, revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status <> 'published'
           AND EXISTS (
             SELECT 1 FROM schedule_versions
              WHERE id = ? AND event_id = ? AND publication_operation_id = ?
           )
      `,
      ).bind(
        metadata.previous ? "scheduled" : "unscheduled",
        requireValue(
          metadata.previous ?? metadata.next,
          "Required (metadata.previous ?? metadata.next) is unavailable.",
        ).sessionId,
        viewer.eventId,
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
      ...(metadata.next && metadata.previousDurationMinutes !== null
        ? [
            this.env.DB.prepare(
              `
              UPDATE sessions
                 SET duration_minutes = ?,
                     revision = revision + 1,
                     updated_at = unixepoch()
               WHERE id = ? AND event_id = ?
                 AND EXISTS (
                   SELECT 1 FROM schedule_versions
                    WHERE id = ? AND event_id = ? AND publication_operation_id = ?
                 )
            `,
            ).bind(
              metadata.previousDurationMinutes,
              metadata.next.sessionId,
              viewer.eventId,
              parsed.scheduleVersionId,
              viewer.eventId,
              operationId,
            ),
            ...this.sessionContentDurationStatements({
              scheduleVersionId: parsed.scheduleVersionId,
              eventId: viewer.eventId,
              sessionId: metadata.next.sessionId,
              durationMinutes: metadata.previousDurationMinutes,
              expectedContentRevision:
                metadata.previousContentRevision === null
                  ? requireValue(
                      durationSession,
                      "Required duration session is unavailable.",
                    ).contentRevision
                  : metadata.previousContentRevision + 1,
              contentStatus: metadata.previousContentStatus ?? "draft",
              approvedByPersonId: metadata.previousApprovedByPersonId,
              approvedAt: metadata.previousApprovedAt,
              approvalSource: metadata.previousApprovalSource,
              operationId,
              editorPersonId: viewer.personId,
              changeKind: "restore",
              include: true,
            }),
          ]
        : []),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.entry.undo', 'schedule_entry', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = ? AND event_id = ? AND publication_operation_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        requireValue(
          metadata.previous ?? metadata.next,
          "Required (metadata.previous ?? metadata.next) is unavailable.",
        ).id,
        JSON.stringify({ undoneToken: parsed.undoToken }),
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
    );

    const [updated, changedEntry] = await this.env.DB.batch(statements);
    if (
      (updated.meta.changes ?? 0) !== 1 ||
      (changedEntry.meta.changes ?? 0) !== 1
    ) {
      throw new ScheduleUndoUnavailableError();
    }
    const restoredPlacement = metadata.previous
      ? {
          roomId: metadata.previous.roomId,
          startsAt: metadata.previous.startsAt,
          endsAt: metadata.previous.endsAt,
        }
      : null;
    return {
      entryId: requireValue(
        metadata.previous ?? metadata.next,
        "Required (metadata.previous ?? metadata.next) is unavailable.",
      ).id,
      scheduleRevision: parsed.scheduleRevision + 1,
      sessionId: requireValue(
        metadata.previous ?? metadata.next,
        "Required (metadata.previous ?? metadata.next) is unavailable.",
      ).sessionId,
      restoredPlacement,
    };
  }

  private sessionContentDurationStatements(input: {
    scheduleVersionId: string;
    eventId: string;
    sessionId: string;
    durationMinutes: number;
    expectedContentRevision: number;
    contentStatus: ScheduleSession["contentStatus"];
    approvedByPersonId: string | null;
    approvedAt: number | null;
    approvalSource: ContentApprovalSource | null;
    operationId: string;
    editorPersonId: string;
    changeKind: "edit" | "restore";
    include: boolean;
  }) {
    if (!input.include) return [];
    const historyRevisionId = crypto.randomUUID();
    const nextContentRevision = input.expectedContentRevision + 1;
    return [
      this.env.DB.prepare(
        `
        UPDATE schedule_session_contents
           SET duration_minutes = ?, content_status = ?,
               content_revision = content_revision + 1,
               last_edited_by_person_id = ?,
               approved_by_person_id = ?,
               approved_at = ?,
               approval_source = ?,
               last_operation_id = ?,
               updated_at = unixepoch()
         WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?
           AND content_revision = ?
           AND EXISTS (
             SELECT 1 FROM schedule_versions
              WHERE id = schedule_session_contents.schedule_version_id
                AND event_id = schedule_session_contents.event_id
                AND publication_operation_id = ?
           )
      `,
      ).bind(
        input.durationMinutes,
        input.contentStatus,
        input.editorPersonId,
        input.approvedByPersonId,
        input.approvedAt,
        input.approvalSource,
        input.operationId,
        input.scheduleVersionId,
        input.eventId,
        input.sessionId,
        input.expectedContentRevision,
        input.operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO session_content_revisions (
          id, event_id, schedule_version_id, session_id, revision_number,
          title, slug, description, track_id, format, duration_minutes,
          required_resources_json, visibility, content_status, change_kind,
          restored_from_revision_id, created_by_person_id, created_at
        )
        SELECT ?, content.event_id, content.schedule_version_id,
               content.session_id, content.content_revision, content.title,
               content.slug, content.description, content.track_id,
               content.format, content.duration_minutes,
               content.required_resources_json, content.visibility,
               content.content_status, ?, NULL, ?, unixepoch()
          FROM schedule_session_contents content
         WHERE content.schedule_version_id = ? AND content.event_id = ?
           AND content.session_id = ? AND content.last_operation_id = ?
           AND content.content_revision = ?
      `,
      ).bind(
        historyRevisionId,
        input.changeKind,
        input.editorPersonId,
        input.scheduleVersionId,
        input.eventId,
        input.sessionId,
        input.operationId,
        nextContentRevision,
      ),
    ];
  }

  private conflictInsert(
    eventId: string,
    versionId: string,
    entryId: string,
    conflict: ScheduleConflict,
    operationId: string,
    conflictId?: string,
  ) {
    return scheduleConflictInsert(
      this.env,
      eventId,
      versionId,
      entryId,
      conflict,
      operationId,
      conflictId,
    );
  }
}
