import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
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

/* The card is only as tall as the session is long, so each line has to be
   earned. Below these lengths the line would be clipped mid-stroke, which
   reads worse than not showing it. */
const MINUTES_FOR_TWO_LINE_TITLE = 45;
const MINUTES_FOR_TIME_LINE = 30;
const MINUTES_FOR_SPEAKER_LINE = 60;
const MINUTES_FOR_RESOURCE_LINE = 90;

function ScheduledEntryCard({
  entry,
  session,
  disabled,
  focused,
  revealed,
  conflictSeverity,
  timezone,
}: {
  entry: ScheduleEntry;
  session: ScheduleSession;
  disabled: boolean;
  focused: boolean;
  revealed: boolean;
  conflictSeverity: "warning" | "blocking" | undefined;
  timezone: string;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `entry:${entry.id}`,
      data: { sessionId: session.id },
      disabled,
    });
  const minutes = Math.round((entry.endsAt - entry.startsAt) / 60);
  const moveLabel = disabled
    ? session.title
    : `Move ${session.title}. Press Space, choose a destination with the arrow keys, then press Space again.`;
  const conflictLabel =
    conflictSeverity === "blocking"
      ? "Conflict"
      : conflictSeverity === "warning"
        ? "Check"
        : null;
  return (
    <button
      ref={setNodeRef}
      id={`schedule-session-${session.id}`}
      data-session-id={session.id}
      data-entry-id={entry.id}
      data-compact={minutes < MINUTES_FOR_TWO_LINE_TITLE ? "true" : undefined}
      type="button"
      className={`session-card ${session.format} schedule-entry-draggable${isDragging ? " dragging" : ""}${focused ? " focused" : ""}${revealed ? " revealed" : ""}${conflictSeverity ? ` conflict ${conflictSeverity}` : ""}`}
      style={{ transform: CSS.Translate.toString(transform) }}
      aria-label={
        conflictLabel
          ? `${moveLabel} ${conflictSeverity === "blocking" ? "This placement has a blocking conflict." : "This placement has a conflict warning."}`
          : moveLabel
      }
      {...listeners}
      {...attributes}
    >
      <strong>{session.title}</strong>
      {/* Duration is carried by the card's height; it is also written out so
          that it survives High Contrast Mode and a screen reader. */}
      {minutes >= MINUTES_FOR_TIME_LINE || conflictLabel ? (
        <small>
          {conflictLabel ? `${conflictLabel} · ` : ""}
          {timeLabel(entry.startsAt, timezone)} · {minutes} min
        </small>
      ) : null}
      {minutes >= MINUTES_FOR_SPEAKER_LINE && session.speakerNames.length ? (
        <small>{session.speakerNames.join(", ")}</small>
      ) : null}
      {minutes >= MINUTES_FOR_RESOURCE_LINE &&
      session.requiredResources.length ? (
        <small>{session.requiredResources.join(", ")}</small>
      ) : null}
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

/* The axis is event-local; the day tabs above it are UTC calendar
   boundaries. Naming the zone on the axis is what stops the two reading as a
   contradiction. */
function timezoneAbbreviation(epoch: number, timezone: string) {
  return (
    new Intl.DateTimeFormat("en", { timeZone: timezone, timeZoneName: "short" })
      .formatToParts(new Date(epoch * 1_000))
      .find((part) => part.type === "timeZoneName")?.value ?? timezone
  );
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
  conflictSeverityByEntryId,
  revealedEntryIds,
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
  conflictSeverityByEntryId: Map<string, "warning" | "blocking">;
  revealedEntryIds: string[];
}) {
  /* Whether the board overflows depends on the room count and the width the
     validation rail leaves behind, so the hint is measured rather than
     guessed at a breakpoint. */
  const [roomsOverflow, setRoomsOverflow] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: View and room-count changes deliberately trigger a new overflow measurement after layout.
  useEffect(() => {
    const scroll = roomScrollRef.current;
    if (!scroll) return;
    const update = () =>
      setRoomsOverflow(scroll.scrollWidth > scroll.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [roomScrollRef, view, workspace.rooms.length]);
  /* Only the formats actually on this day: a key listing formats nobody has
     placed is a legend for nothing. */
  const placedFormatKeys = new Set(
    [...entriesBySlot.values()]
      .flat()
      .map((entry) => sessionById.get(entry.sessionId)?.format)
      .filter((format): format is string => format !== undefined),
  );
  const placedFormats = workspace.sessionFormats.filter((format) =>
    placedFormatKeys.has(format.key),
  );
  const dayTabs = (
    <div className="tabs schedule-day-tabs" role="group" aria-label="Event day">
      {eventDays.map((day) => {
        const date = eventBoundaryCalendarDate(day);
        const entryCount = workspace.entries.filter(
          (entry) =>
            eventLocalCalendarDate(entry.startsAt, workspace.event.timezone) ===
            date,
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
  );
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
          {view === "day" ? dayTabs : null}
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
          {dayTabs}
          {placedFormats.length ? (
            <p className="schedule-format-key">
              {placedFormats.map((format) => (
                <span className={format.key} key={format.key}>
                  {format.label}
                </span>
              ))}
            </p>
          ) : null}
          {roomsOverflow ? (
            <p className="schedule-scroll-hint">
              <span aria-hidden>↔</span> Scroll sideways to see every room
            </p>
          ) : null}
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
              <div className="header corner">
                Time
                <small>
                  {timezoneAbbreviation(
                    slots[0] ?? selectedDay,
                    workspace.event.timezone,
                  )}
                </small>
              </div>
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
                      {entries.map((entry, index) => {
                        const session = sessionById.get(entry.sessionId);
                        if (!session) return null;
                        return (
                          <div
                            className="schedule-entry"
                            key={entry.id}
                            style={
                              {
                                /* Vertical distance is elapsed time: the card
                                   starts where the session starts and is as
                                   tall as the session is long. Two entries
                                   sharing a row split the width, so a room
                                   double-booking is visible before the
                                   server names it. */
                                "--pc-entry-offset": Math.max(
                                  0,
                                  Math.round((entry.startsAt - startsAt) / 60),
                                ),
                                "--pc-entry-minutes": Math.round(
                                  (entry.endsAt - entry.startsAt) / 60,
                                ),
                                "--pc-entry-column": index,
                                "--pc-entry-columns": entries.length,
                              } as CSSProperties
                            }
                          >
                            <ScheduledEntryCard
                              entry={entry}
                              session={session}
                              disabled={workspace.version?.status !== "draft"}
                              focused={
                                workspace.focusedSessionId === session.id
                              }
                              revealed={revealedEntryIds.includes(entry.id)}
                              conflictSeverity={conflictSeverityByEntryId.get(
                                entry.id,
                              )}
                              timezone={workspace.event.timezone}
                            />
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
