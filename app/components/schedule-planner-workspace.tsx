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
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";

import { Dialog } from "~/components/dialog";
import { ScheduleContentWorkflows } from "~/components/schedule-content-workflows";
import { ScheduleStandardCalendar } from "~/components/schedule-standard-calendar";
import {
  ScheduleConflictExplanationAction,
  SessionCopyAction,
} from "~/modules/ai/contextual-ai-actions";
import type {
  ScheduleSession,
  ScheduleWorkspace,
} from "~/modules/schedule/schedule-service.server";
import {
  eventBoundaryCalendarDate,
  eventCalendarDayBoundaries,
  eventDayScheduleSlots,
  eventLocalCalendarDate,
  eventLocalTimeEpoch,
} from "~/modules/schedule/schedule-time";
import type { action, loader } from "~/routes/schedule-planner.server";

type SchedulePlannerWorkspaceData = Awaited<ReturnType<typeof loader>>;

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
  children?: ReactNode;
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

type ScheduleEntry = ScheduleWorkspace["entries"][number];
type ScheduleView = "room" | "list" | "day" | "week" | "track";
type ScheduleFetcher = ReturnType<typeof useFetcher<typeof action>>;
type StateSetter<T> = Dispatch<SetStateAction<T>>;

function ScheduleSourcePanel({
  workspace,
  fetcher,
  placementAvailable,
  quickSessionId,
  selectQuickSession,
  allPlacementSlots,
  quickStartsAt,
  setQuickStartsAt,
  quickRoomId,
  setQuickRoomId,
  quickDurationMinutes,
  setQuickDurationMinutes,
  quickSession,
  quickEntry,
  resourceInventory,
  visibleSessions,
  scheduledSessionIds,
  readOnlyPlacementMessage,
}: {
  workspace: SchedulePlannerWorkspaceData;
  fetcher: ScheduleFetcher;
  placementAvailable: boolean;
  quickSessionId: string;
  selectQuickSession(sessionId: string): void;
  allPlacementSlots: number[];
  quickStartsAt: number;
  setQuickStartsAt: StateSetter<number>;
  quickRoomId: string;
  setQuickRoomId: StateSetter<string>;
  quickDurationMinutes: number;
  setQuickDurationMinutes: StateSetter<number>;
  quickSession: ScheduleSession | undefined;
  quickEntry: ScheduleEntry | undefined;
  resourceInventory: string[];
  visibleSessions: ScheduleSession[];
  scheduledSessionIds: Set<string>;
  readOnlyPlacementMessage: string;
}) {
  return (
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
                quickSession ? quickStartsAt + quickDurationMinutes * 60 : ""
              }
            />
            <label className="label">
              Session
              <select
                className="select"
                name="sessionId"
                value={quickSessionId}
                onChange={(event) => selectQuickSession(event.target.value)}
              >
                {workspace.sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                    {scheduledSessionIds.has(session.id) ? " · scheduled" : ""}
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
            <input type="hidden" name="sessionId" value={quickSession.id} />
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
                  Configure resource inventory on at least one room in Event
                  Setup before assigning session requirements.
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
              No room resources are configured; this break will not reserve one.
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
  );
}

function ScheduleCanvasPanel({
  workspace,
  fetcher,
  view,
  selectedDay,
  eventDays,
  setSelectedDay,
  placementAvailable,
  moveInStandardCalendar,
  resize,
  selectQuickSession,
  trackGroups,
  sessionById,
  roomScrollRef,
  slots,
  entriesBySlot,
  unassign,
}: {
  workspace: SchedulePlannerWorkspaceData;
  fetcher: ScheduleFetcher;
  view: ScheduleView;
  selectedDay: number;
  eventDays: number[];
  setSelectedDay: StateSetter<number>;
  placementAvailable: boolean;
  moveInStandardCalendar(
    entry: ScheduleEntry,
    startsAt: number,
    endsAt: number,
  ): void;
  resize(entry: ScheduleEntry, durationMinutes: number): void;
  selectQuickSession(sessionId: string): void;
  trackGroups: Array<{ id: string | null; name: string }>;
  sessionById: Map<string, ScheduleSession>;
  roomScrollRef: RefObject<HTMLDivElement | null>;
  slots: number[];
  entriesBySlot: Map<string, ScheduleWorkspace["entries"]>;
  unassign(entry: ScheduleEntry): void;
}) {
  return (
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
                    sessionById.get(entry.sessionId)?.trackId === track.id,
                )
                .map((entry) => (
                  <p key={entry.id}>
                    <strong>
                      {dateLabel(entry.startsAt, workspace.event.timezone)} ·{" "}
                      {timeLabel(entry.startsAt, workspace.event.timezone)}
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
            <span aria-hidden>↔</span> Swipe horizontally to see every room
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
                              disabled={workspace.version?.status !== "draft"}
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
                                onResize={(minutes) => resize(entry, minutes)}
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
  );
}

function ScheduleValidationPanel({
  workspace,
  fetcher,
}: {
  workspace: SchedulePlannerWorkspaceData;
  fetcher: ScheduleFetcher;
}) {
  return (
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
              ["capacityAction", "Room capacity", workspace.policies.capacity],
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
  );
}

export function SchedulePlannerWorkspace({
  workspace,
}: {
  workspace: SchedulePlannerWorkspaceData;
}) {
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
          <ScheduleSourcePanel
            workspace={workspace}
            fetcher={fetcher}
            placementAvailable={placementAvailable}
            quickSessionId={quickSessionId}
            selectQuickSession={selectQuickSession}
            allPlacementSlots={allPlacementSlots}
            quickStartsAt={quickStartsAt}
            setQuickStartsAt={setQuickStartsAt}
            quickRoomId={quickRoomId}
            setQuickRoomId={setQuickRoomId}
            quickDurationMinutes={quickDurationMinutes}
            setQuickDurationMinutes={setQuickDurationMinutes}
            quickSession={quickSession}
            quickEntry={quickEntry}
            resourceInventory={resourceInventory}
            visibleSessions={visibleSessions}
            scheduledSessionIds={scheduledSessionIds}
            readOnlyPlacementMessage={readOnlyPlacementMessage}
          />
          <ScheduleCanvasPanel
            workspace={workspace}
            fetcher={fetcher}
            view={view}
            selectedDay={selectedDay}
            eventDays={eventDays}
            setSelectedDay={setSelectedDay}
            placementAvailable={placementAvailable}
            moveInStandardCalendar={moveInStandardCalendar}
            resize={resize}
            selectQuickSession={selectQuickSession}
            trackGroups={trackGroups}
            sessionById={sessionById}
            roomScrollRef={roomScrollRef}
            slots={slots}
            entriesBySlot={entriesBySlot}
            unassign={unassign}
          />
          <ScheduleValidationPanel workspace={workspace} fetcher={fetcher} />
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
