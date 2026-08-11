import type { Viewer } from "~/platform/auth/authorize.server";
import {
  scheduleCalendarFanoutMessageSchema,
  type ScheduleCalendarFanoutMessage,
} from "~/modules/calendars/calendar-schema";
import { scheduleCalendarFanoutSnapshotStatements } from "~/modules/calendars/calendar-service.server";
import { AirtableProgrammeRepository } from "~/modules/airtable/airtable-programme-repository.server";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { parseSessionFormatsConfiguration } from "~/modules/events/event-configuration";
import { eventResourceSchema } from "~/modules/events/event-schema";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  detectScheduleConflicts,
  type ScheduleConflict,
  type SchedulePolicies,
  type ScheduledItem,
} from "./schedule-rules";
import {
  scheduleBreakSchema,
  scheduleMutationSchema,
  scheduleNotesSchema,
  schedulePlacementSchema,
  schedulePolicySchema,
  schedulePublishSchema,
  scheduleSessionContentSchema,
  scheduleSessionResourcesSchema,
  scheduleUndoSchema,
} from "./schedule-schema";

type WorkspaceEvent = {
  id: string;
  name: string;
  startsAt: number;
  endsAt: number;
  timezone: string;
  brandAccent: string;
  revision: number;
  repositoryProvider: "d1" | "airtable";
  sessionFormatsJson: string;
};

export type ScheduleSession = {
  id: string;
  title: string;
  slug: string;
  description: string;
  trackId: string | null;
  trackName: string | null;
  trackExclusive: boolean;
  format: string;
  durationMinutes: number;
  expectedAttendance: number | null;
  requiredResources: string[];
  visibility: "public" | "private" | "hidden";
  speakerIds: string[];
  speakerNames: string[];
  status: string;
  revision: number;
};

export type ScheduleEntry = {
  id: string;
  sessionId: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
  revision: number;
};

type ScheduleEntrySnapshot = Pick<
  ScheduleEntry,
  "id" | "sessionId" | "roomId" | "startsAt" | "endsAt" | "revision"
>;

type ScheduleUndoMetadata = {
  undoToken: string;
  expiresAt: number;
  scheduleVersionId: string;
  previous: ScheduleEntrySnapshot | null;
  next: ScheduleEntrySnapshot | null;
};

export type ScheduleWorkspace = {
  event: WorkspaceEvent;
  version: {
    id: string;
    versionNumber: number;
    status: string;
    revision: number;
    notes: string;
  } | null;
  rooms: Array<{
    id: string;
    name: string;
    capacity: number;
    resources: string[];
  }>;
  tracks: Array<{ id: string; name: string; exclusive: boolean }>;
  sessionFormats: Array<{
    key: string;
    label: string;
    defaultDurationMinutes: number;
    position: number;
  }>;
  sessions: ScheduleSession[];
  entries: ScheduleEntry[];
  conflicts: Array<{
    id: string;
    type: string;
    severity: string;
    message: string;
  }>;
  publicationConflicts: ScheduleConflict[];
  policies: SchedulePolicies;
  policyRevision: number;
};

function detectWorkspaceConflicts(workspace: ScheduleWorkspace) {
  const sessionById = new Map(
    workspace.sessions.map((session) => [session.id, session]),
  );
  const scheduled: ScheduledItem[] = workspace.entries.map((entry) => {
    const session = sessionById.get(entry.sessionId);
    if (!session) {
      throw new Error(
        `Schedule entry ${entry.id} references an unavailable session.`,
      );
    }
    return {
      ...entry,
      entryId: entry.id,
      trackId: session.trackId,
      trackExclusive: session.trackExclusive,
      speakerIds: session.speakerIds,
      expectedAttendance: session.expectedAttendance,
      requiredResources: session.requiredResources,
      title: session.title,
    };
  });
  const conflicts: Array<{ entryId: string; conflict: ScheduleConflict }> = [];
  const overlapPairs = new Set<string>();
  for (const entry of scheduled) {
    const detected = detectScheduleConflicts({
      candidate: entry,
      existing: scheduled,
      rooms: workspace.rooms,
      eventStartsAt: workspace.event.startsAt,
      eventEndsAt: workspace.event.endsAt,
      eventTimezone: workspace.event.timezone,
      policies: workspace.policies,
      excludeEntryId: entry.entryId,
    });
    for (const conflict of detected) {
      if (conflict.conflictingEntryId) {
        const pair = [entry.entryId, conflict.conflictingEntryId].sort();
        const fingerprint = `${conflict.type}:${pair[0]}:${pair[1]}`;
        if (overlapPairs.has(fingerprint)) continue;
        overlapPairs.add(fingerprint);
      }
      conflicts.push({ entryId: entry.entryId, conflict });
    }
  }
  return conflicts;
}

export class ScheduleRevisionConflictError extends Error {
  constructor() {
    super(
      "The schedule changed after this page loaded. Refresh before applying another change.",
    );
    this.name = "ScheduleRevisionConflictError";
  }
}

export class ScheduleUndoUnavailableError extends Error {
  constructor(
    message = "This schedule change can no longer be undone. Refresh to see the authoritative schedule.",
  ) {
    super(message);
    this.name = "ScheduleUndoUnavailableError";
  }
}

export class ScheduleNotFoundError extends Error {
  constructor(message = "Draft schedule not found.") {
    super(message);
    this.name = "ScheduleNotFoundError";
  }
}

export class SchedulePublicationBlockedError extends Error {
  constructor(
    readonly conflicts: ReadonlyArray<ScheduleConflict>,
    message?: string,
  ) {
    super(
      message ??
        `Resolve ${conflicts.length} blocking schedule conflict${conflicts.length === 1 ? "" : "s"} before publishing.`,
    );
    this.name = "SchedulePublicationBlockedError";
  }
}

export class SchedulePlacementBlockedError extends Error {
  constructor(readonly conflicts: ReadonlyArray<ScheduleConflict>) {
    super(
      `Resolve ${conflicts.length} blocking schedule conflict${conflicts.length === 1 ? "" : "s"} before placing this session.`,
    );
    this.name = "SchedulePlacementBlockedError";
  }
}

export class ScheduleConfigurationError extends Error {
  constructor(
    message = "This event is missing its required schedule policy configuration.",
  ) {
    super(message);
    this.name = "ScheduleConfigurationError";
  }
}

export class ScheduleIdempotencyConflictError extends Error {
  constructor(
    readonly code: "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    message: string,
  ) {
    super(message);
    this.name = "ScheduleIdempotencyConflictError";
  }
}

export type ScheduleEventScope = Pick<Viewer, "organisationId" | "eventId">;
export type ScheduleAuditActor =
  { personId: string; actorId?: null } | { personId?: null; actorId: string };
export type SchedulePublicationCommand = {
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
};

export type SchedulePlacementCommand = {
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
};

export type SchedulePlacementResult = {
  entryId: string;
  scheduleRevision: number;
  warnings: ScheduleConflict[];
  undo: { token: string; expiresAt: number };
};

export type ScheduleUnassignmentResult = {
  entryId: string;
  scheduleRevision: number;
  undo: { token: string; expiresAt: number };
};

export type ScheduleUndoResult = {
  entryId: string;
  scheduleRevision: number;
  sessionId: string;
  restoredPlacement: {
    roomId: string;
    startsAt: number;
    endsAt: number;
  } | null;
};

export type SchedulePublicationResult = {
  published: true;
  scheduleVersionId: string;
  changeSequence: number;
  calendar: {
    operationId: string;
    status: "queued" | "queue_failed";
    dispatchError: string | null;
  };
};

function policy(value: string): "ignore" | "warn" | "block" {
  if (value === "allow") return "ignore";
  if (value === "warn" || value === "block") return value;
  throw new ScheduleConfigurationError(
    `Unsupported schedule policy action: ${value}.`,
  );
}

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
  if (
    typeof candidate.entryId !== "string" ||
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
  const parsedWarnings = candidate.warnings.map((warning) => {
    if (!warning || typeof warning !== "object") {
      throw new Error(
        "The completed schedule placement has an invalid durable warning.",
      );
    }
    const parsed = warning as Record<string, unknown>;
    if (
      typeof parsed.type !== "string" ||
      !scheduleConflictTypes.has(parsed.type as ScheduleConflict["type"]) ||
      (parsed.severity !== "warning" && parsed.severity !== "blocking") ||
      typeof parsed.message !== "string" ||
      (parsed.conflictingEntryId !== undefined &&
        typeof parsed.conflictingEntryId !== "string")
    ) {
      throw new Error(
        "The completed schedule placement has an invalid durable warning.",
      );
    }
    return {
      type: parsed.type,
      severity: parsed.severity,
      message: parsed.message,
      ...(parsed.conflictingEntryId === undefined
        ? {}
        : { conflictingEntryId: parsed.conflictingEntryId }),
    } as ScheduleConflict;
  });
  const parsedUndo = undo as Record<string, unknown>;
  if (
    typeof parsedUndo.token !== "string" ||
    typeof parsedUndo.expiresAt !== "number" ||
    !Number.isSafeInteger(parsedUndo.expiresAt)
  ) {
    throw new Error(
      "The completed schedule placement has invalid durable undo metadata.",
    );
  }
  return {
    entryId: candidate.entryId,
    scheduleRevision: candidate.scheduleRevision,
    warnings: parsedWarnings,
    undo: { token: parsedUndo.token, expiresAt: parsedUndo.expiresAt },
  };
}

function buildSchedulePublicationStatements(input: {
  env: CloudflareEnvironment;
  viewer: ScheduleEventScope;
  actor: ScheduleAuditActor;
  command?: SchedulePublicationCommand;
  parsed: ReturnType<typeof schedulePublishSchema.parse>;
  workspace: ScheduleWorkspace;
  detectedConflicts: ReturnType<typeof detectWorkspaceConflicts>;
  publishOperationId: string;
  calendarOperationId: string;
  calendarIdempotencyKey: string;
  calendarMessage: ScheduleCalendarFanoutMessage;
  auditEventId: string;
  conflictInsert: (
    entryId: string,
    conflict: ScheduleConflict,
    operationId: string,
  ) => D1PreparedStatement;
}) {
  const {
    env,
    viewer,
    actor,
    command,
    parsed,
    workspace,
    detectedConflicts,
    publishOperationId,
    calendarOperationId,
    calendarIdempotencyKey,
    calendarMessage,
    auditEventId,
    conflictInsert,
  } = input;
  const idempotencyRecordId = command ? crypto.randomUUID() : null;
  const commandGuard = command
    ? `AND EXISTS (
           SELECT 1 FROM idempotency_records command
            WHERE command.id = ? AND command.organisation_id = ?
              AND command.event_id = ? AND command.actor_id = ?
              AND command.scope = 'schedule.publish'
              AND command.idempotency_key = ?
              AND command.request_hash = ? AND command.status = 'processing'
         )`
    : "";
  const commandGuardBindings = command
    ? [
        idempotencyRecordId,
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
      env.DB.prepare(
        `
          DELETE FROM idempotency_records
           WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
             AND scope = 'schedule.publish' AND idempotency_key = ?
             AND expires_at <= unixepoch()
        `,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
      ),
      env.DB.prepare(
        `
          INSERT OR IGNORE INTO idempotency_records (
            id, organisation_id, event_id, actor_id, scope, idempotency_key,
            request_hash, status, expires_at, created_at
          ) VALUES (?, ?, ?, ?, 'schedule.publish', ?, ?, 'processing',
                    unixepoch() + 2592000, unixepoch())
        `,
      ).bind(
        idempotencyRecordId,
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
        command.requestHash,
      ),
    );
  }
  const publishingIndex = statements.length;
  statements.push(
    env.DB.prepare(
      `
        UPDATE schedule_versions
           SET status = 'publishing', revision = revision + 1, publication_operation_id = ?
         WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND revision = ?
           )
           AND NOT EXISTS (
             SELECT 1
               FROM schedule_entries entry
               LEFT JOIN schedule_session_contents content
                 ON content.schedule_version_id = entry.schedule_version_id
                AND content.event_id = entry.event_id
                AND content.session_id = entry.session_id
              WHERE entry.schedule_version_id = ? AND entry.event_id = ?
                AND content.session_id IS NULL
           )
           ${commandGuard}
      `,
    ).bind(
      publishOperationId,
      parsed.scheduleVersionId,
      viewer.eventId,
      parsed.scheduleRevision,
      viewer.eventId,
      viewer.organisationId,
      workspace.event.revision,
      parsed.scheduleVersionId,
      viewer.eventId,
      ...commandGuardBindings,
    ),
    env.DB.prepare(
      `
        UPDATE schedule_versions SET status = 'archived'
         WHERE event_id = ? AND status = 'published' AND id <> ?
           AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
    ).bind(
      viewer.eventId,
      parsed.scheduleVersionId,
      parsed.scheduleVersionId,
      publishOperationId,
    ),
    env.DB.prepare(
      `
        UPDATE schedule_versions
           SET status = 'published', published_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'publishing' AND publication_operation_id = ?
      `,
    ).bind(parsed.scheduleVersionId, viewer.eventId, publishOperationId),
    env.DB.prepare(
      `
        UPDATE sessions SET status = 'published', revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND id IN (SELECT session_id FROM schedule_entries WHERE schedule_version_id = ?)
           AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
    ).bind(
      viewer.eventId,
      parsed.scheduleVersionId,
      parsed.scheduleVersionId,
      publishOperationId,
    ),
    env.DB.prepare(
      `
        DELETE FROM schedule_conflicts
         WHERE event_id = ? AND schedule_version_id = ?
           AND EXISTS (
             SELECT 1 FROM schedule_versions
              WHERE id = ? AND publication_operation_id = ?
           )
      `,
    ).bind(
      viewer.eventId,
      parsed.scheduleVersionId,
      parsed.scheduleVersionId,
      publishOperationId,
    ),
    ...detectedConflicts.map(({ entryId, conflict }) =>
      conflictInsert(entryId, conflict, publishOperationId),
    ),
    env.DB.prepare(
      `
        UPDATE events
           SET programme_published_at = unixepoch(), revision = revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND revision = ?
           AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
    ).bind(
      publishOperationId,
      viewer.eventId,
      viewer.organisationId,
      workspace.event.revision,
      parsed.scheduleVersionId,
      publishOperationId,
    ),
    env.DB.prepare(
      `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'schedule.published', 'schedule_version', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
    ).bind(
      auditEventId,
      viewer.organisationId,
      viewer.eventId,
      actor.personId ?? null,
      actor.actorId ?? null,
      parsed.scheduleVersionId,
      JSON.stringify({ entryCount: workspace.entries.length }),
      parsed.scheduleVersionId,
      publishOperationId,
    ),
    env.DB.prepare(
      `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
          correlation_id, status, payload_json, progress_total, progress_completed,
          progress_failed, cancellable, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'schedule.calendar_fanout', ?, ?, 'queued', ?, 0, 0, 0, 0,
               unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = ? AND event_id = ? AND status = 'published'
              AND publication_operation_id = ?
         )
      `,
    ).bind(
      calendarOperationId,
      viewer.organisationId,
      viewer.eventId,
      actor.personId ?? null,
      calendarIdempotencyKey,
      crypto.randomUUID(),
      JSON.stringify(calendarMessage),
      parsed.scheduleVersionId,
      viewer.eventId,
      publishOperationId,
    ),
    ...scheduleCalendarFanoutSnapshotStatements(
      env,
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: actor.personId ?? null,
      },
      parsed.scheduleVersionId,
      calendarOperationId,
    ),
  );
  const changeIndex = statements.length;
  statements.push(
    env.DB.prepare(
      `
        INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, correlation_id, created_at
        )
        SELECT ?, 'schedule_version', ?, 'published', ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = ? AND event_id = ? AND status = 'published'
              AND publication_operation_id = ?
         )
        RETURNING sequence
      `,
    ).bind(
      viewer.eventId,
      parsed.scheduleVersionId,
      publishOperationId,
      parsed.scheduleVersionId,
      viewer.eventId,
      publishOperationId,
    ),
  );
  if (command) {
    statements.push(
      env.DB.prepare(
        `
          UPDATE idempotency_records
             SET status = 'completed',
                 response_status = 200,
                 response_json = json_object(
                   'calendarOperationId', ?,
                   'changeSequence', (
                     SELECT sequence FROM event_changes
                      WHERE event_id = ? AND entity_type = 'schedule_version'
                        AND entity_id = ? AND change_type = 'published'
                        AND correlation_id = ?
                      ORDER BY sequence DESC LIMIT 1
                   )
                 ),
                 entity_type = 'schedule_version', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'schedule.publish'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1
                 FROM schedule_versions published_version
                 JOIN event_changes committed_change
                   ON committed_change.event_id = published_version.event_id
                  AND committed_change.entity_type = 'schedule_version'
                  AND committed_change.entity_id = published_version.id
                  AND committed_change.change_type = 'published'
                  AND committed_change.correlation_id = ?
                WHERE published_version.id = ?
                  AND published_version.event_id = ?
                  AND published_version.status = 'published'
                  AND published_version.publication_operation_id = ?
             )
        `,
      ).bind(
        calendarOperationId,
        viewer.eventId,
        parsed.scheduleVersionId,
        publishOperationId,
        parsed.scheduleVersionId,
        idempotencyRecordId,
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
        command.requestHash,
        publishOperationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        publishOperationId,
      ),
    );
    statements.push(
      env.DB.prepare(
        `
          DELETE FROM idempotency_records
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'schedule.publish'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND NOT EXISTS (
               SELECT 1 FROM schedule_versions
                WHERE id = ? AND event_id = ? AND status = 'published'
                  AND publication_operation_id = ?
             )
        `,
      ).bind(
        idempotencyRecordId,
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
        command.requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        publishOperationId,
      ),
    );
  }

  return { statements, publishingIndex, changeIndex };
}

export class ScheduleService {
  private readonly airtable;
  private projectionDepth = 0;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private async queueSessionWebhook(
    viewer: Viewer,
    input: {
      eventType: "session.created" | "session.updated";
      sessionId: string;
      revision: number;
      data: Record<string, unknown>;
    },
  ) {
    try {
      const deliveries = await new WebhookService(this.env).queueEvent(viewer, {
        eventType: input.eventType,
        entityType: "session",
        entityId: input.sessionId,
        idempotencyKey: `${input.eventType}:${input.sessionId}:${input.revision}`,
        correlationId: `${input.sessionId}:${input.revision}`,
        data: input.data,
      });
      return {
        deliveries,
        warning: deliveries.some(
          (delivery) => delivery.status === "queue_failed",
        )
          ? "One or more outbound webhook deliveries require retry."
          : null,
      };
    } catch (error) {
      const candidate = error instanceof Error ? error.name : "UnknownError";
      const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(candidate)
        ? candidate
        : "UnknownError";
      console.error(
        JSON.stringify({
          level: "error",
          subsystem: "schedule-session-webhook",
          event: "record-failed",
          errorName,
          message: "The schedule session webhook event could not be recorded.",
        }),
      );
      return {
        deliveries: [],
        warning: "The outbound webhook event could not be recorded.",
      };
    }
  }

  private async projectCommand<T>(
    viewer: ScheduleEventScope & { personId?: string | null },
    operation: string,
    input: unknown,
    execute: () => Promise<T>,
    identity?: string | { idempotencyKey: string; requestHash: string },
  ) {
    const key =
      typeof identity === "string"
        ? identity
        : (identity?.idempotencyKey ??
          (await airtableCommandKey(operation, viewer, input)));
    return this.airtable.executeIdempotent(
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: viewer.personId ?? null,
      },
      {
        idempotencyKey: key,
        operation,
        ...(typeof identity === "object"
          ? { requestHash: identity.requestHash }
          : {}),
      },
      async () => {
        this.projectionDepth += 1;
        try {
          return await execute();
        } finally {
          this.projectionDepth -= 1;
        }
      },
    );
  }

  private async projectIntentCommand<T>(
    viewer: ScheduleEventScope & { personId?: string | null },
    operation: string,
    intentId: string,
    input: unknown,
    execute: () => Promise<T>,
  ) {
    return this.airtable.executeIdempotent(
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: viewer.personId ?? null,
      },
      await airtableIntentCommand(operation, viewer, intentId, input),
      async () => {
        this.projectionDepth += 1;
        try {
          return await execute();
        } finally {
          this.projectionDepth -= 1;
        }
      },
    );
  }

  private async replayPublication(
    viewer: ScheduleEventScope,
    command: SchedulePublicationCommand,
  ): Promise<SchedulePublicationResult | null> {
    const record = await this.env.DB.prepare(
      `
      SELECT request_hash AS requestHash, status, response_json AS responseJson,
             entity_id AS entityId
        FROM idempotency_records
       WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
         AND scope = 'schedule.publish' AND idempotency_key = ?
         AND expires_at > unixepoch()
    `,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
      )
      .first<{
        requestHash: string;
        status: string;
        responseJson: string | null;
        entityId: string | null;
      }>();
    if (!record) return null;
    if (record.requestHash !== command.requestHash) {
      throw new ScheduleIdempotencyConflictError(
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used with a different schedule publication request.",
      );
    }
    if (record.status !== "completed") {
      throw new ScheduleIdempotencyConflictError(
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        "The schedule publication with this Idempotency-Key is still being processed.",
      );
    }
    let response: unknown;
    try {
      response = record.responseJson ? JSON.parse(record.responseJson) : null;
    } catch {
      response = null;
    }
    const changeSequence = (response as { changeSequence?: unknown } | null)
      ?.changeSequence;
    if (
      !response ||
      typeof response !== "object" ||
      typeof (response as { calendarOperationId?: unknown })
        .calendarOperationId !== "string" ||
      typeof changeSequence !== "number" ||
      !Number.isSafeInteger(changeSequence) ||
      changeSequence < 1 ||
      !record.entityId
    ) {
      throw new Error(
        "The completed schedule idempotency record is missing its durable result.",
      );
    }
    const calendarOperationId = (response as { calendarOperationId: string })
      .calendarOperationId;
    const operation = await this.env.DB.prepare(
      `
      SELECT status, last_error AS lastError
        FROM operation_jobs
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND type = 'schedule.calendar_fanout'
    `,
    )
      .bind(calendarOperationId, viewer.eventId, viewer.organisationId)
      .first<{ status: string; lastError: string | null }>();
    if (!operation) {
      throw new Error(
        "The completed schedule publication is missing its calendar fan-out operation.",
      );
    }
    const queueFailed = operation.status === "queue_failed";
    return {
      published: true,
      scheduleVersionId: record.entityId,
      changeSequence,
      calendar: {
        operationId: calendarOperationId,
        status: queueFailed ? "queue_failed" : "queued",
        dispatchError: queueFailed
          ? (operation.lastError ??
            "The calendar fan-out Queue dispatch failed.")
          : null,
      },
    };
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

  async getWorkspace(viewer: ScheduleEventScope): Promise<ScheduleWorkspace> {
    if (this.projectionDepth === 0) await this.airtable.assertReadable(viewer);
    return this.getWorkspaceD1(viewer);
  }

  private async getWorkspaceD1(
    viewer: ScheduleEventScope,
  ): Promise<ScheduleWorkspace> {
    const event = await this.env.DB.prepare(
      `
      SELECT e.id, e.name, e.starts_at AS startsAt, e.ends_at AS endsAt,
             e.timezone, e.brand_accent AS brandAccent, e.revision,
             e.repository_provider AS repositoryProvider,
             e.session_formats_json AS sessionFormatsJson
        FROM events e
       WHERE e.id = ? AND e.organisation_id = ?
    `,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<WorkspaceEvent>();
    if (!event) throw new Error("Event not found.");

    const [version, rooms, tracks, sessions, policyRow] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT id, version_number AS versionNumber, status, revision, notes
          FROM schedule_versions
         WHERE event_id = ? AND status IN ('draft','published')
         ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END, version_number DESC
         LIMIT 1
      `,
      )
        .bind(viewer.eventId)
        .first<{
          id: string;
          versionNumber: number;
          status: string;
          revision: number;
          notes: string;
        }>(),
      this.env.DB.prepare(
        "SELECT id, name, capacity, resources_json AS resourcesJson FROM rooms WHERE event_id = ? AND status = 'active' ORDER BY position, name",
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          name: string;
          capacity: number;
          resourcesJson: string;
        }>(),
      this.env.DB.prepare(
        "SELECT id, name, exclusive FROM tracks WHERE event_id = ? ORDER BY position, name",
      )
        .bind(viewer.eventId)
        .all<{ id: string; name: string; exclusive: number }>(),
      this.env.DB.prepare(
        `
        SELECT s.id,
               COALESCE(content.title, s.title) AS title,
               COALESCE(content.slug, s.slug) AS slug,
               COALESCE(content.description, s.description, '') AS description,
               COALESCE(content.track_id, s.track_id) AS trackId,
               t.name AS trackName,
               COALESCE(t.exclusive, 0) AS trackExclusive,
               COALESCE(content.format, s.format) AS format,
               COALESCE(content.duration_minutes, s.duration_minutes) AS durationMinutes,
               s.expected_attendance AS expectedAttendance,
               COALESCE(content.required_resources_json, s.required_resources_json) AS requiredResourcesJson,
               COALESCE(content.visibility, s.visibility) AS visibility,
               content.session_id AS snapshotSessionId, s.status,
               s.revision,
               GROUP_CONCAT(ss.person_id, '||') AS speakerIds,
               GROUP_CONCAT(p.display_name, '||') AS speakerNames
          FROM sessions s
          LEFT JOIN schedule_session_contents content
            ON content.event_id = s.event_id AND content.session_id = s.id
           AND content.schedule_version_id = (
             SELECT active.id
               FROM schedule_versions active
              WHERE active.event_id = s.event_id
                AND active.status IN ('draft','published')
              ORDER BY CASE active.status WHEN 'draft' THEN 0 ELSE 1 END,
                       active.version_number DESC
              LIMIT 1
           )
          LEFT JOIN tracks t
            ON t.id = COALESCE(content.track_id, s.track_id)
           AND t.event_id = s.event_id
          LEFT JOIN session_speakers ss ON ss.session_id = s.id AND ss.event_id = s.event_id
          LEFT JOIN people p ON p.id = ss.person_id
         WHERE s.event_id = ? AND s.status IN ('unscheduled','scheduled','published')
         GROUP BY s.id, t.id
         ORDER BY s.title
      `,
      )
        .bind(viewer.eventId)
        .all<
          Omit<
            ScheduleSession,
            | "speakerIds"
            | "speakerNames"
            | "trackExclusive"
            | "requiredResources"
          > & {
            trackExclusive: number;
            requiredResourcesJson: string;
            snapshotSessionId: string | null;
            speakerIds: string | null;
            speakerNames: string | null;
          }
        >(),
      this.env.DB.prepare(
        `
        SELECT room_overlap_action AS roomAction, speaker_overlap_action AS speakerAction,
               required_resource_overlap_action AS resourceAction,
               exclusive_track_overlap_action AS trackAction,
               event_boundary_action AS boundaryAction,
               capacity_action AS capacityAction,
               minimum_turnaround_minutes AS minimumTurnaroundMinutes,
               revision
          FROM schedule_policies WHERE event_id = ?
      `,
      )
        .bind(viewer.eventId)
        .first<{
          roomAction: string;
          speakerAction: string;
          resourceAction: string;
          trackAction: string;
          boundaryAction: string;
          capacityAction: string;
          minimumTurnaroundMinutes: number;
          revision: number;
        }>(),
    ]);

    if (!policyRow) throw new ScheduleConfigurationError();
    const currentVersion = version ?? null;
    const [entries, conflicts] = currentVersion
      ? await Promise.all([
          this.env.DB.prepare(
            `
        SELECT id, session_id AS sessionId, room_id AS roomId, starts_at AS startsAt,
               ends_at AS endsAt, revision
          FROM schedule_entries
         WHERE event_id = ? AND schedule_version_id = ?
         ORDER BY starts_at, room_id
      `,
          )
            .bind(viewer.eventId, currentVersion.id)
            .all<ScheduleEntry>(),
          this.env.DB.prepare(
            `
        SELECT id, conflict_type AS type, severity,
               COALESCE(json_extract(details_json, '$.message'), conflict_type) AS message
          FROM schedule_conflicts
         WHERE event_id = ? AND schedule_version_id = ? AND resolved_at IS NULL
         ORDER BY severity, created_at
      `,
          )
            .bind(viewer.eventId, currentVersion.id)
            .all<{
              id: string;
              type: string;
              severity: string;
              message: string;
            }>(),
        ])
      : [{ results: [] }, { results: [] }];
    const scheduledSessionIds = new Set(
      entries.results.map((entry) => entry.sessionId),
    );
    if (
      currentVersion &&
      sessions.results.some(
        (session) =>
          scheduledSessionIds.has(session.id) && !session.snapshotSessionId,
      )
    ) {
      throw new ScheduleConfigurationError(
        "The active schedule version is missing one or more frozen session-content snapshots.",
      );
    }

    let parsedFormats: ScheduleWorkspace["sessionFormats"];
    try {
      parsedFormats = parseSessionFormatsConfiguration(
        event.sessionFormatsJson,
      );
    } catch (error) {
      throw new ScheduleConfigurationError(
        error instanceof Error
          ? error.message
          : "The event has invalid session-format configuration.",
      );
    }
    const formatKeys = new Set(parsedFormats.map((format) => format.key));
    if (sessions.results.some((session) => !formatKeys.has(session.format))) {
      throw new ScheduleConfigurationError(
        "A session uses a format that is not configured for this event.",
      );
    }
    const configuredRooms = rooms.results.map(({ resourcesJson, ...room }) => {
      let resources: unknown;
      try {
        resources = JSON.parse(resourcesJson);
      } catch {
        throw new ScheduleConfigurationError(
          `Room ${room.id} has invalid resource inventory JSON.`,
        );
      }
      const parsed = eventResourceSchema.array().max(50).safeParse(resources);
      if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
        throw new ScheduleConfigurationError(
          `Room ${room.id} has invalid or duplicate resource inventory entries.`,
        );
      }
      return { ...room, resources: parsed.data };
    });
    const configuredSessions = sessions.results.map(
      ({ snapshotSessionId: _snapshotSessionId, ...session }) => {
        let resources: unknown;
        try {
          resources = JSON.parse(session.requiredResourcesJson);
        } catch {
          throw new ScheduleConfigurationError(
            `Session ${session.id} has invalid required resource JSON.`,
          );
        }
        const parsed = eventResourceSchema.array().max(50).safeParse(resources);
        if (
          !parsed.success ||
          new Set(parsed.data).size !== parsed.data.length
        ) {
          throw new ScheduleConfigurationError(
            `Session ${session.id} has invalid or duplicate required resources.`,
          );
        }
        return {
          ...session,
          requiredResources: parsed.data,
          trackExclusive: Boolean(session.trackExclusive),
          speakerIds: session.speakerIds ? session.speakerIds.split("||") : [],
          speakerNames: session.speakerNames
            ? session.speakerNames.split("||")
            : [],
        };
      },
    );

    const workspace: ScheduleWorkspace = {
      event,
      version: currentVersion,
      rooms: configuredRooms,
      tracks: tracks.results.map((track) => ({
        ...track,
        exclusive: Boolean(track.exclusive),
      })),
      sessionFormats: parsedFormats,
      sessions: configuredSessions,
      entries: entries.results,
      conflicts: conflicts.results,
      publicationConflicts: [],
      policies: {
        room: policy(policyRow.roomAction),
        speaker: policy(policyRow.speakerAction),
        resource: policy(policyRow.resourceAction),
        track: policy(policyRow.trackAction),
        boundary: policy(policyRow.boundaryAction),
        capacity: policy(policyRow.capacityAction),
        minimumTurnaroundMinutes: policyRow.minimumTurnaroundMinutes,
      },
      policyRevision: policyRow.revision,
    };
    return {
      ...workspace,
      publicationConflicts: detectWorkspaceConflicts(workspace).map(
        ({ conflict }) => conflict,
      ),
    };
  }

  async getConflictedSessionIds(
    viewer: ScheduleEventScope,
    scheduleVersionId: string,
  ) {
    await this.airtable.assertReadable(viewer);
    const rows = await this.env.DB.prepare(
      `SELECT DISTINCT entry.session_id AS sessionId
         FROM events event
         JOIN schedule_versions version
           ON version.event_id = event.id AND version.id = ?
         JOIN schedule_entries entry
           ON entry.event_id = version.event_id
          AND entry.schedule_version_id = version.id
         JOIN schedule_conflicts conflict
           ON conflict.event_id = entry.event_id
          AND conflict.schedule_version_id = entry.schedule_version_id
          AND (conflict.primary_entry_id = entry.id
            OR conflict.conflicting_entry_id = entry.id)
        WHERE event.id = ? AND event.organisation_id = ?
          AND conflict.resolved_at IS NULL
        ORDER BY entry.session_id`,
    )
      .bind(scheduleVersionId, viewer.eventId, viewer.organisationId)
      .all<{ sessionId: string }>();
    return rows.results.map((row) => row.sessionId);
  }

  async createDraft(viewer: Viewer, intentId: string = crypto.randomUUID()) {
    return this.projectIntentCommand(
      viewer,
      "schedule.draft.create",
      intentId,
      {},
      () => this.createDraftD1(viewer),
    );
  }

  private async createDraftD1(viewer: Viewer) {
    const existing = await this.env.DB.prepare(
      "SELECT id FROM schedule_versions WHERE event_id = ? AND status = 'draft'",
    )
      .bind(viewer.eventId)
      .first<{ id: string }>();
    if (existing) return existing.id;
    const workspace = await this.getWorkspace(viewer);
    if (workspace.version?.status === "draft") return workspace.version.id;
    const sourceId =
      workspace.version?.status === "published" ? workspace.version.id : null;
    const state = await this.env.DB.prepare(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS nextVersion FROM schedule_versions WHERE event_id = ?",
    )
      .bind(viewer.eventId)
      .first<{ nextVersion: number }>();
    if (!state || !Number.isSafeInteger(state.nextVersion)) {
      throw new Error("The next schedule version could not be determined.");
    }
    const id = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const nextVersion = state.nextVersion;
    const clonedEntryIds = new Map(
      workspace.entries.map((entry) => [entry.id, crypto.randomUUID()]),
    );
    const conflicts = sourceId ? detectWorkspaceConflicts(workspace) : [];
    const [inserted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO schedule_versions (
          id, event_id, version_number, name, notes, status, revision,
          publication_operation_id, created_by_person_id, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'draft', 1, ?, ?, unixepoch()
         WHERE NOT EXISTS (
           SELECT 1 FROM schedule_versions WHERE event_id = ? AND status = 'draft'
         )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND revision = ?
           )
        ON CONFLICT(event_id, version_number) DO NOTHING
      `,
      ).bind(
        id,
        viewer.eventId,
        nextVersion,
        `Version ${nextVersion}`,
        workspace.version?.notes ?? "",
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.eventId,
        viewer.organisationId,
        workspace.event.revision,
      ),
      ...workspace.entries.map((entry) =>
        this.env.DB.prepare(
          `
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id, starts_at, ends_at, revision, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM schedule_versions target
            WHERE target.id = ? AND target.event_id = ? AND target.status = 'draft'
              AND target.publication_operation_id = ?
         )
      `,
        ).bind(
          clonedEntryIds.get(entry.id),
          viewer.eventId,
          id,
          entry.sessionId,
          entry.roomId,
          entry.startsAt,
          entry.endsAt,
          id,
          viewer.eventId,
          operationId,
        ),
      ),
      ...conflicts.map(({ entryId, conflict }) =>
        this.conflictInsert(
          viewer.eventId,
          id,
          clonedEntryIds.get(entryId)!,
          {
            ...conflict,
            conflictingEntryId: conflict.conflictingEntryId
              ? clonedEntryIds.get(conflict.conflictingEntryId)
              : undefined,
          },
          operationId,
        ),
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'schedule.draft.created', 'schedule_version', ?, ?, unixepoch()
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
        id,
        JSON.stringify({ versionNumber: nextVersion }),
        id,
        viewer.eventId,
        operationId,
      ),
    ]);
    if ((inserted.meta.changes ?? 0) === 1) return id;
    const winner = await this.env.DB.prepare(
      "SELECT id FROM schedule_versions WHERE event_id = ? AND status = 'draft' ORDER BY version_number DESC LIMIT 1",
    )
      .bind(viewer.eventId)
      .first<{ id: string }>();
    if (winner) return winner.id;
    throw new ScheduleRevisionConflictError();
  }

  async place(
    viewer: Viewer,
    input: unknown,
    command?: SchedulePlacementCommand,
  ): Promise<SchedulePlacementResult> {
    if (command) {
      if (command.actorId !== `assistant:${viewer.personId}`) {
        throw new Error(
          "The schedule placement idempotency actor must match the authenticated person.",
        );
      }
      if (
        !command.idempotencyKey.startsWith("assistant:") ||
        command.idempotencyKey.length <= "assistant:".length
      ) {
        throw new Error(
          "Assistant schedule placement idempotency keys must identify the approved proposal.",
        );
      }
      if (!/^[0-9a-f]{64}$/u.test(command.requestHash)) {
        throw new Error(
          "Assistant schedule placement request hashes must be lowercase SHA-256 values.",
        );
      }
    }
    const projectionIdentity = command
      ? {
          idempotencyKey: `airtable:${viewer.eventId}:schedule.entry.place:${command.actorId}:${command.idempotencyKey}`,
          requestHash: command.requestHash,
        }
      : undefined;
    return this.projectCommand(
      viewer,
      "schedule.entry.place",
      input,
      () => this.placeD1(viewer, input, command),
      projectionIdentity,
    );
  }

  private async placeD1(
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
        requiredResources: item.requiredResources,
        expectedAttendance: item.expectedAttendance,
        title: item.title,
      };
    });
    const conflicts = detectScheduleConflicts({
      candidate: {
        sessionId: session.id,
        roomId: parsed.roomId,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        trackId: session.trackId,
        trackExclusive: session.trackExclusive,
        speakerIds: session.speakerIds,
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
    const result: SchedulePlacementResult = {
      entryId,
      scheduleRevision: parsed.scheduleRevision + 1,
      warnings: conflicts,
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
      ...conflicts.map((conflict) =>
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
        UPDATE sessions SET status = 'scheduled', revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status IN ('unscheduled','scheduled')
           AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
      ).bind(
        parsed.sessionId,
        viewer.eventId,
        parsed.scheduleVersionId,
        versionOperationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'schedule.entry.placed', 'schedule_entry', ?, ?, unixepoch()
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

  async createBreak(viewer: Viewer, input: unknown) {
    const result = await this.projectCommand(
      viewer,
      "schedule.break.create",
      input,
      () => this.createBreakD1(viewer, input),
    );
    const webhook = await this.queueSessionWebhook(viewer, {
      eventType: "session.created",
      sessionId: result.sessionId,
      revision: 1,
      data: { format: "break", revision: 1 },
    });
    return {
      ...result,
      webhookDeliveries: webhook.deliveries,
      webhookWarning: webhook.warning,
    };
  }

  private async createBreakD1(viewer: Viewer, input: unknown) {
    const parsed = scheduleBreakSchema.parse(input);
    const workspace = await this.getWorkspace(viewer);
    if (!workspace.sessionFormats.some((format) => format.key === "break")) {
      throw new ScheduleConfigurationError(
        "Configure the break session format in Event Setup before creating breaks.",
      );
    }
    const configuredResources = new Set(
      workspace.rooms.flatMap((room) => room.resources),
    );
    const unconfigured = parsed.requiredResources.find(
      (resource) => !configuredResources.has(resource),
    );
    if (unconfigured) {
      throw new ScheduleConfigurationError(
        `Required resource “${unconfigured}” is not configured in any active room.`,
      );
    }
    const resources = parsed.requiredResources;
    const sessionId = crypto.randomUUID();
    const slug = `break-${sessionId}`;
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "session.created",
        entityType: "session",
        entityId: sessionId,
        idempotencyKey: `session.created:${sessionId}:1`,
        correlationId: `${sessionId}:1`,
        data: { format: "break", revision: 1 },
      },
      auditEventId,
    );
    const [inserted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO sessions (
          id, event_id, title, slug, description, format, duration_minutes,
          required_resources_json, status, visibility, revision, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, 'break', ?, ?, 'unscheduled', 'public', 1,
               unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND revision = ?
         )
      `,
      ).bind(
        sessionId,
        viewer.eventId,
        parsed.title,
        slug,
        `${parsed.title} break`,
        parsed.durationMinutes,
        JSON.stringify(resources),
        viewer.eventId,
        viewer.organisationId,
        workspace.event.revision,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'schedule.break.created', 'session', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND event_id = ?)
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        sessionId,
        JSON.stringify({
          title: parsed.title,
          durationMinutes: parsed.durationMinutes,
          requiredResources: resources,
        }),
        sessionId,
        viewer.eventId,
      ),
      ...preparedWebhook.statements,
    ]);
    if ((inserted.meta.changes ?? 0) !== 1)
      throw new ScheduleRevisionConflictError();
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return { sessionId };
  }

  async updateSessionResources(viewer: Viewer, input: unknown) {
    const result = await this.projectCommand(
      viewer,
      "schedule.session_resources.update",
      input,
      () => this.updateSessionResourcesD1(viewer, input),
    );
    const webhook = await this.queueSessionWebhook(viewer, {
      eventType: "session.updated",
      sessionId: result.sessionId,
      revision: result.revision,
      data: {
        revision: result.revision,
        changedFields: ["requiredResources"],
      },
    });
    return {
      ...result,
      webhookDeliveries: webhook.deliveries,
      webhookWarning: webhook.warning,
    };
  }

  private async updateSessionResourcesD1(viewer: Viewer, input: unknown) {
    const parsed = scheduleSessionResourcesSchema.parse(input);
    const workspace = await this.getWorkspace(viewer);
    if (
      !workspace.version ||
      workspace.version.id !== parsed.scheduleVersionId ||
      workspace.version.status !== "draft"
    ) {
      throw new ScheduleNotFoundError(
        "Create an active draft before changing session scheduling requirements.",
      );
    }
    if (workspace.version.revision !== parsed.scheduleRevision) {
      throw new ScheduleRevisionConflictError();
    }
    const session = workspace.sessions.find(
      (candidate) => candidate.id === parsed.sessionId,
    );
    if (!session) throw new ScheduleNotFoundError("Session not found.");
    if (session.revision !== parsed.sessionRevision) {
      throw new ScheduleRevisionConflictError();
    }
    const configuredResources = new Set(
      workspace.rooms.flatMap((room) => room.resources),
    );
    const unconfigured = parsed.requiredResources.find(
      (resource) => !configuredResources.has(resource),
    );
    if (unconfigured) {
      throw new ScheduleConfigurationError(
        `Required resource “${unconfigured}” is not configured in any active room.`,
      );
    }

    const prospective: ScheduleWorkspace = {
      ...workspace,
      sessions: workspace.sessions.map((candidate) =>
        candidate.id === session.id
          ? { ...candidate, requiredResources: parsed.requiredResources }
          : candidate,
      ),
    };
    const conflicts = detectWorkspaceConflicts(prospective);
    const scheduledEntry = workspace.entries.find(
      (entry) => entry.sessionId === session.id,
    );
    const blockers = scheduledEntry
      ? conflicts
          .filter(
            ({ entryId, conflict }) =>
              conflict.severity === "blocking" &&
              (entryId === scheduledEntry.id ||
                conflict.conflictingEntryId === scheduledEntry.id),
          )
          .map(({ conflict }) => conflict)
      : [];
    if (blockers.length) throw new SchedulePlacementBlockedError(blockers);

    const operationId = crypto.randomUUID();
    const nextSessionRevision = session.revision + 1;
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "session.updated",
        entityType: "session",
        entityId: session.id,
        idempotencyKey: `session.updated:${session.id}:${nextSessionRevision}`,
        correlationId: `${session.id}:${nextSessionRevision}`,
        data: {
          revision: nextSessionRevision,
          changedFields: ["requiredResources"],
        },
      },
      auditEventId,
    );
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1, last_operation_id = ?,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions version
               WHERE version.id = ? AND version.event_id = events.id
                 AND version.status = 'draft' AND version.revision = ?
            )
            AND EXISTS (
              SELECT 1 FROM sessions configured
               WHERE configured.id = ? AND configured.event_id = events.id
                 AND configured.revision = ?
            )`,
      ).bind(
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        workspace.event.revision,
        parsed.scheduleVersionId,
        parsed.scheduleRevision,
        session.id,
        parsed.sessionRevision,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_versions
            SET revision = revision + 1, publication_operation_id = ?
          WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        operationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE sessions
            SET required_resources_json = ?, revision = revision + 1,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND publication_operation_id = ?
            )`,
      ).bind(
        JSON.stringify(parsed.requiredResources),
        session.id,
        viewer.eventId,
        parsed.sessionRevision,
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_session_contents
            SET required_resources_json = ?, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = schedule_session_contents.schedule_version_id
                 AND event_id = schedule_session_contents.event_id
                 AND status = 'draft' AND publication_operation_id = ?
            )`,
      ).bind(
        JSON.stringify(parsed.requiredResources),
        operationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        operationId,
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
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'session.resources.updated', 'session', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM schedule_versions
             WHERE id = ? AND event_id = ? AND publication_operation_id = ?
          )`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        session.id,
        JSON.stringify({
          requiredResources: parsed.requiredResources,
          revision: nextSessionRevision,
        }),
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
    ];
    const auditIndex = statements.length - 1;
    statements.push(...preparedWebhook.statements);
    const results = await this.env.DB.batch(statements);
    const [eventUpdated, versionUpdated, sessionUpdated, snapshotUpdated] =
      results;
    const audit = results[auditIndex]!;
    if (
      (eventUpdated.meta.changes ?? 0) !== 1 ||
      (versionUpdated.meta.changes ?? 0) !== 1 ||
      (sessionUpdated.meta.changes ?? 0) !== 1 ||
      (snapshotUpdated.meta.changes ?? 0) !== 1 ||
      (audit.meta.changes ?? 0) !== 1
    ) {
      throw new ScheduleRevisionConflictError();
    }
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return {
      sessionId: session.id,
      revision: nextSessionRevision,
      warnings: conflicts
        .filter(
          ({ entryId, conflict }) =>
            conflict.severity === "warning" &&
            scheduledEntry !== undefined &&
            (entryId === scheduledEntry.id ||
              conflict.conflictingEntryId === scheduledEntry.id),
        )
        .map(({ conflict }) => conflict),
    };
  }

  private async replayEditorCommand<T>(
    viewer: Viewer,
    scope: "schedule.session_content.save" | "schedule.notes.save",
    idempotencyKey: string,
    requestHash: string,
    parse: (value: unknown) => T,
  ): Promise<T | null> {
    const record = await this.env.DB.prepare(
      `SELECT request_hash AS requestHash, status, response_json AS responseJson
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ? AND expires_at > unixepoch()`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        scope,
        idempotencyKey,
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
        "This editor save identifier was already used for different content.",
      );
    }
    if (record.status !== "completed") {
      throw new ScheduleIdempotencyConflictError(
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        record.status === "failed"
          ? "This editor save did not complete. Make another edit or explicitly retry with a new save identifier."
          : "This editor save is still being processed. Retry the same save shortly.",
      );
    }
    if (!record.responseJson) {
      throw new Error(
        "The completed editor save is missing its durable response.",
      );
    }
    let response: unknown;
    try {
      response = JSON.parse(record.responseJson);
    } catch {
      throw new Error(
        "The completed editor save has an invalid durable response.",
      );
    }
    return parse(response);
  }

  async updateSessionContent(viewer: Viewer, input: unknown) {
    const parsed = scheduleSessionContentSchema.parse(input);
    const requestHash = await airtableCommandKey(
      "schedule.session_content.save.request",
      viewer,
      {
        ...parsed,
        idempotencyKey: undefined,
      },
    );
    const projectionKey = `airtable:${viewer.eventId}:schedule.session_content.save:actor:${viewer.personId}:${parsed.idempotencyKey}`;
    const result = await this.projectCommand(
      viewer,
      "schedule.session_content.save",
      parsed,
      () => this.updateSessionContentD1(viewer, parsed, requestHash),
      { idempotencyKey: projectionKey, requestHash },
    );
    const webhook = await this.queueSessionWebhook(viewer, {
      eventType: "session.updated",
      sessionId: result.sessionId,
      revision: result.revision,
      data: {
        revision: result.revision,
        changedFields: [
          "title",
          "description",
          "format",
          "durationMinutes",
          "trackId",
          "visibility",
          "requiredResources",
        ],
      },
    });
    return {
      ...result,
      webhookDeliveries: webhook.deliveries,
      webhookWarning: webhook.warning,
    };
  }

  private async updateSessionContentD1(
    viewer: Viewer,
    parsed: ReturnType<typeof scheduleSessionContentSchema.parse>,
    requestHash: string,
  ) {
    type Result = {
      sessionId: string;
      revision: number;
      scheduleRevision: number;
      warnings: ScheduleConflict[];
    };
    const parseResult = (value: unknown): Result => {
      if (!value || typeof value !== "object")
        throw new Error("The saved session-content response is invalid.");
      const result = value as Partial<Result>;
      if (
        typeof result.sessionId !== "string" ||
        !Number.isSafeInteger(result.revision) ||
        !Number.isSafeInteger(result.scheduleRevision) ||
        !Array.isArray(result.warnings)
      ) {
        throw new Error("The saved session-content response is invalid.");
      }
      return result as Result;
    };
    const replay = await this.replayEditorCommand(
      viewer,
      "schedule.session_content.save",
      parsed.idempotencyKey,
      requestHash,
      parseResult,
    );
    if (replay) return replay;

    const workspace = await this.getWorkspace(viewer);
    if (
      !workspace.version ||
      workspace.version.id !== parsed.scheduleVersionId ||
      workspace.version.status !== "draft"
    ) {
      throw new ScheduleNotFoundError(
        "Create an active draft before editing session content.",
      );
    }
    if (workspace.version.revision !== parsed.scheduleRevision)
      throw new ScheduleRevisionConflictError();
    const session = workspace.sessions.find(
      (candidate) => candidate.id === parsed.sessionId,
    );
    if (!session) throw new ScheduleNotFoundError("Session not found.");
    if (session.revision !== parsed.sessionRevision)
      throw new ScheduleRevisionConflictError();
    if (
      !workspace.sessionFormats.some((format) => format.key === parsed.format)
    ) {
      throw new ScheduleConfigurationError(
        `Session format “${parsed.format}” is not configured for this event.`,
      );
    }
    if (
      parsed.trackId &&
      !workspace.tracks.some((track) => track.id === parsed.trackId)
    ) {
      throw new ScheduleConfigurationError(
        "The selected track is not available in this event.",
      );
    }
    const configuredResources = new Set(
      workspace.rooms.flatMap((room) => room.resources),
    );
    const unconfigured = parsed.requiredResources.find(
      (resource) => !configuredResources.has(resource),
    );
    if (unconfigured) {
      throw new ScheduleConfigurationError(
        `Required resource “${unconfigured}” is not configured in any active room.`,
      );
    }

    const scheduledEntry = workspace.entries.find(
      (entry) => entry.sessionId === session.id,
    );
    const prospectiveSession: ScheduleSession = {
      ...session,
      title: parsed.title,
      description: parsed.description,
      trackId: parsed.trackId,
      trackName:
        workspace.tracks.find((track) => track.id === parsed.trackId)?.name ??
        null,
      trackExclusive:
        workspace.tracks.find((track) => track.id === parsed.trackId)
          ?.exclusive ?? false,
      format: parsed.format,
      durationMinutes: parsed.durationMinutes,
      requiredResources: parsed.requiredResources,
      visibility: parsed.visibility,
    };
    const prospective: ScheduleWorkspace = {
      ...workspace,
      sessions: workspace.sessions.map((candidate) =>
        candidate.id === session.id ? prospectiveSession : candidate,
      ),
      entries: workspace.entries.map((entry) =>
        entry.sessionId === session.id
          ? {
              ...entry,
              endsAt: entry.startsAt + parsed.durationMinutes * 60,
            }
          : entry,
      ),
    };
    const conflicts = detectWorkspaceConflicts(prospective);
    const relatedConflicts = scheduledEntry
      ? conflicts
          .filter(
            ({ entryId, conflict }) =>
              entryId === scheduledEntry.id ||
              conflict.conflictingEntryId === scheduledEntry.id,
          )
          .map(({ conflict }) => conflict)
      : [];
    const blockers = relatedConflicts.filter(
      (conflict) => conflict.severity === "blocking",
    );
    if (blockers.length) throw new SchedulePlacementBlockedError(blockers);
    const warnings = relatedConflicts.filter(
      (conflict) => conflict.severity === "warning",
    );

    const commandId = crypto.randomUUID();
    const nextRevision = session.revision + 1;
    const nextScheduleRevision = workspace.version.revision + 1;
    const result: Result = {
      sessionId: session.id,
      revision: nextRevision,
      scheduleRevision: nextScheduleRevision,
      warnings,
    };
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "session.updated",
        entityType: "session",
        entityId: session.id,
        idempotencyKey: `session.updated:${session.id}:${nextRevision}`,
        correlationId: `${session.id}:${nextRevision}`,
        data: {
          revision: nextRevision,
          changedFields: [
            "title",
            "description",
            "format",
            "durationMinutes",
            "trackId",
            "visibility",
            "requiredResources",
          ],
        },
      },
      auditEventId,
    );
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = 'schedule.session_content.save'
            AND idempotency_key = ? AND expires_at <= unixepoch()`,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, 'schedule.session_content.save', ?, ?,
                   'processing', unixepoch() + 604800, unixepoch())`,
      ).bind(
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
      ),
      this.env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1, last_operation_id = ?,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM idempotency_records command
               WHERE command.id = ? AND command.organisation_id = ?
                 AND command.event_id = ? AND command.actor_id = ?
                 AND command.scope = 'schedule.session_content.save'
                 AND command.idempotency_key = ?
                 AND command.request_hash = ? AND command.status = 'processing'
            )
            AND EXISTS (
              SELECT 1 FROM schedule_versions version
               WHERE version.id = ? AND version.event_id = events.id
                 AND version.status = 'draft' AND version.revision = ?
            )
            AND EXISTS (
              SELECT 1 FROM sessions current_session
               WHERE current_session.id = ?
                 AND current_session.event_id = events.id
                 AND current_session.revision = ?
            )`,
      ).bind(
        commandId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        workspace.event.revision,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        parsed.scheduleRevision,
        session.id,
        parsed.sessionRevision,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_versions
            SET revision = revision + 1, publication_operation_id = ?
          WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        commandId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        viewer.eventId,
        viewer.organisationId,
        commandId,
      ),
      this.env.DB.prepare(
        `UPDATE sessions
            SET title = ?, description = ?, track_id = ?, format = ?,
                duration_minutes = ?, required_resources_json = ?,
                visibility = ?, revision = revision + 1,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND status = 'draft'
                 AND publication_operation_id = ?
            )`,
      ).bind(
        parsed.title,
        parsed.description || null,
        parsed.trackId,
        parsed.format,
        parsed.durationMinutes,
        JSON.stringify(parsed.requiredResources),
        parsed.visibility,
        session.id,
        viewer.eventId,
        parsed.sessionRevision,
        parsed.scheduleVersionId,
        viewer.eventId,
        commandId,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_session_contents
            SET title = ?, description = ?, track_id = ?, format = ?,
                duration_minutes = ?, required_resources_json = ?,
                visibility = ?, last_operation_id = ?, updated_at = unixepoch()
          WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = schedule_session_contents.schedule_version_id
                 AND event_id = schedule_session_contents.event_id
                 AND status = 'draft' AND publication_operation_id = ?
            )`,
      ).bind(
        parsed.title,
        parsed.description || null,
        parsed.trackId,
        parsed.format,
        parsed.durationMinutes,
        JSON.stringify(parsed.requiredResources),
        parsed.visibility,
        commandId,
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        commandId,
      ),
      ...(scheduledEntry
        ? [
            this.env.DB.prepare(
              `UPDATE schedule_entries
                  SET ends_at = starts_at + ?, revision = revision + 1,
                      updated_at = unixepoch()
                WHERE id = ? AND event_id = ? AND schedule_version_id = ?
                  AND revision = ?
                  AND EXISTS (
                    SELECT 1 FROM schedule_versions
                     WHERE id = schedule_entries.schedule_version_id
                       AND event_id = schedule_entries.event_id
                       AND status = 'draft' AND publication_operation_id = ?
                  )`,
            ).bind(
              parsed.durationMinutes * 60,
              scheduledEntry.id,
              viewer.eventId,
              parsed.scheduleVersionId,
              scheduledEntry.revision,
              commandId,
            ),
          ]
        : []),
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
        commandId,
      ),
      ...conflicts.map(({ entryId, conflict }) =>
        this.conflictInsert(
          viewer.eventId,
          parsed.scheduleVersionId,
          entryId,
          conflict,
          commandId,
        ),
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'session.content.updated', 'session', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM schedule_session_contents
             WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?
               AND last_operation_id = ?
          )`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        session.id,
        JSON.stringify({
          revision: nextRevision,
          scheduleRevision: nextScheduleRevision,
          visibility: parsed.visibility,
        }),
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        commandId,
      ),
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'session', entity_id = ?,
                completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = 'schedule.session_content.save'
            AND idempotency_key = ? AND request_hash = ?
            AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM schedule_session_contents
               WHERE schedule_version_id = ? AND event_id = ?
                 AND session_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        JSON.stringify(result),
        session.id,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        commandId,
      ),
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = 'schedule.session_content.save'
            AND idempotency_key = ? AND request_hash = ?
            AND status = 'processing'
            AND NOT EXISTS (
              SELECT 1 FROM schedule_session_contents
               WHERE schedule_version_id = ? AND event_id = ?
                 AND session_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        commandId,
      ),
    ];
    const auditIndex = statements.length - 3;
    statements.push(...preparedWebhook.statements);
    const results = await this.env.DB.batch(statements);
    const eventUpdated = results[2]!;
    const versionUpdated = results[3]!;
    const sessionUpdated = results[4]!;
    const snapshotUpdated = results[5]!;
    const entryUpdated = scheduledEntry ? results[6]! : null;
    if (
      (eventUpdated.meta.changes ?? 0) !== 1 ||
      (versionUpdated.meta.changes ?? 0) !== 1 ||
      (sessionUpdated.meta.changes ?? 0) !== 1 ||
      (snapshotUpdated.meta.changes ?? 0) !== 1 ||
      (entryUpdated && (entryUpdated.meta.changes ?? 0) !== 1) ||
      (results[auditIndex]?.meta.changes ?? 0) !== 1
    ) {
      const racedReplay = await this.replayEditorCommand(
        viewer,
        "schedule.session_content.save",
        parsed.idempotencyKey,
        requestHash,
        parseResult,
      );
      if (racedReplay) return racedReplay;
      throw new ScheduleRevisionConflictError();
    }
    const completed = await this.replayEditorCommand(
      viewer,
      "schedule.session_content.save",
      parsed.idempotencyKey,
      requestHash,
      parseResult,
    );
    if (!completed)
      throw new Error("The session-content save did not record its result.");
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return completed;
  }

  async updateScheduleNotes(viewer: Viewer, input: unknown) {
    const parsed = scheduleNotesSchema.parse(input);
    const requestHash = await airtableCommandKey(
      "schedule.notes.save.request",
      viewer,
      { ...parsed, idempotencyKey: undefined },
    );
    return this.projectCommand(
      viewer,
      "schedule.notes.save",
      parsed,
      () => this.updateScheduleNotesD1(viewer, parsed, requestHash),
      {
        idempotencyKey: `airtable:${viewer.eventId}:schedule.notes.save:actor:${viewer.personId}:${parsed.idempotencyKey}`,
        requestHash,
      },
    );
  }

  private async updateScheduleNotesD1(
    viewer: Viewer,
    parsed: ReturnType<typeof scheduleNotesSchema.parse>,
    requestHash: string,
  ) {
    type Result = { scheduleVersionId: string; scheduleRevision: number };
    const parseResult = (value: unknown): Result => {
      if (!value || typeof value !== "object")
        throw new Error("The saved schedule-notes response is invalid.");
      const result = value as Partial<Result>;
      if (
        typeof result.scheduleVersionId !== "string" ||
        !Number.isSafeInteger(result.scheduleRevision)
      ) {
        throw new Error("The saved schedule-notes response is invalid.");
      }
      return result as Result;
    };
    const replay = await this.replayEditorCommand(
      viewer,
      "schedule.notes.save",
      parsed.idempotencyKey,
      requestHash,
      parseResult,
    );
    if (replay) return replay;
    const workspace = await this.getWorkspace(viewer);
    if (
      !workspace.version ||
      workspace.version.id !== parsed.scheduleVersionId ||
      workspace.version.status !== "draft"
    ) {
      throw new ScheduleNotFoundError(
        "Schedule notes can only be edited on an active draft.",
      );
    }
    if (workspace.version.revision !== parsed.scheduleRevision)
      throw new ScheduleRevisionConflictError();

    const commandId = crypto.randomUUID();
    const result: Result = {
      scheduleVersionId: parsed.scheduleVersionId,
      scheduleRevision: parsed.scheduleRevision + 1,
    };
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = 'schedule.notes.save' AND idempotency_key = ?
            AND expires_at <= unixepoch()`,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, 'schedule.notes.save', ?, ?, 'processing',
                   unixepoch() + 604800, unixepoch())`,
      ).bind(
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
      ),
      this.env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1, last_operation_id = ?,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM idempotency_records command
               WHERE command.id = ? AND command.organisation_id = ?
                 AND command.event_id = ? AND command.actor_id = ?
                 AND command.scope = 'schedule.notes.save'
                 AND command.idempotency_key = ?
                 AND command.request_hash = ? AND command.status = 'processing'
            )`,
      ).bind(
        commandId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        workspace.event.revision,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_versions
            SET notes = ?, revision = revision + 1,
                publication_operation_id = ?
          WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        parsed.notes,
        commandId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        viewer.eventId,
        viewer.organisationId,
        commandId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'schedule.notes.updated', 'schedule_version', ?, ?,
                unixepoch()
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
        JSON.stringify({ scheduleRevision: result.scheduleRevision }),
        parsed.scheduleVersionId,
        viewer.eventId,
        commandId,
      ),
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'schedule_version',
                entity_id = ?, completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = 'schedule.notes.save'
            AND idempotency_key = ? AND request_hash = ?
            AND status = 'processing'
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
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        commandId,
      ),
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = 'schedule.notes.save'
            AND idempotency_key = ? AND request_hash = ?
            AND status = 'processing'
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
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        commandId,
      ),
    ]);
    if (
      (results[2]!.meta.changes ?? 0) !== 1 ||
      (results[3]!.meta.changes ?? 0) !== 1
    ) {
      const racedReplay = await this.replayEditorCommand(
        viewer,
        "schedule.notes.save",
        parsed.idempotencyKey,
        requestHash,
        parseResult,
      );
      if (racedReplay) return racedReplay;
      throw new ScheduleRevisionConflictError();
    }
    const completed = await this.replayEditorCommand(
      viewer,
      "schedule.notes.save",
      parsed.idempotencyKey,
      requestHash,
      parseResult,
    );
    if (!completed)
      throw new Error("The schedule-notes save did not record its result.");
    return completed;
  }

  async updatePolicies(viewer: Viewer, input: unknown) {
    return this.projectCommand(viewer, "schedule.policies.update", input, () =>
      this.updatePoliciesD1(viewer, input),
    );
  }

  private async updatePoliciesD1(viewer: Viewer, input: unknown) {
    const parsed = schedulePolicySchema.parse(input);
    const workspace = await this.getWorkspace(viewer);
    if (workspace.policyRevision !== parsed.revision)
      throw new ScheduleRevisionConflictError();
    const operationId = crypto.randomUUID();
    const versionGuard = workspace.version
      ? `EXISTS (
           SELECT 1 FROM schedule_versions current_version
            WHERE current_version.id = ? AND current_version.event_id = events.id
              AND current_version.status = ? AND current_version.revision = ?
         )`
      : `NOT EXISTS (
           SELECT 1 FROM schedule_versions current_version
            WHERE current_version.event_id = events.id
              AND current_version.status IN ('draft','published')
         )`;
    const versionBindings = workspace.version
      ? [
          workspace.version.id,
          workspace.version.status,
          workspace.version.revision,
        ]
      : [];
    const nextPolicies: SchedulePolicies = {
      room: policy(parsed.roomAction),
      speaker: policy(parsed.speakerAction),
      resource: policy(parsed.resourceAction),
      track: policy(parsed.trackAction),
      boundary: policy(parsed.boundaryAction),
      capacity: policy(parsed.capacityAction),
      minimumTurnaroundMinutes: parsed.minimumTurnaroundMinutes,
    };
    const conflicts =
      workspace.version?.status === "draft"
        ? detectWorkspaceConflicts({ ...workspace, policies: nextPolicies })
        : [];
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events
           SET revision = revision + 1, last_operation_id = ?,
               last_updated_by_person_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1 FROM schedule_policies policy
              WHERE policy.event_id = events.id AND policy.revision = ?
           )
           AND ${versionGuard}
      `,
      ).bind(
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
        ...versionBindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE schedule_policies
           SET room_overlap_action = ?, speaker_overlap_action = ?,
               required_resource_overlap_action = ?,
               exclusive_track_overlap_action = ?, event_boundary_action = ?,
               capacity_action = ?, minimum_turnaround_minutes = ?,
               revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = schedule_policies.event_id AND organisation_id = ?
                AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.roomAction,
        parsed.speakerAction,
        parsed.resourceAction,
        parsed.trackAction,
        parsed.boundaryAction,
        parsed.capacityAction,
        parsed.minimumTurnaroundMinutes,
        viewer.eventId,
        parsed.revision,
        viewer.organisationId,
        operationId,
      ),
    ];
    if (workspace.version?.status === "draft") {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE schedule_versions
             SET revision = revision + 1, publication_operation_id = ?
           WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
             )
        `,
        ).bind(
          operationId,
          workspace.version.id,
          viewer.eventId,
          workspace.version.revision,
          viewer.eventId,
          viewer.organisationId,
          operationId,
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
          workspace.version.id,
          workspace.version.id,
          viewer.eventId,
          operationId,
        ),
        ...conflicts.map(({ entryId, conflict }) =>
          this.conflictInsert(
            viewer.eventId,
            workspace.version!.id,
            entryId,
            conflict,
            operationId,
          ),
        ),
      );
    }
    const auditIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'schedule.policy.updated', 'schedule_policy', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.eventId,
        JSON.stringify(parsed),
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    );
    const results = await this.env.DB.batch(statements);
    const [eventUpdated, policyUpdated] = results;
    const draftUpdated =
      workspace.version?.status === "draft" ? results[2] : null;
    const audit = results[auditIndex];
    if (
      (eventUpdated.meta.changes ?? 0) !== 1 ||
      (policyUpdated.meta.changes ?? 0) !== 1 ||
      (draftUpdated && (draftUpdated.meta.changes ?? 0) !== 1) ||
      (audit.meta.changes ?? 0) !== 1
    ) {
      throw new ScheduleRevisionConflictError();
    }
  }

  async unassign(
    viewer: Viewer,
    input: unknown,
  ): Promise<ScheduleUnassignmentResult> {
    return this.projectCommand(viewer, "schedule.entry.unassign", input, () =>
      this.unassignD1(viewer, input),
    );
  }

  private async unassignD1(
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
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'schedule.entry.unassigned', 'schedule_entry', ?, ?, unixepoch()
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

  async undo(viewer: Viewer, input: unknown): Promise<ScheduleUndoResult> {
    return this.projectCommand(viewer, "schedule.entry.undo", input, () =>
      this.undoD1(viewer, input),
    );
  }

  private async undoD1(viewer: Viewer, input: unknown) {
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

    const current = metadata.next
      ? workspace.entries.find((entry) => entry.id === metadata.next!.id)
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
          entry.id === metadata.previous!.id ||
          entry.sessionId === metadata.previous!.sessionId,
      )
    ) {
      throw new ScheduleUndoUnavailableError();
    }

    const restoredEntries = metadata.previous
      ? metadata.next
        ? workspace.entries.map((entry) =>
            entry.id === metadata.next!.id
              ? { ...metadata.previous!, revision: entry.revision + 1 }
              : entry,
          )
        : [
            ...workspace.entries,
            { ...metadata.previous, revision: metadata.previous.revision + 1 },
          ]
      : workspace.entries.filter((entry) => entry.id !== metadata.next!.id);
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
      : [metadata.previous!.id, metadata.previous!.sessionId];
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
          metadata.next!.id,
          viewer.eventId,
          parsed.scheduleVersionId,
          metadata.next!.sessionId,
          metadata.next!.roomId,
          metadata.next!.startsAt,
          metadata.next!.endsAt,
          metadata.next!.revision,
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
        (metadata.previous ?? metadata.next)!.sessionId,
        viewer.eventId,
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'schedule.entry.undo', 'schedule_entry', ?, ?, unixepoch()
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
        (metadata.previous ?? metadata.next)!.id,
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
      entryId: (metadata.previous ?? metadata.next)!.id,
      scheduleRevision: parsed.scheduleRevision + 1,
      sessionId: (metadata.previous ?? metadata.next)!.sessionId,
      restoredPlacement,
    };
  }

  async publish(
    viewer: Viewer,
    input: unknown,
  ): Promise<SchedulePublicationResult>;
  async publish(
    viewer: ScheduleEventScope,
    input: unknown,
    auditActor: ScheduleAuditActor,
    command?: SchedulePublicationCommand,
  ): Promise<SchedulePublicationResult>;
  async publish(
    viewer: ScheduleEventScope & Partial<Pick<Viewer, "personId">>,
    input: unknown,
    auditActor?: ScheduleAuditActor,
    command?: SchedulePublicationCommand,
  ) {
    const projectionKey = command
      ? {
          idempotencyKey: `airtable:${viewer.eventId}:schedule.publish:api:${command.actorId}:${command.idempotencyKey}`,
          requestHash: command.requestHash,
        }
      : undefined;
    return this.projectCommand(
      viewer,
      "schedule.publish",
      input,
      () => this.publishD1(viewer, input, auditActor, command),
      projectionKey,
    );
  }

  private async publishD1(
    viewer: ScheduleEventScope & Partial<Pick<Viewer, "personId">>,
    input: unknown,
    auditActor?: ScheduleAuditActor,
    command?: SchedulePublicationCommand,
  ) {
    const parsed = schedulePublishSchema.parse(input);
    const actor =
      auditActor ??
      (viewer.personId ? { personId: viewer.personId, actorId: null } : null);
    if (!actor)
      throw new Error("A schedule publication audit actor is required.");
    if (command) {
      if (actor.actorId !== command.actorId) {
        throw new Error(
          "The schedule idempotency actor must match the publication audit actor.",
        );
      }
      const replay = await this.replayPublication(viewer, command);
      if (replay) return replay;
    }
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (!operationsQueue) {
      throw new ScheduleConfigurationError(
        "Schedule publication requires the OPERATIONS_QUEUE binding before any publication work can begin.",
      );
    }
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
    if (!workspace.entries.length)
      throw new SchedulePublicationBlockedError(
        [],
        "Place at least one session before publishing.",
      );

    const detectedConflicts = detectWorkspaceConflicts(workspace);
    const allConflicts = detectedConflicts.map(({ conflict }) => conflict);
    const blockingConflicts = allConflicts.filter(
      (conflict) => conflict.severity === "blocking",
    );
    if (blockingConflicts.length)
      throw new SchedulePublicationBlockedError(blockingConflicts);

    if (workspace.event.repositoryProvider === "airtable") {
      await new AirtableProgrammeRepository(this.env).stagePublication(
        {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          personId: actor.personId ?? null,
        },
        parsed.scheduleVersionId,
      );
    }

    const publishOperationId = crypto.randomUUID();
    const calendarOperationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const calendarIdempotencyKey = `schedule-calendar-fanout:${parsed.scheduleVersionId}`;
    const calendarMessage: ScheduleCalendarFanoutMessage =
      scheduleCalendarFanoutMessageSchema.parse({
        type: "schedule.calendar_fanout",
        operationId: calendarOperationId,
        scheduleVersionId: parsed.scheduleVersionId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        idempotencyKey: calendarIdempotencyKey,
      });
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: actor.personId ?? null,
        actorId: actor.actorId ?? undefined,
      },
      {
        eventType: "schedule.published",
        entityType: "schedule_version",
        entityId: parsed.scheduleVersionId,
        idempotencyKey: `schedule.published:${parsed.scheduleVersionId}`,
        correlationId: publishOperationId,
        data: {
          scheduleVersionId: parsed.scheduleVersionId,
          calendarOperationId,
        },
      },
      auditEventId,
    );
    const { statements, publishingIndex, changeIndex } =
      buildSchedulePublicationStatements({
        env: this.env,
        viewer,
        actor,
        command,
        parsed,
        workspace,
        detectedConflicts,
        publishOperationId,
        calendarOperationId,
        calendarIdempotencyKey,
        calendarMessage,
        auditEventId,
        conflictInsert: (entryId, conflict, operationId) =>
          this.conflictInsert(
            viewer.eventId,
            parsed.scheduleVersionId,
            entryId,
            conflict,
            operationId,
          ),
      });
    statements.push(...preparedWebhook.statements);
    const results = await this.env.DB.batch(statements);
    const publishing = results[publishingIndex];
    if ((publishing?.meta.changes ?? 0) !== 1) {
      if (command) {
        const replay = await this.replayPublication(viewer, command);
        if (replay) return replay;
      }
      throw new ScheduleRevisionConflictError();
    }
    const change = results[changeIndex]?.results?.[0] as
      { sequence?: number } | undefined;
    if (!Number.isSafeInteger(change?.sequence)) {
      throw new Error(
        "Schedule publication committed without an event change cursor.",
      );
    }
    const changeSequence = Number(change!.sequence);

    let calendar: SchedulePublicationResult["calendar"];
    try {
      await operationsQueue.send(calendarMessage);
      calendar = {
        operationId: calendarOperationId,
        status: "queued",
        dispatchError: null,
      };
    } catch (error) {
      const dispatchError = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 2_000);
      await this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND type = 'schedule.calendar_fanout' AND status = 'queued'`,
      )
        .bind(dispatchError, calendarOperationId, viewer.eventId)
        .run();
      calendar = {
        operationId: calendarOperationId,
        status: "queue_failed",
        dispatchError,
      };
    }
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return {
      published: true,
      scheduleVersionId: parsed.scheduleVersionId,
      changeSequence,
      calendar,
    };
  }

  private conflictInsert(
    eventId: string,
    versionId: string,
    entryId: string,
    conflict: ScheduleConflict,
    operationId: string,
  ) {
    const fingerprint = conflict.conflictingEntryId
      ? `${conflict.type}:${[entryId, conflict.conflictingEntryId].sort().join(":")}`
      : `${conflict.type}:${entryId}`;
    return this.env.DB.prepare(
      `
      INSERT INTO schedule_conflicts (
        id, event_id, schedule_version_id, conflict_type, severity, fingerprint,
        primary_entry_id, conflicting_entry_id, details_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()
       WHERE EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
    `,
    ).bind(
      crypto.randomUUID(),
      eventId,
      versionId,
      conflict.type,
      conflict.severity,
      fingerprint,
      entryId,
      conflict.conflictingEntryId ?? null,
      JSON.stringify({ message: conflict.message }),
      versionId,
      operationId,
    );
  }
}
