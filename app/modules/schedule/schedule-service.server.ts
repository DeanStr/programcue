import type { Viewer } from "~/platform/auth/authorize.server";
import {
  scheduleCalendarFanoutMessageSchema,
  type ScheduleCalendarFanoutMessage,
} from "~/modules/calendars/calendar-schema";
import { scheduleCalendarFanoutSnapshotStatements } from "~/modules/calendars/calendar-service.server";
import {
  detectScheduleConflicts,
  type ScheduleConflict,
  type SchedulePolicies,
  type ScheduledItem,
} from "./schedule-rules";
import {
  schedulePlacementSchema,
  schedulePublishSchema,
} from "./schedule-schema";

type WorkspaceEvent = {
  id: string;
  name: string;
  startsAt: number;
  endsAt: number;
  timezone: string;
  revision: number;
};

export type ScheduleSession = {
  id: string;
  title: string;
  slug: string;
  trackId: string | null;
  trackName: string | null;
  trackExclusive: boolean;
  format: string;
  durationMinutes: number;
  expectedAttendance: number | null;
  speakerIds: string[];
  speakerNames: string[];
  status: string;
};

export type ScheduleEntry = {
  id: string;
  sessionId: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
  revision: number;
};

export type ScheduleWorkspace = {
  event: WorkspaceEvent;
  version: {
    id: string;
    versionNumber: number;
    status: string;
    revision: number;
  } | null;
  rooms: Array<{ id: string; name: string; capacity: number }>;
  tracks: Array<{ id: string; name: string }>;
  sessions: ScheduleSession[];
  entries: ScheduleEntry[];
  conflicts: Array<{
    id: string;
    type: string;
    severity: string;
    message: string;
  }>;
  policies: SchedulePolicies;
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

function policy(value: string): SchedulePolicies[keyof SchedulePolicies] {
  if (value === "allow") return "ignore";
  return value === "warn" ? "warn" : "block";
}

export class ScheduleService {
  constructor(private readonly env: CloudflareEnvironment) {}

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

  async getWorkspace(viewer: ScheduleEventScope): Promise<ScheduleWorkspace> {
    const event = await this.env.DB.prepare(
      `
      SELECT e.id, e.name, e.starts_at AS startsAt, e.ends_at AS endsAt,
             e.timezone, e.revision
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
        SELECT id, version_number AS versionNumber, status, revision
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
        }>(),
      this.env.DB.prepare(
        "SELECT id, name, capacity FROM rooms WHERE event_id = ? AND status = 'active' ORDER BY position, name",
      )
        .bind(viewer.eventId)
        .all<{ id: string; name: string; capacity: number }>(),
      this.env.DB.prepare(
        "SELECT id, name FROM tracks WHERE event_id = ? ORDER BY position, name",
      )
        .bind(viewer.eventId)
        .all<{ id: string; name: string }>(),
      this.env.DB.prepare(
        `
        SELECT s.id, s.title, s.slug, s.track_id AS trackId, t.name AS trackName,
               COALESCE(t.exclusive, 0) AS trackExclusive,
               s.format, s.duration_minutes AS durationMinutes,
               s.expected_attendance AS expectedAttendance, s.status,
               GROUP_CONCAT(ss.person_id, '||') AS speakerIds,
               GROUP_CONCAT(p.display_name, '||') AS speakerNames
          FROM sessions s
          LEFT JOIN tracks t ON t.id = s.track_id AND t.event_id = s.event_id
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
            "speakerIds" | "speakerNames" | "trackExclusive"
          > & {
            trackExclusive: number;
            speakerIds: string | null;
            speakerNames: string | null;
          }
        >(),
      this.env.DB.prepare(
        `
        SELECT room_overlap_action AS roomAction, speaker_overlap_action AS speakerAction,
               exclusive_track_overlap_action AS trackAction, capacity_action AS capacityAction
          FROM schedule_policies WHERE event_id = ?
      `,
      )
        .bind(viewer.eventId)
        .first<{
          roomAction: string;
          speakerAction: string;
          trackAction: string;
          capacityAction: string;
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

    return {
      event,
      version: currentVersion,
      rooms: rooms.results,
      tracks: tracks.results,
      sessions: sessions.results.map((session) => ({
        ...session,
        trackExclusive: Boolean(session.trackExclusive),
        speakerIds: session.speakerIds ? session.speakerIds.split("||") : [],
        speakerNames: session.speakerNames
          ? session.speakerNames.split("||")
          : [],
      })),
      entries: entries.results,
      conflicts: conflicts.results,
      policies: {
        room: policy(policyRow.roomAction),
        speaker: policy(policyRow.speakerAction),
        track: policy(policyRow.trackAction),
        capacity: policy(policyRow.capacityAction),
      },
    };
  }

  async createDraft(viewer: Viewer) {
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
          id, event_id, version_number, name, status, revision,
          publication_operation_id, created_by_person_id, created_at
        )
        SELECT ?, ?, ?, ?, 'draft', 1, ?, ?, unixepoch()
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

  async place(viewer: Viewer, input: unknown) {
    const parsed = schedulePlacementSchema.parse(input);
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
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE schedule_versions
           SET revision = revision + 1, publication_operation_id = ?
         WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM sessions placeable_session
              WHERE placeable_session.id = ?
                AND placeable_session.event_id = schedule_versions.event_id
                AND placeable_session.status IN ('unscheduled','scheduled','published')
           )
      `,
      ).bind(
        versionOperationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        parsed.sessionId,
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
          sessionId: parsed.sessionId,
          roomId: parsed.roomId,
          startsAt: parsed.startsAt,
          endsAt: parsed.endsAt,
        }),
        parsed.scheduleVersionId,
        versionOperationId,
      ),
    ];
    const [update] = await this.env.DB.batch(statements);
    if ((update.meta.changes ?? 0) !== 1)
      throw new ScheduleRevisionConflictError();
    return { entryId, warnings: conflicts };
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

    const publishOperationId = crypto.randomUUID();
    const calendarOperationId = crypto.randomUUID();
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
        this.env.DB.prepare(
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
        this.env.DB.prepare(
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
      this.env.DB.prepare(
        `
        UPDATE schedule_versions
           SET status = 'publishing', revision = revision + 1, publication_operation_id = ?
         WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND revision = ?
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
        ...commandGuardBindings,
      ),
      this.env.DB.prepare(
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
      this.env.DB.prepare(
        `
        UPDATE schedule_versions
           SET status = 'published', published_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'publishing' AND publication_operation_id = ?
      `,
      ).bind(parsed.scheduleVersionId, viewer.eventId, publishOperationId),
      this.env.DB.prepare(
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
      this.env.DB.prepare(
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
        this.conflictInsert(
          viewer.eventId,
          parsed.scheduleVersionId,
          entryId,
          conflict,
          publishOperationId,
        ),
      ),
      this.env.DB.prepare(
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
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'schedule.published', 'schedule_version', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        actor.personId ?? null,
        actor.actorId ?? null,
        parsed.scheduleVersionId,
        JSON.stringify({ entryCount: workspace.entries.length }),
        parsed.scheduleVersionId,
        publishOperationId,
      ),
      this.env.DB.prepare(
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
        this.env,
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
      this.env.DB.prepare(
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
        this.env.DB.prepare(
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
        this.env.DB.prepare(
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
      if (!this.env.OPERATIONS_QUEUE)
        throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
      await this.env.OPERATIONS_QUEUE.send(calendarMessage);
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
