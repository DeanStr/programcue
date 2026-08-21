import {
  AirtableProviderBoundary,
  airtableCommandKey,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import type { AuditOrigin } from "~/platform/audit/audit-contract";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  WebhookService,
  webhookActorForAudit,
} from "~/platform/operations/webhook-service.server";
import {
  type AutoPlacementPreview,
  autoPlacementRequestHash,
} from "./schedule-auto-placement";
import { ScheduleAutoPlacementWorkflow } from "./schedule-auto-placement-workflow.server";
import { ScheduleBreakWorkflow } from "./schedule-break-workflow.server";
import { ScheduleContentWorkflow } from "./schedule-content-workflow.server";
import { ScheduleDraftWorkflow } from "./schedule-draft-workflow.server";
import { ScheduleConfigurationError } from "./schedule-errors";
import { SchedulePlacementWorkflow } from "./schedule-placement-workflow.server";
import { SchedulePublicationWorkflow } from "./schedule-publication-workflow.server";
import { ScheduleReviewLinkService } from "./schedule-review-link-service.server";
import type {
  ScheduleConflict,
  SchedulePolicies,
  SpeakerBlackoutWindow,
} from "./schedule-rules";
import {
  scheduleAutoPlacementConfirmSchema,
  scheduleNotesSchema,
  scheduleSessionContentSchema,
} from "./schedule-schema";
import { loadScheduleWorkspaceD1 } from "./schedule-workspace.server";

export type ScheduleActionOrigin = Extract<AuditOrigin, "admin_ui" | "api">;

export type WorkspaceEvent = {
  id: string;
  name: string;
  publicSlug: string;
  programmePublishedAt: number | null;
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
  /** A private or unpublished linked speaker blocks deterministic placement
   * until the session can be represented in the public programme. */
  hasUnpublishedSpeaker: boolean;
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
  tracks: Array<{
    id: string;
    name: string;
    exclusive: boolean;
    isPublic: boolean;
  }>;
  sessionFormats: Array<{
    key: string;
    label: string;
    defaultDurationMinutes: number;
    position: number;
  }>;
  sessions: ScheduleSession[];
  entries: ScheduleEntry[];
  speakerBlackouts: SpeakerBlackoutWindow[];
  conflicts: Array<{
    id: string;
    type: string;
    severity: string;
    message: string;
  }>;
  publicationConflicts: Array<ScheduleConflict & { entryIds: string[] }>;
  policies: SchedulePolicies;
  policyRevision: number;
};

export {
  ScheduleConfigurationError,
  ScheduleIdempotencyConflictError,
  ScheduleNotFoundError,
  SchedulePlacementBlockedError,
  SchedulePublicationBlockedError,
  ScheduleReviewLinkExpiredError,
  ScheduleReviewLinkIntentReusedError,
  ScheduleReviewLinkLimitError,
  ScheduleReviewLinkNotFoundError,
  ScheduleRevisionConflictError,
  ScheduleUndoUnavailableError,
} from "./schedule-errors";

export type ScheduleEventScope = Pick<Viewer, "organisationId" | "eventId">;
export type ScheduleAuditActor =
  | { personId: string; actorId?: null }
  | { personId?: null; actorId: string };
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

export type SchedulePlacementWarning = Omit<ScheduleConflict, "severity"> & {
  id: string;
  severity: "warning";
};

export type SchedulePlacementSessionUpdate = Pick<
  ScheduleSession,
  "id" | "durationMinutes" | "contentStatus" | "contentRevision" | "revision"
> & {
  status: "scheduled" | "published";
};

export type SchedulePlacementResult = {
  entryId: string;
  entry: ScheduleEntry;
  /** Optional only for replaying deployed assistant command records that were
   * persisted before placement responses included a session projection. */
  session?: SchedulePlacementSessionUpdate;
  movedExistingEntry: boolean;
  scheduleRevision: number;
  warnings: SchedulePlacementWarning[];
  undo: { token: string; expiresAt: number };
};

export type ScheduleAutoPlacementResult = {
  scheduleVersionId: string;
  scheduleRevision: number;
  appliedCount: number;
  excludedCount: number;
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
  private readonly draftWorkflow: ScheduleDraftWorkflow;
  private readonly breakWorkflow: ScheduleBreakWorkflow;
  private readonly publicationWorkflow: SchedulePublicationWorkflow;
  private readonly reviewLinkService: ScheduleReviewLinkService;
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
    this.placementWorkflow = new SchedulePlacementWorkflow(this.env, {
      getWorkspace: (viewer: ScheduleEventScope) =>
        this.getWorkspace(viewer, { includePublicationConflicts: false }),
    });
    this.draftWorkflow = new ScheduleDraftWorkflow(
      this.env,
      workflowDependencies,
    );
    this.breakWorkflow = new ScheduleBreakWorkflow(
      this.env,
      workflowDependencies,
    );
    this.publicationWorkflow = new SchedulePublicationWorkflow(
      this.env,
      workflowDependencies,
    );
    this.reviewLinkService = new ScheduleReviewLinkService(
      this.env,
      workflowDependencies,
    );
  }

  private async queueSessionWebhook(
    viewer: Viewer,
    origin: ScheduleActionOrigin,
    input: {
      eventType: "session.created" | "session.updated";
      sessionId: string;
      revision: number;
      data: Record<string, unknown>;
    },
  ) {
    try {
      const deliveries = await new WebhookService(this.env).queueEvent(
        webhookActorForAudit(viewer, origin),
        {
          eventType: input.eventType,
          entityType: "session",
          entityId: input.sessionId,
          idempotencyKey: `${input.eventType}:${input.sessionId}:${input.revision}`,
          correlationId: `${input.sessionId}:${input.revision}`,
          data: input.data,
        },
      );
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

  async getWorkspace(
    viewer: ScheduleEventScope,
    options: { includePublicationConflicts?: boolean } = {},
  ): Promise<ScheduleWorkspace> {
    if (this.projectionDepth === 0) await this.airtable.assertReadable(viewer);
    return loadScheduleWorkspaceD1(this.env, viewer, options);
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
      () => this.draftWorkflow.createDraftD1(viewer),
    );
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
      () => this.breakWorkflow.createBreakD1(viewer, input),
    );
    const webhook = await this.queueSessionWebhook(viewer, "admin_ui", {
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

  async updateSessionResources(viewer: Viewer, input: unknown) {
    const result = await this.projectCommand(
      viewer,
      "schedule.session_resources.update",
      input,
      () => this.contentWorkflow.updateSessionResourcesD1(viewer, input),
    );
    const webhook = await this.queueSessionWebhook(viewer, "admin_ui", {
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
    origin: ScheduleActionOrigin,
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
          origin,
        ),
      { idempotencyKey: projectionKey, requestHash },
    );
    const webhook = await this.queueSessionWebhook(viewer, origin, {
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

  async updateSessionContent(
    viewer: Viewer,
    input: unknown,
    origin: ScheduleActionOrigin,
  ) {
    return this.commitSessionContent(viewer, input, origin, {
      changeKind: "edit",
      restoredFromRevisionId: null,
    });
  }

  async restoreSessionContent(
    viewer: Viewer,
    input: unknown,
    restoredFromRevisionId: string,
    origin: ScheduleActionOrigin,
  ) {
    if (!restoredFromRevisionId.trim()) {
      throw new ScheduleConfigurationError(
        "A content revision is required for restoration.",
      );
    }
    return this.commitSessionContent(viewer, input, origin, {
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

  summarizeReviewLinks(viewer: Viewer, workspace?: ScheduleWorkspace) {
    return this.reviewLinkService.summarize(viewer, workspace);
  }

  listReviewLinks(viewer: Viewer) {
    return this.reviewLinkService.list(viewer);
  }

  createReviewLink(viewer: Viewer, input: unknown) {
    return this.reviewLinkService.create(viewer, input);
  }

  revokeReviewLink(viewer: Viewer, input: unknown) {
    return this.reviewLinkService.revoke(viewer, input);
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
      () =>
        this.publicationWorkflow.publishD1(viewer, input, auditActor, command),
      projectionKey,
    );
  }
}
