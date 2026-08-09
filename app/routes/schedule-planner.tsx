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
import { data, Form, useFetcher, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/schedule-planner";
import { Dialog } from "~/components/dialog";
import {
  ScheduleNotFoundError,
  SchedulePlacementBlockedError,
  SchedulePublicationBlockedError,
  ScheduleRevisionConflictError,
  ScheduleService,
  type ScheduleSession,
  type ScheduleWorkspace,
} from "~/modules/schedule/schedule-service.server";
import {
  eventBoundaryCalendarDate,
  eventCalendarDayBoundaries,
  eventDayScheduleSlots,
  eventLocalCalendarDate,
  eventLocalTimeEpoch,
} from "~/modules/schedule/schedule-time";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  notifyRouteChange,
  recordRouteChange,
} from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Schedule Planner · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
  const workspace = await new ScheduleService(env).getWorkspace(viewer);
  const requestedFilter = new URL(request.url).searchParams.get("filter");
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
    const rows = await env.DB.prepare(
      `
      SELECT DISTINCT se.session_id AS sessionId
        FROM schedule_entries se
       WHERE se.event_id = ? AND se.schedule_version_id = ?
         AND se.id IN (
           SELECT primary_entry_id FROM schedule_conflicts
            WHERE event_id = ? AND schedule_version_id = ? AND resolved_at IS NULL
           UNION
           SELECT conflicting_entry_id FROM schedule_conflicts
            WHERE event_id = ? AND schedule_version_id = ? AND resolved_at IS NULL
         )
       ORDER BY se.session_id
    `,
    )
      .bind(
        viewer.eventId,
        workspace.version.id,
        viewer.eventId,
        workspace.version.id,
        viewer.eventId,
        workspace.version.id,
      )
      .all<{ sessionId: string }>();
    filteredSessionIds = rows.results.map((row) => row.sessionId);
  }
  return { ...workspace, activeFilter, filteredSessionIds };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
  const values = await request.formData();
  const service = new ScheduleService(env);
  try {
    switch (values.get("intent")) {
      case "create-draft": {
        const scheduleVersionId = await service.createDraft(viewer);
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
        if (realtimeFailure) return data(realtimeFailure, { status: 207 });
        return {
          ok: true,
          message: result.warnings.length
            ? `Session placed with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}.`
            : "Session placed.",
        };
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
        if (publication.calendar.dispatchError || realtimeFailure) {
          const calendarMessage = publication.calendar.dispatchError
            ? ` Calendar fan-out operation ${publication.calendar.operationId} could not be queued: ${publication.calendar.dispatchError}`
            : "";
          return data(
            {
              ok: false,
              committed: true,
              error: `Schedule published successfully.${calendarMessage}${realtimeFailure ? ` ${realtimeFailure.message}` : ""}`,
              calendar: publication.calendar,
            },
            { status: 207 },
          );
        }
        return {
          ok: true,
          message: `Schedule published. Calendar fan-out operation ${publication.calendar.operationId} queued.`,
          calendar: publication.calendar,
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
    if (error instanceof ScheduleRevisionConflictError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof ScheduleNotFoundError)
      return data({ ok: false, error: error.message }, { status: 404 });
    if (error instanceof SchedulePlacementBlockedError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof SchedulePublicationBlockedError)
      return data({ ok: false, error: error.message }, { status: 409 });
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
}: {
  entryId: string;
  session: ScheduleSession;
  disabled: boolean;
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
      type="button"
      disabled={disabled}
      className={`session-card presentation schedule-entry-draggable${isDragging ? " dragging" : ""}`}
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
    </button>
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

function ScheduleList({ workspace }: { workspace: ScheduleWorkspace }) {
  const sessions = new Map(
    workspace.sessions.map((session) => [session.id, session]),
  );
  const rooms = new Map(workspace.rooms.map((room) => [room.id, room]));
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Session</th>
            <th>Room</th>
            <th>Speakers</th>
          </tr>
        </thead>
        <tbody>
          {workspace.entries.map((entry) => {
            const session = sessions.get(entry.sessionId);
            return (
              <tr key={entry.id}>
                <td>
                  {dateLabel(entry.startsAt, workspace.event.timezone)}
                  <small className="subtle" style={{ display: "block" }}>
                    {timeLabel(entry.startsAt, workspace.event.timezone)}–
                    {timeLabel(entry.endsAt, workspace.event.timezone)}
                  </small>
                </td>
                <td>
                  <strong>{session?.title ?? "Unavailable session"}</strong>
                </td>
                <td>{rooms.get(entry.roomId)?.name ?? "Unavailable room"}</td>
                <td>{session?.speakerNames.join(", ") || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function SchedulePlanner({
  loaderData: workspace,
}: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
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
  const [selectedDay, setSelectedDay] = useState(eventDays[0]!);
  const roomScrollRef = useRef<HTMLDivElement>(null);
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
  const entryBySlot = useMemo(
    () =>
      new Map(
        workspace.entries.map((entry) => [
          `${entry.roomId}:${entry.startsAt}`,
          entry,
        ]),
      ),
    [workspace.entries],
  );
  const sessionById = useMemo(
    () => new Map(workspace.sessions.map((session) => [session.id, session])),
    [workspace.sessions],
  );
  const placementAvailable = workspace.version?.status === "draft";
  const readOnlyPlacementMessage = workspace.version
    ? "Create the next draft to place"
    : "Create a schedule to place";

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
    void fetcher.submit(
      {
        intent: "place",
        scheduleVersionId: workspace.version.id,
        scheduleRevision: String(workspace.version.revision),
        sessionId,
        roomId,
        startsAt: String(startsAt),
        endsAt: String(startsAt + session.durationMinutes * 60),
      },
      { method: "post" },
    );
  }

  const actionResult = fetcher.data;
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
          <a className="btn small" href="/admin/schedule">
            Clear filter
          </a>
        </div>
      ) : null}
      {actionResult && "error" in actionResult ? (
        <div className="validation-item error mb" role="alert">
          {actionResult.error}
        </div>
      ) : actionResult?.message ? (
        <div className="validation-item ok mb" role="status">
          {actionResult.message}
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
              <ScheduleList workspace={workspace} />
            ) : view === "track" ? (
              <div className="grid grid-2">
                {workspace.tracks.map((track) => (
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
                        const entry = entryBySlot.get(`${room.id}:${startsAt}`);
                        const session = entry
                          ? sessionById.get(entry.sessionId)
                          : null;
                        return (
                          <ScheduleCell
                            key={`${room.id}:${startsAt}`}
                            roomId={room.id}
                            startsAt={startsAt}
                          >
                            {session && entry ? (
                              <DraggableScheduledSession
                                entryId={entry.id}
                                session={session}
                                disabled={workspace.version?.status !== "draft"}
                              />
                            ) : null}
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
            {workspace.conflicts.map((conflict) => (
              <div
                className={`validation-item ${conflict.severity === "blocking" ? "error" : "warn"}`}
                key={conflict.id}
              >
                <strong>{conflict.type}</strong>
                <p>{conflict.message}</p>
              </div>
            ))}
            {!workspace.conflicts.length ? (
              <div className="validation-item ok">No recorded conflicts.</div>
            ) : null}
          </aside>
        </div>
      </DndContext>
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
            className={`validation-item ${workspace.conflicts.some((conflict) => conflict.severity === "blocking") ? "error" : "ok"}`}
          >
            {workspace.conflicts.length
              ? `${workspace.conflicts.length} recorded conflicts will be revalidated before publication.`
              : "No recorded conflicts. All placements will be revalidated before publication."}
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
