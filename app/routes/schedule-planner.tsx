import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useMemo, useRef, useState } from "react";
import { data, Form, Link, useFetcher, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/schedule-planner";
import { Dialog } from "~/components/dialog";
import { ScheduleContentWorkflows } from "~/components/schedule-content-workflows";
import { ScheduleStandardCalendar } from "~/components/schedule-standard-calendar";
import {
  ScheduleConflictExplanationAction,
  SessionCopyAction,
} from "~/modules/ai/contextual-ai-actions";
import {
  ScheduleIdempotencyConflictError,
  ScheduleNotFoundError,
  ScheduleConfigurationError,
  SchedulePlacementBlockedError,
  SchedulePublicationBlockedError,
  ScheduleRevisionConflictError,
  ScheduleService,
  ScheduleUndoUnavailableError,
  type ScheduleSession,
  type ScheduleWorkspace,
} from "~/modules/schedule/schedule-service.server";
import {
  generateInvitationIcs,
  stableCalendarUid,
} from "~/modules/calendars/ics.server";
import {
  eventBoundaryCalendarDate,
  eventCalendarDayBoundaries,
  eventDayScheduleSlots,
  eventLocalCalendarDate,
  eventLocalTimeEpoch,
} from "~/modules/schedule/schedule-time";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  notifyRouteChange,
  recordRouteChange,
} from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Schedule Planner · Program Cue" }];

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
      return data({ ok: false, error: error.message }, { status: 404 });
    if (error instanceof SchedulePlacementBlockedError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof SchedulePublicationBlockedError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof ScheduleConfigurationError)
      return data({ ok: false, error: error.message }, { status: 422 });
    if (error instanceof Response) throw error;
    throw error;
  }
}

function DraggableSession({
  session,
  scheduled,
  placementAvailable,
  readOnlyMessage,
}: {
  session: ScheduleSession;
  scheduled: boolean;
  placementAvailable: boolean;
  readOnlyMessage: string;
}) {
  const disabled = scheduled || !placementAvailable;
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `session:${session.id}`,
      data: { sessionId: session.id },
      disabled,
    });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`schedule-session-source${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform) }}
      disabled={disabled}
      {...listeners}
      {...attributes}
    >
      <strong>{session.title}</strong>
      <small>
        {session.durationMinutes} min ·{" "}
        {session.speakerNames.join(", ") || "No speaker"}
      </small>
      {session.requiredResources.length ? (
        <small>Resources · {session.requiredResources.join(", ")}</small>
      ) : null}
      {scheduled ? (
        <span className="status success">Scheduled</span>
      ) : (
        <span className="help">
          {placementAvailable
            ? "Drag or use keyboard placement"
            : readOnlyMessage}
        </span>
      )}
    </button>
  );
}

function DraggableScheduledSession({
  entryId,
  session,
  disabled,
  focused,
}: {
  entryId: string;
  session: ScheduleSession;
  disabled: boolean;
  focused: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `entry:${entryId}`,
      data: { sessionId: session.id },
      disabled,
    });
  return (
    <button
      ref={setNodeRef}
      id={`schedule-session-${session.id}`}
      data-session-id={session.id}
      type="button"
      className={`session-card presentation schedule-entry-draggable${isDragging ? " dragging" : ""}${focused ? " focused" : ""}`}
      style={{ transform: CSS.Translate.toString(transform) }}
      aria-label={
        disabled
          ? session.title
          : `Move ${session.title}. Press Space, choose a destination with the arrow keys, then press Space again.`
      }
      {...listeners}
      {...attributes}
    >
      <strong>{session.title}</strong>
      <small>{session.speakerNames.join(", ")}</small>
      {session.requiredResources.length ? (
        <small>{session.requiredResources.join(", ")}</small>
      ) : null}
    </button>
  );
}

function ScheduledSessionResizeControl({
  entry,
  session,
  disabled,
  onResize,
}: {
  entry: ScheduleWorkspace["entries"][number];
  session: ScheduleSession;
  disabled: boolean;
  onResize: (minutes: number) => void;
}) {
  const currentMinutes = Math.round((entry.endsAt - entry.startsAt) / 60);
  const [minutes, setMinutes] = useState(currentMinutes);
  const outputId = `resize-output-${entry.id}`;
  return (
    <div className="stack" aria-label={`Resize ${session.title}`}>
      <label className="help" htmlFor={`resize-${entry.id}`}>
        Duration
      </label>
      <input
        id={`resize-${entry.id}`}
        type="range"
        min={5}
        max={480}
        step={1}
        value={minutes}
        disabled={disabled}
        aria-describedby={outputId}
        onChange={(event) => setMinutes(Number(event.target.value))}
      />
      <div className="row-main">
        <output id={outputId} htmlFor={`resize-${entry.id}`}>
          {minutes} min
        </output>
        <button
          className="btn small"
          type="button"
          disabled={disabled || minutes === currentMinutes}
          onClick={() => onResize(minutes)}
        >
          Apply resize
        </button>
      </div>
    </div>
  );
}

function ScheduleCell({
  roomId,
  startsAt,
  children,
}: {
  roomId: string;
  startsAt: number;
  children?: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `slot:${roomId}:${startsAt}`,
    data: { roomId, startsAt },
  });
  return (
    <div
      ref={setNodeRef}
      className={`schedule-drop${isOver ? " is-over" : ""}`}
      data-starts-at={startsAt}
    >
      {children}
    </div>
  );
}

function timeLabel(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function dateLabel(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function localHour(epoch: number, timezone: string) {
  const hour = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone: timezone,
  })
    .formatToParts(new Date(epoch * 1_000))
    .find((part) => part.type === "hour")?.value;
  if (hour === undefined) throw new Error("Could not format schedule hour.");
  return Number(hour);
}

export default function SchedulePlanner({
  loaderData: workspace,
}: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  useEffect(() => {
    if (!workspace.focusedConflictId) return;
    const target = document.getElementById(
      `schedule-conflict-${workspace.focusedConflictId}`,
    );
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  }, [workspace.focusedConflictId]);
  const [view, setView] = useState<"room" | "list" | "day" | "week" | "track">(
    "room",
  );
  const [publishOpen, setPublishOpen] = useState(false);
  const eventDays = useMemo(
    () =>
      eventCalendarDayBoundaries(
        workspace.event.startsAt,
        workspace.event.endsAt,
      ),
    [workspace.event.endsAt, workspace.event.startsAt],
  );
  const focusedEntry = workspace.entries.find(
    (entry) => entry.sessionId === workspace.focusedSessionId,
  );
  const [selectedDay, setSelectedDay] = useState(() => {
    if (!focusedEntry) return eventDays[0]!;
    const focusedDate = eventLocalCalendarDate(
      focusedEntry.startsAt,
      workspace.event.timezone,
    );
    return (
      eventDays.find(
        (eventDay) => eventBoundaryCalendarDate(eventDay) === focusedDate,
      ) ?? eventDays[0]!
    );
  });
  const roomScrollRef = useRef<HTMLDivElement>(null);
  const pendingResizeSessionId = useRef<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const scheduledSessionIds = useMemo(
    () => new Set(workspace.entries.map((entry) => entry.sessionId)),
    [workspace.entries],
  );
  const filteredIds = useMemo(
    () => new Set(workspace.filteredSessionIds),
    [workspace.filteredSessionIds],
  );
  const visibleSessions = workspace.activeFilter
    ? workspace.sessions.filter((session) => filteredIds.has(session.id))
    : workspace.sessions;
  const selectedDate = eventBoundaryCalendarDate(selectedDay);
  const selectedDayEntries = useMemo(
    () =>
      workspace.entries.filter(
        (entry) =>
          eventLocalCalendarDate(entry.startsAt, workspace.event.timezone) ===
          selectedDate,
      ),
    [selectedDate, workspace.entries, workspace.event.timezone],
  );
  const slots = useMemo(
    () =>
      eventDayScheduleSlots(
        selectedDay,
        workspace.event.timezone,
        selectedDayEntries.map((entry) => entry.startsAt),
      ),
    [selectedDay, selectedDayEntries, workspace.event.timezone],
  );
  const entriesBySlot = useMemo(() => {
    const grouped = new Map<string, ScheduleWorkspace["entries"]>();
    for (const entry of workspace.entries) {
      const key = `${entry.roomId}:${entry.startsAt}`;
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    return grouped;
  }, [workspace.entries]);
  const sessionById = useMemo(
    () => new Map(workspace.sessions.map((session) => [session.id, session])),
    [workspace.sessions],
  );
  const resourceInventory = useMemo(
    () =>
      [...new Set(workspace.rooms.flatMap((room) => room.resources))].sort(),
    [workspace.rooms],
  );
  const placementAvailable = workspace.version?.status === "draft";
  const readOnlyPlacementMessage = workspace.version
    ? "Create the next draft to place"
    : "Create a schedule to place";
  const unscheduledSessions = workspace.sessions.filter(
    (session) => !scheduledSessionIds.has(session.id),
  );
  const allPlacementSlots = useMemo(
    () =>
      eventDays.flatMap((eventDay) =>
        eventDayScheduleSlots(eventDay, workspace.event.timezone).filter(
          (slot) => {
            const hour = localHour(slot, workspace.event.timezone);
            return hour >= 7 && hour < 22;
          },
        ),
      ),
    [eventDays, workspace.event.timezone],
  );
  const initialQuickSession =
    (workspace.focusedSessionId
      ? sessionById.get(workspace.focusedSessionId)
      : null) ??
    unscheduledSessions[0] ??
    workspace.sessions[0] ??
    null;
  const initialQuickEntry = initialQuickSession
    ? workspace.entries.find(
        (entry) => entry.sessionId === initialQuickSession.id,
      )
    : null;
  const defaultQuickStart =
    allPlacementSlots.find(
      (slot) => localHour(slot, workspace.event.timezone) === 9,
    ) ?? allPlacementSlots[0]!;
  const [quickSessionId, setQuickSessionId] = useState(
    initialQuickSession?.id ?? "",
  );
  const [quickStartsAt, setQuickStartsAt] = useState(
    initialQuickEntry?.startsAt ?? defaultQuickStart,
  );
  const [quickRoomId, setQuickRoomId] = useState(
    initialQuickEntry?.roomId ?? workspace.rooms[0]?.id ?? "",
  );
  const [quickDurationMinutes, setQuickDurationMinutes] = useState(
    initialQuickEntry
      ? (initialQuickEntry.endsAt - initialQuickEntry.startsAt) / 60
      : (initialQuickSession?.durationMinutes ?? 30),
  );
  const quickSession = sessionById.get(quickSessionId);
  const quickEntry = workspace.entries.find(
    (entry) => entry.sessionId === quickSessionId,
  );
  const defaultQuickRoomId = workspace.rooms[0]?.id ?? "";

  useEffect(() => {
    if (workspace.focusedSessionId) {
      setQuickSessionId(workspace.focusedSessionId);
    }
  }, [workspace.focusedSessionId]);

  useEffect(() => {
    if (!quickSession) return;
    setQuickStartsAt(quickEntry?.startsAt ?? defaultQuickStart);
    setQuickRoomId(quickEntry?.roomId ?? defaultQuickRoomId);
    setQuickDurationMinutes(
      quickEntry
        ? (quickEntry.endsAt - quickEntry.startsAt) / 60
        : quickSession.durationMinutes,
    );
  }, [
    defaultQuickRoomId,
    defaultQuickStart,
    quickEntry?.endsAt,
    quickEntry?.roomId,
    quickEntry?.startsAt,
    quickSession?.durationMinutes,
    quickSession?.id,
  ]);
  const trackGroups: Array<{ id: string | null; name: string }> = [
    ...workspace.tracks,
    ...(workspace.entries.some(
      (entry) => sessionById.get(entry.sessionId)?.trackId === null,
    )
      ? [{ id: null, name: "No track" }]
      : []),
  ];

  function selectQuickSession(sessionId: string) {
    const session = sessionById.get(sessionId);
    const entry = workspace.entries.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    setQuickSessionId(sessionId);
    if (!session) return;
    setQuickDurationMinutes(
      entry ? (entry.endsAt - entry.startsAt) / 60 : session.durationMinutes,
    );
    setQuickStartsAt(entry?.startsAt ?? defaultQuickStart);
    setQuickRoomId(entry?.roomId ?? workspace.rooms[0]?.id ?? "");
  }

  useEffect(() => {
    const preferredStart =
      selectedDayEntries[0]?.startsAt ??
      eventLocalTimeEpoch(selectedDay, workspace.event.timezone, 8);
    const target = roomScrollRef.current?.querySelector<HTMLElement>(
      `[data-starts-at="${preferredStart}"]`,
    );
    if (target && roomScrollRef.current) {
      const scroll = roomScrollRef.current;
      const targetTop =
        target.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top +
        scroll.scrollTop;
      scroll.scrollTop = Math.max(0, targetTop - 48);
    }
  }, [selectedDay, selectedDayEntries, workspace.event.timezone]);

  useEffect(() => {
    if (!workspace.focusedSessionId) return;
    const target = document.getElementById(
      `schedule-session-${workspace.focusedSessionId}`,
    );
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", inline: "center" });
  }, [selectedDay, workspace.focusedSessionId, workspace.entries]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !pendingResizeSessionId.current) return;
    const entry = workspace.entries.find(
      (candidate) => candidate.sessionId === pendingResizeSessionId.current,
    );
    if (!entry) return;
    document.getElementById(`resize-${entry.id}`)?.focus({
      preventScroll: true,
    });
    pendingResizeSessionId.current = null;
  }, [fetcher.state, workspace.entries]);

  function place(event: DragEndEvent) {
    if (
      !workspace.version ||
      workspace.version.status !== "draft" ||
      !event.over
    )
      return;
    const sessionId = String(event.active.data.current?.sessionId ?? "");
    const roomId = String(event.over.data.current?.roomId ?? "");
    const startsAt = Number(event.over.data.current?.startsAt);
    const session = sessionById.get(sessionId);
    if (!session || !roomId || !startsAt) return;
    const existingEntry = workspace.entries.find(
      (entry) => entry.sessionId === sessionId,
    );
    const durationSeconds = existingEntry
      ? existingEntry.endsAt - existingEntry.startsAt
      : session.durationMinutes * 60;
    void fetcher.submit(
      {
        intent: "place",
        scheduleVersionId: workspace.version.id,
        scheduleRevision: String(workspace.version.revision),
        sessionId,
        roomId,
        startsAt: String(startsAt),
        endsAt: String(startsAt + durationSeconds),
      },
      { method: "post" },
    );
  }

  function unassign(entry: ScheduleWorkspace["entries"][number]) {
    if (!workspace.version || workspace.version.status !== "draft") return;
    void fetcher.submit(
      {
        intent: "unassign",
        scheduleVersionId: workspace.version.id,
        scheduleRevision: String(workspace.version.revision),
        entryId: entry.id,
      },
      { method: "post" },
    );
  }

  function resize(
    entry: ScheduleWorkspace["entries"][number],
    durationMinutes: number,
  ) {
    if (
      !workspace.version ||
      workspace.version.status !== "draft" ||
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 5 ||
      durationMinutes > 480
    )
      return;
    pendingResizeSessionId.current = entry.sessionId;
    void fetcher.submit(
      {
        intent: "place",
        scheduleVersionId: workspace.version.id,
        scheduleRevision: String(workspace.version.revision),
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        startsAt: String(entry.startsAt),
        endsAt: String(entry.startsAt + durationMinutes * 60),
      },
      { method: "post" },
    );
  }

  function moveInStandardCalendar(
    entry: ScheduleWorkspace["entries"][number],
    startsAt: number,
    endsAt: number,
  ) {
    if (
      !workspace.version ||
      workspace.version.status !== "draft" ||
      !Number.isInteger(startsAt) ||
      !Number.isInteger(endsAt) ||
      endsAt <= startsAt
    )
      return;
    void fetcher.submit(
      {
        intent: "place",
        scheduleVersionId: workspace.version.id,
        scheduleRevision: String(workspace.version.revision),
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        startsAt: String(startsAt),
        endsAt: String(endsAt),
      },
      { method: "post" },
    );
  }

  const actionResult = fetcher.data;
  useEffect(() => {
    if (
      !actionResult ||
      !("sessionId" in actionResult) ||
      typeof actionResult.sessionId !== "string" ||
      actionResult.sessionId !== quickSessionId ||
      !("restoredPlacement" in actionResult)
    ) {
      return;
    }
    const restoredPlacement = actionResult.restoredPlacement;
    if (restoredPlacement === null) {
      setQuickStartsAt(defaultQuickStart);
      setQuickRoomId(defaultQuickRoomId);
      if (quickSession) setQuickDurationMinutes(quickSession.durationMinutes);
      return;
    }
    if (
      typeof restoredPlacement !== "object" ||
      !("roomId" in restoredPlacement) ||
      typeof restoredPlacement.roomId !== "string" ||
      !("startsAt" in restoredPlacement) ||
      typeof restoredPlacement.startsAt !== "number" ||
      !("endsAt" in restoredPlacement) ||
      typeof restoredPlacement.endsAt !== "number"
    ) {
      return;
    }
    setQuickRoomId(restoredPlacement.roomId);
    setQuickStartsAt(restoredPlacement.startsAt);
    setQuickDurationMinutes(
      (restoredPlacement.endsAt - restoredPlacement.startsAt) / 60,
    );
  }, [
    actionResult,
    defaultQuickRoomId,
    defaultQuickStart,
    quickSession,
    quickSessionId,
  ]);
  const undo =
    actionResult &&
    "undo" in actionResult &&
    actionResult.undo &&
    typeof actionResult.undo === "object" &&
    "token" in actionResult.undo &&
    typeof actionResult.undo.token === "string" &&
    "expiresAt" in actionResult.undo &&
    typeof actionResult.undo.expiresAt === "number" &&
    "scheduleRevision" in actionResult &&
    typeof actionResult.scheduleRevision === "number" &&
    Number.isSafeInteger(actionResult.scheduleRevision) &&
    actionResult.scheduleRevision > 0
      ? {
          token: actionResult.undo.token,
          expiresAt: actionResult.undo.expiresAt,
          scheduleRevision: actionResult.scheduleRevision,
        }
      : null;
  const [undoClock, setUndoClock] = useState(() =>
    Math.floor(Date.now() / 1_000),
  );
  useEffect(() => {
    if (!undo) return;
    const delay = Math.max(0, undo.expiresAt * 1_000 - Date.now());
    const timeout = window.setTimeout(
      () => setUndoClock(Math.floor(Date.now() / 1_000)),
      delay + 50,
    );
    return () => window.clearTimeout(timeout);
  }, [undo?.expiresAt, undo?.token]);
  const undoAvailable = undo && undo.expiresAt > undoClock ? undo : null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Schedule Planner</h1>
          <p>Build and publish a conflict-checked programme.</p>
        </div>
        <div className="page-actions">
          {workspace.version ? (
            <span
              className={`status ${workspace.version.status === "published" ? "success" : "info"}`}
            >
              Version {workspace.version.versionNumber} ·{" "}
              {workspace.version.status}
            </span>
          ) : null}
          {workspace.version?.status === "draft" ? (
            <button
              className="btn primary"
              type="button"
              onClick={() => setPublishOpen(true)}
            >
              Publish schedule
            </button>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="create-draft" />
              <input type="hidden" name="intentId" value={workspace.intentId} />
              <button
                className="btn primary"
                disabled={navigation.state !== "idle"}
              >
                {workspace.version ? "Create next draft" : "Create schedule"}
              </button>
            </Form>
          )}
        </div>
      </div>
      {workspace.activeFilter ? (
        <div className="validation-item info mb" role="status">
          <strong>Filtered view</strong>
          <span>
            {visibleSessions.length} session
            {visibleSessions.length === 1 ? "" : "s"} match{" "}
            {workspace.activeFilter.replaceAll("_", " ")}.
          </span>
          <Link className="btn small" to="/admin/schedule">
            Clear filter
          </Link>
        </div>
      ) : null}
      {workspace.focusedSessionId ? (
        <div className="validation-item info mb" role="status">
          <strong>Focused session</strong>
          <span>
            {sessionById.get(workspace.focusedSessionId)?.title ??
              "Named session"}
          </span>
          <Link className="btn small" to="/admin/schedule">
            Clear focus
          </Link>
        </div>
      ) : null}
      {actionResult && "error" in actionResult ? (
        <div className="validation-item error mb" role="alert">
          <span>{actionResult.error}</span>
          {undoAvailable && workspace.version?.status === "draft" ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="undo" />
              <input
                type="hidden"
                name="scheduleVersionId"
                value={workspace.version.id}
              />
              <input
                type="hidden"
                name="scheduleRevision"
                value={undoAvailable.scheduleRevision}
              />
              <input
                type="hidden"
                name="undoToken"
                value={undoAvailable.token}
              />
              <button
                className="btn small"
                type="submit"
                disabled={fetcher.state !== "idle"}
              >
                Undo
              </button>
            </fetcher.Form>
          ) : null}
        </div>
      ) : actionResult?.message ? (
        <div className="validation-item ok mb" role="status">
          <span>{actionResult.message}</span>
          {undoAvailable && workspace.version?.status === "draft" ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="undo" />
              <input
                type="hidden"
                name="scheduleVersionId"
                value={workspace.version.id}
              />
              <input
                type="hidden"
                name="scheduleRevision"
                value={undoAvailable.scheduleRevision}
              />
              <input
                type="hidden"
                name="undoToken"
                value={undoAvailable.token}
              />
              <button
                className="btn small"
                type="submit"
                disabled={fetcher.state !== "idle"}
              >
                Undo
              </button>
            </fetcher.Form>
          ) : null}
        </div>
      ) : null}
      <div className="schedule-summary card">
        <div>
          <strong>{workspace.sessions.length}</strong>
          <small>Sessions</small>
        </div>
        <div>
          <strong>{workspace.entries.length}</strong>
          <small>Scheduled</small>
        </div>
        <div>
          <strong>
            {workspace.sessions.length - scheduledSessionIds.size}
          </strong>
          <small>Unscheduled</small>
        </div>
        <div>
          <strong
            style={{
              color: workspace.conflicts.length ? "var(--red)" : "var(--green)",
            }}
          >
            {workspace.conflicts.length}
          </strong>
          <small>Open conflicts</small>
        </div>
      </div>
      <div className="tabs mt" role="group" aria-label="Schedule view">
        {(["room", "list", "day", "week", "track"] as const).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={view === name}
            className={`tab${view === name ? " active" : ""}`}
            onClick={() => setView(name)}
          >
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>
      <DndContext
        id="schedule-planner-dnd-instructions"
        sensors={sensors}
        onDragEnd={place}
      >
        <div className="schedule-workspace mt">
          <aside className="card pad schedule-source">
            <div className="card-title">
              <h2>Sessions</h2>
            </div>
            {placementAvailable &&
            workspace.sessions.length &&
            workspace.rooms.length ? (
              <details className="mb">
                <summary>
                  <strong>Place or move with form</strong>
                  <span className="help">
                    Keyboard alternative across every event day
                  </span>
                </summary>
                <fetcher.Form method="post" className="stack mt">
                  <input type="hidden" name="intent" value="place" />
                  <input
                    type="hidden"
                    name="scheduleVersionId"
                    value={workspace.version!.id}
                  />
                  <input
                    type="hidden"
                    name="scheduleRevision"
                    value={workspace.version!.revision}
                  />
                  <input
                    type="hidden"
                    name="endsAt"
                    value={
                      quickSession
                        ? quickStartsAt + quickDurationMinutes * 60
                        : ""
                    }
                  />
                  <label className="label">
                    Session
                    <select
                      className="select"
                      name="sessionId"
                      value={quickSessionId}
                      onChange={(event) =>
                        selectQuickSession(event.target.value)
                      }
                    >
                      {workspace.sessions.map((session) => (
                        <option key={session.id} value={session.id}>
                          {session.title}
                          {scheduledSessionIds.has(session.id)
                            ? " · scheduled"
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="label">
                    Room
                    <select
                      className="select"
                      name="roomId"
                      value={quickRoomId}
                      onChange={(event) => setQuickRoomId(event.target.value)}
                      required
                    >
                      {workspace.rooms.map((room) => (
                        <option key={room.id} value={room.id}>
                          {room.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="label">
                    Start · {workspace.event.timezone}
                    <select
                      className="select"
                      name="startsAt"
                      value={quickStartsAt}
                      onChange={(event) =>
                        setQuickStartsAt(Number(event.target.value))
                      }
                      required
                    >
                      {allPlacementSlots.map((slot) => (
                        <option key={slot} value={slot}>
                          {dateLabel(slot, workspace.event.timezone)} ·{" "}
                          {timeLabel(slot, workspace.event.timezone)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="label">
                    Duration (minutes)
                    <input
                      className="field"
                      type="number"
                      min={5}
                      max={480}
                      step={5}
                      value={quickDurationMinutes}
                      onChange={(event) =>
                        setQuickDurationMinutes(Number(event.target.value))
                      }
                      required
                    />
                  </label>
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={
                      !quickSession ||
                      !quickRoomId ||
                      !Number.isInteger(quickDurationMinutes) ||
                      quickDurationMinutes < 5 ||
                      fetcher.state !== "idle"
                    }
                  >
                    {scheduledSessionIds.has(quickSessionId)
                      ? "Move or resize session"
                      : "Place session"}
                  </button>
                </fetcher.Form>
              </details>
            ) : null}
            {quickSession ? (
              <SessionCopyAction
                sessionId={quickSession.id}
                key={`ai-copy-${quickSession.id}`}
              />
            ) : null}
            {placementAvailable && quickSession ? (
              <details className="mb" key={`resources-${quickSession.id}`}>
                <summary>
                  <strong>Session required resources</strong>
                  <span className="help"> · {quickSession.title}</span>
                </summary>
                <fetcher.Form method="post" className="stack mt">
                  <input
                    type="hidden"
                    name="intent"
                    value="update-session-resources"
                  />
                  <input
                    type="hidden"
                    name="scheduleVersionId"
                    value={workspace.version!.id}
                  />
                  <input
                    type="hidden"
                    name="scheduleRevision"
                    value={workspace.version!.revision}
                  />
                  <input
                    type="hidden"
                    name="sessionId"
                    value={quickSession.id}
                  />
                  <input
                    type="hidden"
                    name="sessionRevision"
                    value={quickSession.revision}
                  />
                  {resourceInventory.length ? (
                    resourceInventory.map((resource) => (
                      <label className="toggle" key={resource}>
                        <input
                          type="checkbox"
                          name="requiredResource"
                          value={resource}
                          defaultChecked={quickSession.requiredResources.includes(
                            resource,
                          )}
                        />{" "}
                        {resource}
                        <span className="help">
                          {workspace.rooms
                            .filter((room) => room.resources.includes(resource))
                            .map((room) => room.name)
                            .join(", ")}
                        </span>
                      </label>
                    ))
                  ) : (
                    <div className="validation-item warn">
                      <span>
                        Configure resource inventory on at least one room in
                        Event Setup before assigning session requirements.
                      </span>
                      <Link className="btn small" to="/admin/event">
                        Open Event Setup
                      </Link>
                    </div>
                  )}
                  <button
                    className="btn"
                    type="submit"
                    disabled={fetcher.state !== "idle"}
                  >
                    Save required resources
                  </button>
                </fetcher.Form>
              </details>
            ) : null}
            <details className="mb">
              <summary>
                <strong>Create break</strong>
              </summary>
              <fetcher.Form method="post" className="stack mt">
                <input type="hidden" name="intent" value="create-break" />
                <label className="label">
                  Label
                  <input
                    className="field"
                    name="title"
                    defaultValue="Refreshment break"
                    maxLength={160}
                    required
                  />
                </label>
                <label className="label">
                  Duration (minutes)
                  <input
                    className="field"
                    name="durationMinutes"
                    type="number"
                    min={5}
                    max={480}
                    defaultValue={30}
                    required
                  />
                </label>
                {resourceInventory.length ? (
                  <fieldset className="stack">
                    <legend className="label">Exclusive resources</legend>
                    {resourceInventory.map((resource) => (
                      <label className="toggle" key={resource}>
                        <input
                          type="checkbox"
                          name="requiredResource"
                          value={resource}
                        />{" "}
                        {resource}
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <p className="help">
                    No room resources are configured; this break will not
                    reserve one.
                  </p>
                )}
                <button className="btn" type="submit">
                  Create unscheduled break
                </button>
              </fetcher.Form>
            </details>
            <div className="stack">
              {visibleSessions.map((session) => (
                <DraggableSession
                  key={session.id}
                  session={session}
                  scheduled={scheduledSessionIds.has(session.id)}
                  placementAvailable={placementAvailable}
                  readOnlyMessage={readOnlyPlacementMessage}
                />
              ))}
              {visibleSessions.length === 0 ? (
                <div className="empty">
                  <p>
                    {workspace.activeFilter
                      ? "No sessions match this operational filter."
                      : "Accepted and direct sessions will appear here."}
                  </p>
                </div>
              ) : null}
            </div>
          </aside>
          <section className="card pad schedule-canvas">
            <div className="card-title">
              <h2>
                {view === "room"
                  ? `${dateLabel(selectedDay, "UTC")} · Room view`
                  : `${view[0].toUpperCase() + view.slice(1)} view`}
              </h2>
              <span className="help right">
                {workspace.version?.status === "draft"
                  ? "Server validation is authoritative · scheduled cards support pointer and keyboard moves"
                  : "Published schedules are read-only · create the next draft to move sessions"}
              </span>
            </div>
            {view === "list" || view === "day" || view === "week" ? (
              <>
                {view === "day" ? (
                  <div
                    className="tabs schedule-day-tabs"
                    role="group"
                    aria-label="Event day"
                  >
                    {eventDays.map((day) => {
                      const date = eventBoundaryCalendarDate(day);
                      const entryCount = workspace.entries.filter(
                        (entry) =>
                          eventLocalCalendarDate(
                            entry.startsAt,
                            workspace.event.timezone,
                          ) === date,
                      ).length;
                      return (
                        <button
                          key={day}
                          type="button"
                          className={`tab${selectedDay === day ? " active" : ""}`}
                          aria-pressed={selectedDay === day}
                          onClick={() => setSelectedDay(day)}
                        >
                          {dateLabel(day, "UTC")}
                          <small>{entryCount} placed</small>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <ScheduleStandardCalendar
                  workspace={workspace}
                  view={view}
                  selectedDay={selectedDay}
                  placementAvailable={placementAvailable}
                  busy={fetcher.state !== "idle"}
                  onMove={moveInStandardCalendar}
                  onResize={resize}
                  onSelectSession={selectQuickSession}
                />
              </>
            ) : view === "track" ? (
              <div className="grid grid-2">
                {trackGroups.map((track) => (
                  <section className="card pad" key={track.id}>
                    <h3>{track.name}</h3>
                    {workspace.entries
                      .filter(
                        (entry) =>
                          sessionById.get(entry.sessionId)?.trackId ===
                          track.id,
                      )
                      .map((entry) => (
                        <p key={entry.id}>
                          <strong>
                            {dateLabel(
                              entry.startsAt,
                              workspace.event.timezone,
                            )}{" "}
                            ·{" "}
                            {timeLabel(
                              entry.startsAt,
                              workspace.event.timezone,
                            )}
                          </strong>{" "}
                          · {sessionById.get(entry.sessionId)?.title}
                        </p>
                      ))}
                  </section>
                ))}
              </div>
            ) : (
              <>
                <div
                  className="tabs schedule-day-tabs"
                  role="group"
                  aria-label="Event day"
                >
                  {eventDays.map((day) => {
                    const date = eventBoundaryCalendarDate(day);
                    const entryCount = workspace.entries.filter(
                      (entry) =>
                        eventLocalCalendarDate(
                          entry.startsAt,
                          workspace.event.timezone,
                        ) === date,
                    ).length;
                    return (
                      <button
                        key={day}
                        type="button"
                        className={`tab${selectedDay === day ? " active" : ""}`}
                        aria-pressed={selectedDay === day}
                        onClick={() => setSelectedDay(day)}
                      >
                        {dateLabel(day, "UTC")}
                        <small>{entryCount} placed</small>
                      </button>
                    );
                  })}
                </div>
                <p className="schedule-scroll-hint">
                  <span aria-hidden>↔</span> Swipe horizontally to see every
                  room
                </p>
                <div
                  ref={roomScrollRef}
                  className="table-wrap schedule-room-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label={`${dateLabel(selectedDay, "UTC")} room schedule. Scroll horizontally to see every room.`}
                >
                  <div
                    className="schedule-room-board"
                    style={{
                      gridTemplateColumns: `90px repeat(${workspace.rooms.length}, minmax(150px, 1fr))`,
                    }}
                  >
                    <div className="header">Time</div>
                    {workspace.rooms.map((room) => (
                      <div className="header" key={room.id}>
                        {room.name}
                        <small>
                          {room.capacity
                            ? `Capacity ${room.capacity}`
                            : "No capacity"}
                        </small>
                      </div>
                    ))}
                    {slots.flatMap((startsAt) => [
                      <div className="time" key={`time:${startsAt}`}>
                        {timeLabel(startsAt, workspace.event.timezone)}
                      </div>,
                      ...workspace.rooms.map((room) => {
                        const entries =
                          entriesBySlot.get(`${room.id}:${startsAt}`) ?? [];
                        return (
                          <ScheduleCell
                            key={`${room.id}:${startsAt}`}
                            roomId={room.id}
                            startsAt={startsAt}
                          >
                            {entries.map((entry) => {
                              const session = sessionById.get(entry.sessionId);
                              if (!session) return null;
                              return (
                                <div className="stack" key={entry.id}>
                                  <DraggableScheduledSession
                                    entryId={entry.id}
                                    session={session}
                                    disabled={
                                      workspace.version?.status !== "draft"
                                    }
                                    focused={
                                      workspace.focusedSessionId === session.id
                                    }
                                  />
                                  {workspace.version?.status === "draft" ? (
                                    <ScheduledSessionResizeControl
                                      key={`${entry.id}:${entry.revision}`}
                                      entry={entry}
                                      session={session}
                                      disabled={fetcher.state !== "idle"}
                                      onResize={(minutes) =>
                                        resize(entry, minutes)
                                      }
                                    />
                                  ) : null}
                                  {workspace.version?.status === "draft" ? (
                                    <button
                                      className="btn small"
                                      type="button"
                                      onClick={() => unassign(entry)}
                                      disabled={fetcher.state !== "idle"}
                                    >
                                      Unassign
                                    </button>
                                  ) : null}
                                </div>
                              );
                            })}
                          </ScheduleCell>
                        );
                      }),
                    ])}
                  </div>
                </div>
              </>
            )}
          </section>
          <aside className="card pad schedule-conflicts">
            <div className="card-title">
              <h2>Validation</h2>
              <span
                className={`status ${workspace.conflicts.length ? "danger" : "success"}`}
              >
                {workspace.conflicts.length
                  ? `${workspace.conflicts.length} open`
                  : "Ready"}
              </span>
            </div>
            <details className="mb">
              <summary>
                <strong>Conflict policies</strong>
                <span className="help"> · Authoritative at publication</span>
              </summary>
              <fetcher.Form method="post" className="stack mt">
                <input type="hidden" name="intent" value="update-policies" />
                <input
                  type="hidden"
                  name="revision"
                  value={workspace.policyRevision}
                />
                {(
                  [
                    ["roomAction", "Room overlap", workspace.policies.room],
                    [
                      "speakerAction",
                      "Speaker overlap and turnaround",
                      workspace.policies.speaker,
                    ],
                    [
                      "resourceAction",
                      "Required resource overlap",
                      workspace.policies.resource,
                    ],
                    [
                      "trackAction",
                      "Exclusive track overlap",
                      workspace.policies.track,
                    ],
                    [
                      "boundaryAction",
                      "Outside event dates",
                      workspace.policies.boundary,
                    ],
                    [
                      "capacityAction",
                      "Room capacity",
                      workspace.policies.capacity,
                    ],
                  ] as const
                ).map(([name, label, value]) => (
                  <label className="label" key={name}>
                    {label}
                    <select
                      className="select"
                      name={name}
                      defaultValue={value === "ignore" ? "allow" : value}
                    >
                      <option value="block">Block</option>
                      <option value="warn">Warn</option>
                      <option value="allow">Allow</option>
                    </select>
                  </label>
                ))}
                <label className="label">
                  Minimum speaker turnaround (minutes)
                  <input
                    className="field"
                    type="number"
                    name="minimumTurnaroundMinutes"
                    min={0}
                    max={240}
                    defaultValue={workspace.policies.minimumTurnaroundMinutes}
                    required
                  />
                </label>
                <button
                  className="btn"
                  type="submit"
                  disabled={fetcher.state !== "idle"}
                >
                  Save policies
                </button>
              </fetcher.Form>
            </details>
            {workspace.conflicts.map((conflict) => (
              <div
                id={`schedule-conflict-${conflict.id}`}
                className={`validation-item ${conflict.severity === "blocking" ? "error" : "warn"}`}
                key={conflict.id}
                tabIndex={
                  conflict.id === workspace.focusedConflictId ? -1 : undefined
                }
              >
                <strong>{conflict.type}</strong>
                <p>{conflict.message}</p>
                <ScheduleConflictExplanationAction conflictId={conflict.id} />
              </div>
            ))}
            {!workspace.conflicts.length ? (
              <div className="validation-item ok">No recorded conflicts.</div>
            ) : null}
          </aside>
        </div>
      </DndContext>
      <ScheduleContentWorkflows
        workspace={workspace}
        session={quickSession ?? null}
        recoveryScope={workspace.recoveryScope}
        calendarPreview={
          quickSession
            ? (workspace.calendarPreviews[quickSession.id] ?? null)
            : null
        }
      />
      {publishOpen && workspace.version ? (
        <Dialog
          title="Publish schedule"
          onClose={() => setPublishOpen(false)}
          footer={
            <>
              <button
                className="btn"
                type="button"
                onClick={() => setPublishOpen(false)}
              >
                Cancel
              </button>
              <fetcher.Form
                method="post"
                onSubmit={() => setPublishOpen(false)}
              >
                <input type="hidden" name="intent" value="publish" />
                <input
                  type="hidden"
                  name="scheduleVersionId"
                  value={workspace.version.id}
                />
                <input
                  type="hidden"
                  name="scheduleRevision"
                  value={workspace.version.revision}
                />
                <button className="btn primary">Confirm publication</button>
              </fetcher.Form>
            </>
          }
        >
          <p>
            Publish version {workspace.version.versionNumber} with{" "}
            <strong>{workspace.entries.length} scheduled sessions</strong>.
          </p>
          <div
            className={`validation-item ${workspace.publicationConflicts.some((conflict) => conflict.severity === "blocking") ? "error" : workspace.publicationConflicts.length ? "warn" : "ok"}`}
          >
            {workspace.publicationConflicts.length
              ? `${workspace.publicationConflicts.length} current conflict${workspace.publicationConflicts.length === 1 ? "" : "s"} will be revalidated before publication.`
              : "No current conflicts. All placements will be revalidated before publication."}
            {workspace.publicationConflicts.length ? (
              <ul>
                {workspace.publicationConflicts.map((conflict, index) => (
                  <li
                    key={`${conflict.type}:${conflict.conflictingEntryId ?? "entry"}:${index}`}
                  >
                    {conflict.severity === "blocking" ? "Blocking" : "Warning"}:{" "}
                    {conflict.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <p className="help">
            The current public version remains available in history. Calendar
            updates are queued separately.
          </p>
        </Dialog>
      ) : null}
    </>
  );
}
