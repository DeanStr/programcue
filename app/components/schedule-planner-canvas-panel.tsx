import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useState, type ReactNode, type RefObject } from "react";
import { ScheduleStandardCalendar } from "~/components/schedule-standard-calendar";
import type {
  ScheduleSession,
  ScheduleWorkspace,
} from "~/modules/schedule/schedule-service.server";
import {
  eventBoundaryCalendarDate,
  eventLocalCalendarDate,
} from "~/modules/schedule/schedule-time";
import type {
  ScheduleEntry,
  ScheduleFetcher,
  SchedulePlannerWorkspaceData,
  ScheduleView,
  StateSetter,
} from "./schedule-planner-panel-types";

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

export function ScheduleCanvasPanel({
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
