import { data } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/schedule-planner";
import {
  generateInvitationIcs,
  stableCalendarUid,
} from "~/modules/calendars/ics.server";
import {
  ScheduleConfigurationError,
  ScheduleIdempotencyConflictError,
  ScheduleNotFoundError,
  SchedulePlacementBlockedError,
  SchedulePublicationBlockedError,
  ScheduleRevisionConflictError,
  ScheduleService,
  ScheduleUndoUnavailableError,
} from "~/modules/schedule/schedule-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  notifyRouteChange,
  recordRouteChange,
} from "~/platform/realtime/route-realtime.server";

async function queueScheduleWebhook(
  env: CloudflareEnvironment,
  viewer: Awaited<ReturnType<typeof requireCurrentEventRole>>,
  input: {
    eventType: "schedule.published";
    entityType: string;
    entityId: string;
    idempotencyKey: string;
    data: Record<string, unknown>;
  },
) {
  try {
    const deliveries = await new WebhookService(env).queueEvent(viewer, {
      ...input,
      correlationId: crypto.randomUUID(),
    });
    return {
      deliveries,
      warning: deliveries.some((delivery) => delivery.status === "queue_failed")
        ? "One or more outbound webhook deliveries require retry."
        : null,
    };
  } catch {
    return {
      deliveries: [],
      warning: "The outbound webhook event could not be recorded.",
    };
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const service = new ScheduleService(env);
  const workspace = await service.getWorkspace(viewer);
  const calendarPreviews = Object.fromEntries(
    workspace.entries.map((entry) => {
      const session = workspace.sessions.find(
        (candidate) => candidate.id === entry.sessionId,
      );
      const room = workspace.rooms.find(
        (candidate) => candidate.id === entry.roomId,
      );
      if (!session || !room) {
        throw new ScheduleConfigurationError(
          `Schedule entry ${entry.id} cannot be rendered as calendar content.`,
        );
      }
      const payload = {
        uid: stableCalendarUid(workspace.event.id, session.id, "preview"),
        sequence: 0,
        method: "REQUEST" as const,
        title: session.title,
        description: session.description,
        location: room.name,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        organizerName: workspace.event.name,
        organizerEmail: "calendar@programcue.invalid",
        attendeeName: "Preview attendee",
        attendeeEmail: "preview@programcue.invalid",
      };
      return [session.id, { payload, ics: generateInvitationIcs(payload) }];
    }),
  );
  const searchParams = new URL(request.url).searchParams;
  const requestedFilter = searchParams.get("filter");
  const activeFilter =
    requestedFilter === "unscheduled" ||
    requestedFilter === "conflicts" ||
    requestedFilter === "draft"
      ? requestedFilter
      : null;
  const scheduledIds = new Set(
    workspace.entries.map((entry) => entry.sessionId),
  );
  let filteredSessionIds: string[] = [];
  if (activeFilter === "unscheduled") {
    filteredSessionIds = workspace.sessions
      .filter((session) => !scheduledIds.has(session.id))
      .map((session) => session.id);
  } else if (activeFilter === "draft") {
    filteredSessionIds =
      workspace.version?.status === "draft" ? [...scheduledIds] : [];
  } else if (activeFilter === "conflicts" && workspace.version) {
    filteredSessionIds = await service.getConflictedSessionIds(
      viewer,
      workspace.version.id,
    );
  }
  const requestedSessionId = searchParams.get("session");
  const focusedSessionId = workspace.sessions.some(
    (session) => session.id === requestedSessionId,
  )
    ? requestedSessionId
    : null;
  const requestedConflictId = searchParams.get("conflict")?.trim() ?? "";
  if (requestedConflictId.length > 200)
    throw new Response("Invalid schedule conflict focus", { status: 400 });
  if (
    requestedConflictId &&
    !workspace.conflicts.some((conflict) => conflict.id === requestedConflictId)
  )
    throw new Response("Schedule conflict not found in this event", {
      status: 404,
    });
  return {
    ...workspace,
    activeFilter,
    filteredSessionIds,
    focusedSessionId,
    focusedConflictId: requestedConflictId || null,
    recoveryScope: { eventId: viewer.eventId, personId: viewer.personId },
    intentId: crypto.randomUUID(),
    calendarPreviews,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const values = await request.formData();
  const service = new ScheduleService(env);
  const intent = String(values.get("intent") ?? "");
  const autoPlacementIntent =
    intent === "auto-place-preview" || intent === "auto-place-confirm"
      ? intent
      : null;
  try {
    switch (intent) {
      case "create-draft": {
        const scheduleVersionId = await service.createDraft(
          viewer,
          String(values.get("intentId") ?? ""),
        );
        const realtimeFailure = await recordRouteChange(env, viewer, {
          entityType: "schedule_version",
          entityId: scheduleVersionId,
          changeType: "created",
        });
        if (realtimeFailure) return data(realtimeFailure, { status: 207 });
        return { ok: true, scheduleVersionId };
      }
      case "auto-place-preview": {
        const preview = await service.previewAutoPlacement(viewer);
        return {
          ok: true,
          intent,
          autoPreview: preview,
        };
      }
      case "auto-place-confirm": {
        const serializedProposal = values.get("proposal");
        let proposal: unknown;
        try {
          proposal = JSON.parse(String(serializedProposal ?? ""));
        } catch {
          return data(
            {
              ok: false,
              intent,
              error:
                "The auto-place preview is invalid. Prepare a fresh preview.",
            },
            { status: 422 },
          );
        }
        const result = await service.confirmAutoPlacement(viewer, proposal);
        const realtimeFailure = await recordRouteChange(env, viewer, {
          entityType: "schedule_version",
          entityId: result.scheduleVersionId,
          changeType: "updated",
        });
        const response = {
          ok: !realtimeFailure,
          committed: true,
          intent,
          message: `Auto-place applied ${result.appliedCount} placement${result.appliedCount === 1 ? "" : "s"}. The schedule remains a draft and was not published.`,
          appliedCount: result.appliedCount,
          unplacedCount: result.unplacedCount,
          scheduleRevision: result.scheduleRevision,
          warning: realtimeFailure?.message ?? null,
        };
        return data(response, realtimeFailure ? { status: 207 } : undefined);
      }
      case "place": {
        const result = await service.place(viewer, {
          scheduleVersionId: values.get("scheduleVersionId"),
          scheduleRevision: values.get("scheduleRevision"),
          sessionId: values.get("sessionId"),
          roomId: values.get("roomId"),
          startsAt: values.get("startsAt"),
          endsAt: values.get("endsAt"),
        });
        const realtimeFailure = await recordRouteChange(env, viewer, {
          entityType: "schedule_entry",
          entityId: result.entryId,
          changeType: "updated",
        });
        if (realtimeFailure)
          return data(
            {
              ...realtimeFailure,
              committed: true,
              warnings: result.warnings,
              scheduleRevision: result.scheduleRevision,
              undo: result.undo,
            },
            { status: 207 },
          );
        return {
          ok: true,
          message: result.warnings.length
            ? `Session placed with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}.`
            : "Session placed.",
          warnings: result.warnings,
          scheduleRevision: result.scheduleRevision,
          undo: result.undo,
        };
      }
      case "unassign": {
        const result = await service.unassign(viewer, {
          scheduleVersionId: values.get("scheduleVersionId"),
          scheduleRevision: values.get("scheduleRevision"),
          entryId: values.get("entryId"),
        });
        const realtimeFailure = await recordRouteChange(env, viewer, {
          entityType: "schedule_entry",
          entityId: result.entryId,
          changeType: "deleted",
        });
        if (realtimeFailure)
          return data(
            {
              ...realtimeFailure,
              committed: true,
              scheduleRevision: result.scheduleRevision,
              undo: result.undo,
            },
            { status: 207 },
          );
        return {
          ok: true,
          message: "Session returned to the unscheduled list.",
          scheduleRevision: result.scheduleRevision,
          undo: result.undo,
        };
      }
      case "undo": {
        const result = await service.undo(viewer, {
          scheduleVersionId: values.get("scheduleVersionId"),
          scheduleRevision: values.get("scheduleRevision"),
          undoToken: values.get("undoToken"),
        });
        const realtimeFailure = await recordRouteChange(env, viewer, {
          entityType: "schedule_entry",
          entityId: result.entryId,
          changeType: "updated",
        });
        if (realtimeFailure)
          return data(
            {
              ...realtimeFailure,
              committed: true,
              scheduleRevision: result.scheduleRevision,
              sessionId: result.sessionId,
              restoredPlacement: result.restoredPlacement,
            },
            { status: 207 },
          );
        return {
          ok: true,
          message: "Schedule change undone.",
          scheduleRevision: result.scheduleRevision,
          sessionId: result.sessionId,
          restoredPlacement: result.restoredPlacement,
        };
      }
      case "create-break": {
        const result = await service.createBreak(viewer, {
          title: values.get("title"),
          durationMinutes: values.get("durationMinutes"),
          requiredResources: values.getAll("requiredResource").map(String),
        });
        const realtimeFailure = await recordRouteChange(env, viewer, {
          entityType: "session",
          entityId: result.sessionId,
          changeType: "created",
        });
        if (realtimeFailure || result.webhookWarning)
          return data(
            {
              ok: false,
              committed: true,
              error: `Break created.${realtimeFailure ? ` ${realtimeFailure.message}` : ""}${result.webhookWarning ? ` ${result.webhookWarning}` : ""}`,
              webhookDeliveries: result.webhookDeliveries,
            },
            { status: 207 },
          );
        return {
          ok: true,
          message: "Break created and ready to place.",
          webhookDeliveries: result.webhookDeliveries,
        };
      }
      case "update-policies": {
        await service.updatePolicies(viewer, {
          revision: values.get("revision"),
          roomAction: values.get("roomAction"),
          speakerAction: values.get("speakerAction"),
          resourceAction: values.get("resourceAction"),
          trackAction: values.get("trackAction"),
          boundaryAction: values.get("boundaryAction"),
          capacityAction: values.get("capacityAction"),
          minimumTurnaroundMinutes: values.get("minimumTurnaroundMinutes"),
        });
        const realtimeFailure = await recordRouteChange(env, viewer, {
          entityType: "schedule_policy",
          entityId: viewer.eventId,
          changeType: "updated",
        });
        if (realtimeFailure) return data(realtimeFailure, { status: 207 });
        return { ok: true, message: "Schedule policies updated." };
      }
      case "update-session-resources": {
        const result = await service.updateSessionResources(viewer, {
          scheduleVersionId: values.get("scheduleVersionId"),
          scheduleRevision: values.get("scheduleRevision"),
          sessionId: values.get("sessionId"),
          sessionRevision: values.get("sessionRevision"),
          requiredResources: values.getAll("requiredResource").map(String),
        });
        const realtimeFailure = await recordRouteChange(env, viewer, {
          entityType: "session",
          entityId: result.sessionId,
          changeType: "updated",
        });
        if (realtimeFailure || result.webhookWarning) {
          return data(
            {
              ok: false,
              committed: true,
              error: `Session requirements updated.${realtimeFailure ? ` ${realtimeFailure.message}` : ""}${result.webhookWarning ? ` ${result.webhookWarning}` : ""}`,
              webhookDeliveries: result.webhookDeliveries,
            },
            { status: 207 },
          );
        }
        return {
          ok: true,
          message: result.warnings.length
            ? `Session requirements updated with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}.`
            : "Session requirements updated.",
          webhookDeliveries: result.webhookDeliveries,
        };
      }
      case "save-session-content": {
        const result = await service.updateSessionContent(viewer, {
          scheduleVersionId: values.get("scheduleVersionId"),
          scheduleRevision: values.get("scheduleRevision"),
          sessionId: values.get("sessionId"),
          sessionRevision: values.get("sessionRevision"),
          idempotencyKey: values.get("idempotencyKey"),
          title: values.get("title"),
          description: values.get("description"),
          format: values.get("format"),
          durationMinutes: values.get("durationMinutes"),
          trackId: values.get("trackId"),
          visibility: values.get("visibility"),
          requiredResources: values.getAll("requiredResource").map(String),
        });
        const realtimeFailure = await recordRouteChange(env, viewer, {
          entityType: "session",
          entityId: result.sessionId,
          changeType: "updated",
        });
        return data(
          {
            ok: true,
            committed: true,
            intent,
            message: result.warnings.length
              ? `Session content saved with ${result.warnings.length} schedule warning${result.warnings.length === 1 ? "" : "s"}.`
              : "Session content saved.",
            sessionId: result.sessionId,
            revision: result.revision,
            scheduleRevision: result.scheduleRevision,
            contentRevision: result.contentRevision,
            contentStatus: result.contentStatus,
            warning: result.webhookWarning ?? realtimeFailure?.message ?? null,
          },
          { status: realtimeFailure || result.webhookWarning ? 207 : 200 },
        );
      }
      case "save-schedule-notes": {
        const result = await service.updateScheduleNotes(viewer, {
          scheduleVersionId: values.get("scheduleVersionId"),
          scheduleRevision: values.get("scheduleRevision"),
          idempotencyKey: values.get("idempotencyKey"),
          notes: values.get("notes"),
        });
        const realtimeFailure = await recordRouteChange(env, viewer, {
          entityType: "schedule_version",
          entityId: result.scheduleVersionId,
          changeType: "updated",
        });
        return data(
          {
            ok: true,
            committed: true,
            intent,
            message: "Schedule notes saved.",
            scheduleVersionId: result.scheduleVersionId,
            scheduleRevision: result.scheduleRevision,
            warning: realtimeFailure?.message ?? null,
          },
          { status: realtimeFailure ? 207 : 200 },
        );
      }
      case "publish": {
        const publication = await service.publish(viewer, {
          scheduleVersionId: values.get("scheduleVersionId"),
          scheduleRevision: values.get("scheduleRevision"),
        });
        const realtimeFailure = await notifyRouteChange(
          env,
          viewer,
          publication.changeSequence,
          publication.scheduleVersionId,
        );
        const webhook = await queueScheduleWebhook(env, viewer, {
          eventType: "schedule.published",
          entityType: "schedule_version",
          entityId: publication.scheduleVersionId,
          idempotencyKey: `schedule.published:${publication.scheduleVersionId}`,
          data: {
            scheduleVersionId: publication.scheduleVersionId,
            calendarOperationId: publication.calendar.operationId,
          },
        });
        if (
          publication.calendar.dispatchError ||
          realtimeFailure ||
          webhook.warning
        ) {
          const calendarMessage = publication.calendar.dispatchError
            ? ` Calendar fan-out operation ${publication.calendar.operationId} could not be queued: ${publication.calendar.dispatchError}`
            : "";
          return data(
            {
              ok: false,
              committed: true,
              error: `Schedule published successfully.${calendarMessage}${realtimeFailure ? ` ${realtimeFailure.message}` : ""}${webhook.warning ? ` ${webhook.warning}` : ""}`,
              calendar: publication.calendar,
              webhookDeliveries: webhook.deliveries,
            },
            { status: 207 },
          );
        }
        return {
          ok: true,
          message: `Schedule published. Calendar fan-out operation ${publication.calendar.operationId} queued.`,
          calendar: publication.calendar,
          webhookDeliveries: webhook.deliveries,
        };
      }
      default:
        return data(
          { ok: false, error: "Unsupported schedule action." },
          { status: 400 },
        );
    }
  } catch (error) {
    if (error instanceof ZodError)
      return data(
        {
          ok: false,
          ...(autoPlacementIntent ? { intent: autoPlacementIntent } : {}),
          error: error.issues[0]?.message ?? "Invalid schedule change.",
        },
        { status: 422 },
      );
    if (error instanceof ScheduleRevisionConflictError) {
      if (
        intent === "save-session-content" ||
        intent === "save-schedule-notes"
      ) {
        const current = await service.getWorkspace(viewer);
        const sessionId = String(values.get("sessionId") ?? "");
        return data(
          {
            ok: false,
            intent,
            conflict: true,
            error: error.message,
            currentVersion: current.version,
            currentSession:
              intent === "save-session-content"
                ? (current.sessions.find(
                    (session) => session.id === sessionId,
                  ) ?? null)
                : null,
          },
          { status: 409 },
        );
      }
      if (intent === "auto-place-confirm") {
        return data(
          {
            ok: false,
            intent,
            conflict: true,
            error: error.message,
          },
          { status: 409 },
        );
      }
      return data({ ok: false, error: error.message }, { status: 409 });
    }
    if (error instanceof ScheduleIdempotencyConflictError)
      return data(
        {
          ok: false,
          intent,
          retryable: error.code === "IDEMPOTENCY_REQUEST_IN_PROGRESS",
          error: error.message,
        },
        { status: 409 },
      );
    if (error instanceof ScheduleUndoUnavailableError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof ScheduleNotFoundError)
      return data(
        {
          ok: false,
          ...(autoPlacementIntent ? { intent: autoPlacementIntent } : {}),
          error: error.message,
        },
        { status: 404 },
      );
    if (error instanceof SchedulePlacementBlockedError)
      return data(
        { ok: false, error: error.message, conflicts: error.conflicts },
        { status: 409 },
      );
    if (error instanceof SchedulePublicationBlockedError)
      return data(
        { ok: false, error: error.message, conflicts: error.conflicts },
        { status: 409 },
      );
    if (error instanceof ScheduleConfigurationError)
      return data(
        {
          ok: false,
          ...(autoPlacementIntent ? { intent: autoPlacementIntent } : {}),
          error: error.message,
        },
        { status: 422 },
      );
    if (error instanceof Response) throw error;
    throw error;
  }
}
