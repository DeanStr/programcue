import type { Viewer } from "~/platform/auth/authorize.server";
import {
  scheduleCalendarFanoutMessageSchema,
  type ScheduleCalendarFanoutMessage,
} from "~/modules/calendars/calendar-schema";
import { AirtableProgrammeRepository } from "~/modules/airtable/airtable-programme-repository.server";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  ScheduleConfigurationError,
  ScheduleIdempotencyConflictError,
  ScheduleNotFoundError,
  SchedulePublicationBlockedError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import { buildSchedulePublicationStatements } from "./schedule-publication-statements.server";
import { scheduleConflictInsert } from "./schedule-conflict-statement.server";
import { ScheduleContentWorkflow } from "./schedule-content-workflow.server";
import {
  autoPlacementRequestHash,
  type AutoPlacementPreview,
} from "./schedule-auto-placement";
import { ScheduleAutoPlacementWorkflow } from "./schedule-auto-placement-workflow.server";
import { SchedulePlacementWorkflow } from "./schedule-placement-workflow.server";
import {
  detectWorkspaceConflicts,
  loadScheduleWorkspaceD1,
  schedulePolicyAction,
} from "./schedule-workspace.server";
import { type ScheduleConflict, type SchedulePolicies } from "./schedule-rules";
import {
  scheduleBreakSchema,
  scheduleAutoPlacementConfirmSchema,
  scheduleNotesSchema,
  schedulePublishSchema,
  scheduleSessionContentSchema,
} from "./schedule-schema";

export type WorkspaceEvent = {
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
  sourceVisibility: "public" | "private" | "hidden";
  visibility: "public" | "private" | "hidden";
  contentStatus: "draft" | "in_review" | "approved" | "changes_requested";
  contentRevision: number;
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
    position: number;
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

export {
  ScheduleConfigurationError,
  ScheduleIdempotencyConflictError,
  ScheduleNotFoundError,
  SchedulePlacementBlockedError,
  SchedulePublicationBlockedError,
  ScheduleRevisionConflictError,
  ScheduleUndoUnavailableError,
} from "./schedule-errors";

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

export type ScheduleAutoPlacementResult = {
  scheduleVersionId: string;
  scheduleRevision: number;
  appliedCount: number;
  unplacedCount: number;
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

export class ScheduleService {
  private readonly airtable;
  private readonly contentWorkflow: ScheduleContentWorkflow;
  private readonly autoPlacementWorkflow: ScheduleAutoPlacementWorkflow;
  private readonly placementWorkflow: SchedulePlacementWorkflow;
  private projectionDepth = 0;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
    const workflowDependencies = {
      getWorkspace: (viewer: ScheduleEventScope) => this.getWorkspace(viewer),
    };
    this.contentWorkflow = new ScheduleContentWorkflow(
      this.env,
      workflowDependencies,
    );
    this.autoPlacementWorkflow = new ScheduleAutoPlacementWorkflow(
      this.env,
      workflowDependencies,
    );
    this.placementWorkflow = new SchedulePlacementWorkflow(
      this.env,
      workflowDependencies,
    );
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

  private async findUnconfirmedScheduledSpeaker(
    viewer: ScheduleEventScope,
    scheduleVersionId: string,
  ) {
    return this.env.DB.prepare(
      `SELECT session.title
         FROM schedule_entries entry
         JOIN sessions session
           ON session.id = entry.session_id AND session.event_id = entry.event_id
        WHERE entry.schedule_version_id = ? AND entry.event_id = ?
          AND (
            EXISTS (
              SELECT 1 FROM session_speakers relationship
               WHERE relationship.session_id = session.id
                 AND relationship.event_id = session.event_id
                 AND relationship.participation_status IS NOT 'confirmed'
            )
          )
        ORDER BY session.title COLLATE NOCASE, session.id
        LIMIT 1`,
    )
      .bind(scheduleVersionId, viewer.eventId)
      .first<{ title: string }>();
  }

  private async hasMissingScheduledContentSnapshot(
    viewer: ScheduleEventScope,
    scheduleVersionId: string,
  ) {
    const missing = await this.env.DB.prepare(
      `SELECT 1 AS missing
         FROM schedule_entries entry
         LEFT JOIN schedule_session_contents content
           ON content.schedule_version_id = entry.schedule_version_id
          AND content.event_id = entry.event_id
          AND content.session_id = entry.session_id
        WHERE entry.schedule_version_id = ? AND entry.event_id = ?
          AND content.session_id IS NULL
        LIMIT 1`,
    )
      .bind(scheduleVersionId, viewer.eventId)
      .first<{ missing: number }>();
    return missing?.missing === 1;
  }

  private async findUnpublishablePublicScheduledContent(
    viewer: ScheduleEventScope,
    scheduleVersionId: string,
  ) {
    return this.env.DB.prepare(
      `SELECT content.title, content.visibility,
              content.content_status AS contentStatus
         FROM schedule_entries entry
         JOIN sessions session
           ON session.id = entry.session_id
          AND session.event_id = entry.event_id
          AND session.visibility = 'public'
         JOIN schedule_session_contents content
           ON content.schedule_version_id = entry.schedule_version_id
          AND content.event_id = entry.event_id
          AND content.session_id = entry.session_id
        WHERE entry.schedule_version_id = ? AND entry.event_id = ?
          AND (
            content.visibility <> 'public'
            OR content.content_status <> 'approved'
          )
        ORDER BY content.title COLLATE NOCASE, content.session_id
        LIMIT 1`,
    )
      .bind(scheduleVersionId, viewer.eventId)
      .first<{
        title: string;
        visibility: string;
        contentStatus: ScheduleSession["contentStatus"];
      }>();
  }

  private publicationContentError(content: {
    title: string;
    visibility: string;
    contentStatus: ScheduleSession["contentStatus"];
  }) {
    if (content.visibility !== "public") {
      return `Every public session requires a public content snapshot before publishing. “${content.title}” is ${content.visibility}.`;
    }
    return `Every public session requires an Approved content snapshot before publishing. “${content.title}” is ${content.contentStatus.replaceAll("_", " ")}.`;
  }

  async getWorkspace(viewer: ScheduleEventScope): Promise<ScheduleWorkspace> {
    if (this.projectionDepth === 0) await this.airtable.assertReadable(viewer);
    return loadScheduleWorkspaceD1(this.env, viewer);
  }

  async previewAutoPlacement(
    viewer: ScheduleEventScope,
  ): Promise<AutoPlacementPreview> {
    return this.autoPlacementWorkflow.preview(viewer);
  }

  async confirmAutoPlacement(
    viewer: Viewer,
    input: unknown,
  ): Promise<ScheduleAutoPlacementResult> {
    const parsed = scheduleAutoPlacementConfirmSchema.parse(input);
    const requestHash = await autoPlacementRequestHash(parsed);
    return this.projectCommand(
      viewer,
      "schedule.auto_place",
      parsed,
      () => this.autoPlacementWorkflow.confirmD1(viewer, parsed, requestHash),
      {
        idempotencyKey: `airtable:${viewer.eventId}:schedule.auto_place:actor:${viewer.personId}:${parsed.idempotencyKey}`,
        requestHash,
      },
    );
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
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.draft.created', 'schedule_version', ?, ?, unixepoch()
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
      () => this.placementWorkflow.placeD1(viewer, input, command),
      projectionIdentity,
    );
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
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.break.created', 'session', ?, ?, unixepoch()
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
      () => this.contentWorkflow.updateSessionResourcesD1(viewer, input),
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

  private async commitSessionContent(
    viewer: Viewer,
    input: unknown,
    history: {
      changeKind: "edit" | "restore";
      restoredFromRevisionId: string | null;
    },
  ) {
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
      () =>
        this.contentWorkflow.updateSessionContentD1(
          viewer,
          parsed,
          requestHash,
          history,
        ),
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

  async updateSessionContent(viewer: Viewer, input: unknown) {
    return this.commitSessionContent(viewer, input, {
      changeKind: "edit",
      restoredFromRevisionId: null,
    });
  }

  async restoreSessionContent(
    viewer: Viewer,
    input: unknown,
    restoredFromRevisionId: string,
  ) {
    if (!restoredFromRevisionId.trim()) {
      throw new ScheduleConfigurationError(
        "A content revision is required for restoration.",
      );
    }
    return this.commitSessionContent(viewer, input, {
      changeKind: "restore",
      restoredFromRevisionId,
    });
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
      () =>
        this.contentWorkflow.updateScheduleNotesD1(viewer, parsed, requestHash),
      {
        idempotencyKey: `airtable:${viewer.eventId}:schedule.notes.save:actor:${viewer.personId}:${parsed.idempotencyKey}`,
        requestHash,
      },
    );
  }

  async updatePolicies(viewer: Viewer, input: unknown) {
    return this.projectCommand(viewer, "schedule.policies.update", input, () =>
      this.contentWorkflow.updatePoliciesD1(viewer, input),
    );
  }

  async unassign(
    viewer: Viewer,
    input: unknown,
  ): Promise<ScheduleUnassignmentResult> {
    return this.projectCommand(viewer, "schedule.entry.unassign", input, () =>
      this.placementWorkflow.unassignD1(viewer, input),
    );
  }

  async undo(viewer: Viewer, input: unknown): Promise<ScheduleUndoResult> {
    return this.projectCommand(viewer, "schedule.entry.undo", input, () =>
      this.placementWorkflow.undoD1(viewer, input),
    );
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

    const unpublishableContent =
      await this.findUnpublishablePublicScheduledContent(
        viewer,
        parsed.scheduleVersionId,
      );
    if (unpublishableContent) {
      throw new SchedulePublicationBlockedError(
        [],
        this.publicationContentError(unpublishableContent),
      );
    }

    const unconfirmedSpeaker = await this.findUnconfirmedScheduledSpeaker(
      viewer,
      parsed.scheduleVersionId,
    );
    if (unconfirmedSpeaker) {
      throw new SchedulePublicationBlockedError(
        [],
        `Every scheduled speaker must confirm their participation before publication. “${unconfirmedSpeaker.title}” still has an unconfirmed speaker.`,
      );
    }

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
      if (
        await this.hasMissingScheduledContentSnapshot(
          viewer,
          parsed.scheduleVersionId,
        )
      ) {
        throw new ScheduleConfigurationError(
          "The active schedule version is missing one or more required frozen session-content snapshots.",
        );
      }
      const newlyUnpublishableContent =
        await this.findUnpublishablePublicScheduledContent(
          viewer,
          parsed.scheduleVersionId,
        );
      if (newlyUnpublishableContent) {
        throw new SchedulePublicationBlockedError(
          [],
          this.publicationContentError(newlyUnpublishableContent),
        );
      }
      const newlyUnconfirmedSpeaker =
        await this.findUnconfirmedScheduledSpeaker(
          viewer,
          parsed.scheduleVersionId,
        );
      if (newlyUnconfirmedSpeaker) {
        throw new SchedulePublicationBlockedError(
          [],
          `Every scheduled speaker must confirm their participation before publication. “${newlyUnconfirmedSpeaker.title}” still has an unconfirmed speaker.`,
        );
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
    return scheduleConflictInsert(
      this.env,
      eventId,
      versionId,
      entryId,
      conflict,
      operationId,
    );
  }
}
