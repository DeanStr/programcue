import { requireValue } from "~/lib/required-value";
import { AirtableProgrammeRepository } from "~/modules/airtable/airtable-programme-repository.server";
import {
  type ScheduleCalendarFanoutMessage,
  scheduleCalendarFanoutMessageSchema,
} from "~/modules/calendars/calendar-schema";
import { validatePublishedSiteReferencesForSchedule } from "~/modules/public-site/public-site-publication-validation.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { scheduleConflictInsert } from "./schedule-conflict-statement.server";
import {
  ScheduleConfigurationError,
  ScheduleIdempotencyConflictError,
  ScheduleNotFoundError,
  SchedulePublicationBlockedError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import { SchedulePublicationReadiness } from "./schedule-publication-readiness.server";
import { buildSchedulePublicationStatements } from "./schedule-publication-statements.server";
import { schedulePublishSchema } from "./schedule-schema";
import type {
  ScheduleAuditActor,
  ScheduleEventScope,
  SchedulePublicationCommand,
  SchedulePublicationResult,
  ScheduleWorkspace,
} from "./schedule-service.server";
import { detectWorkspaceConflicts } from "./schedule-workspace.server";

export class SchedulePublicationWorkflow {
  private readonly readiness: SchedulePublicationReadiness;

  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: {
      getWorkspace: (viewer: ScheduleEventScope) => Promise<ScheduleWorkspace>;
    },
  ) {
    this.readiness = new SchedulePublicationReadiness(env);
  }

  private getWorkspace(viewer: ScheduleEventScope) {
    return this.dependencies.getWorkspace(viewer);
  }

  async replayPublication(
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
  async publishD1(
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
      await this.readiness.findUnpublishablePublicScheduledContent(
        viewer,
        parsed.scheduleVersionId,
      );
    if (unpublishableContent) {
      throw new SchedulePublicationBlockedError(
        [],
        this.readiness.publicationContentError(unpublishableContent),
      );
    }

    const unconfirmedSpeaker =
      await this.readiness.findUnconfirmedScheduledSpeaker(
        viewer,
        parsed.scheduleVersionId,
      );
    if (unconfirmedSpeaker) {
      throw new SchedulePublicationBlockedError(
        [],
        unconfirmedSpeaker.participationStatus === "declined"
          ? `Every scheduled speaker must confirm their participation before publication. A participant declined “${unconfirmedSpeaker.title}”.`
          : `Every scheduled speaker must confirm their participation before publication. “${unconfirmedSpeaker.title}” still has a speaker awaiting confirmation.`,
      );
    }

    const invalidSiteReference =
      await validatePublishedSiteReferencesForSchedule(this.env, {
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        scheduleVersionId: parsed.scheduleVersionId,
      });
    if (invalidSiteReference) {
      throw new SchedulePublicationBlockedError([], invalidSiteReference);
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
          scheduleConflictInsert(
            this.env,
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
        await this.readiness.hasMissingScheduledContentSnapshot(
          viewer,
          parsed.scheduleVersionId,
        )
      ) {
        throw new ScheduleConfigurationError(
          "The active schedule version is missing one or more required frozen session-content snapshots.",
        );
      }
      const newlyUnpublishableContent =
        await this.readiness.findUnpublishablePublicScheduledContent(
          viewer,
          parsed.scheduleVersionId,
        );
      if (newlyUnpublishableContent) {
        throw new SchedulePublicationBlockedError(
          [],
          this.readiness.publicationContentError(newlyUnpublishableContent),
        );
      }
      const newlyUnconfirmedSpeaker =
        await this.readiness.findUnconfirmedScheduledSpeaker(
          viewer,
          parsed.scheduleVersionId,
        );
      if (newlyUnconfirmedSpeaker) {
        throw new SchedulePublicationBlockedError(
          [],
          newlyUnconfirmedSpeaker.participationStatus === "declined"
            ? `Every scheduled speaker must confirm their participation before publication. A participant declined “${newlyUnconfirmedSpeaker.title}”.`
            : `Every scheduled speaker must confirm their participation before publication. “${newlyUnconfirmedSpeaker.title}” still has a speaker awaiting confirmation.`,
        );
      }
      const newlyInvalidSiteReference =
        await validatePublishedSiteReferencesForSchedule(this.env, {
          eventId: viewer.eventId,
          organisationId: viewer.organisationId,
          scheduleVersionId: parsed.scheduleVersionId,
        });
      if (newlyInvalidSiteReference) {
        throw new SchedulePublicationBlockedError(
          [],
          newlyInvalidSiteReference,
        );
      }
      throw new ScheduleRevisionConflictError();
    }
    const change = results[changeIndex]?.results?.[0] as
      | { sequence?: number }
      | undefined;
    if (!Number.isSafeInteger(change?.sequence)) {
      throw new Error(
        "Schedule publication committed without an event change cursor.",
      );
    }
    const changeSequence = Number(
      requireValue(change, "Required change is unavailable.").sequence,
    );

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
}
