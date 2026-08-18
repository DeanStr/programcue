import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useState,
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
import {
  isHourMark,
  sessionFormatLabel,
} from "./schedule-planner-workspace-helpers";

/* The card is only as tall as the session is long, so each line has to be
   earned. Below these lengths the line would be clipped mid-stroke, which
   reads worse than not showing it. */
const MINUTES_FOR_SPEAKER_LINE = 60;
const MINUTES_FOR_RESOURCE_LINE = 90;

function ScheduledEntryCard({
  entry,
  session,
  formatLabel,
  disabled,
  focused,
  revealed,
  conflictSeverity,
  timezone,
}: {
  entry: ScheduleEntry;
  session: ScheduleSession;
  formatLabel: string;
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
      data-compact={minutes < 30 ? "true" : undefined}
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
      {minutes >= MINUTES_FOR_SPEAKER_LINE ? (
        <span className="session-card-format">{formatLabel}</span>
      ) : null}
      <strong>{session.title}</strong>
      {/* Duration is carried by the card's height. Time is written on
          60-minute cells so a 45-minute name can use both lines. */}
      {conflictLabel || minutes >= MINUTES_FOR_SPEAKER_LINE ? (
        <small className="session-card-time">
          {conflictLabel ? `${conflictLabel} · ` : ""}
          {timeLabel(entry.startsAt, timezone)} · {minutes} min
        </small>
      ) : null}
      {minutes >= MINUTES_FOR_SPEAKER_LINE && session.speakerNames.length ? (
        <small className="session-card-speaker">
          {session.speakerNames.join(", ")}
        </small>
      ) : null}
      {minutes >= MINUTES_FOR_RESOURCE_LINE &&
      session.requiredResources.length ? (
        <small className="session-card-resource">
          {session.requiredResources.join(", ")}
        </small>
      ) : null}
    </button>
  );
}

function ScheduleCell({
  roomId,
  startsAt,
  hour,
  children,
}: {
  roomId: string;
  startsAt: number;
  hour?: boolean;
  children?: ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `slot:${roomId}:${startsAt}`,
    data: { roomId, startsAt },
  });
  return (
    <div
      ref={setNodeRef}
      className={`schedule-drop${isOver ? " is-over" : ""}${hour ? " is-hour" : ""}`}
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

function weekdayShort(epoch: number) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(epoch * 1_000));
}

export function ScheduleCanvasPanel({
  workspace,
  fetcher,
  view,
  setView,
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
  setView: StateSetter<ScheduleView>;
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
  const roomScrollSignature = `${view}:${selectedDay}:${entriesBySlot.size}`;
  useEffect(() => {
    const scroll = roomScrollRef.current;
    if (!scroll || view !== "room") return;
    void roomScrollSignature;
    const first = scroll.querySelector(".schedule-entry");
    if (!(first instanceof HTMLElement)) return;
    const nextTop =
      first.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top +
      scroll.scrollTop -
      72;
    scroll.scrollTop = Math.max(0, nextTop);
  }, [roomScrollRef, roomScrollSignature, view]);
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
    <fieldset
      className="tabs schedule-day-tabs pc-plain-fieldset"
      aria-label="Event day"
    >
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
            <span className="schedule-day-long">{dateLabel(day, "UTC")}</span>
            <span className="schedule-day-short">{weekdayShort(day)}</span>
            <small>{entryCount} placed</small>
          </button>
        );
      })}
    </fieldset>
  );
  return (
    <section className="schedule-canvas">
      <div className="schedule-canvas-toolbar">
        <div>
          <h2>
            {view === "room"
              ? `${dateLabel(selectedDay, "UTC")} · Room view`
              : `${view[0].toUpperCase() + view.slice(1)} view`}
          </h2>
        </div>
        <fieldset
          className="tabs schedule-view-tabs pc-plain-fieldset"
          aria-label="Schedule view"
        >
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
        </fieldset>
        {view === "room" || view === "day" ? dayTabs : null}
      </div>
      {view === "list" || view === "day" || view === "week" ? (
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
      ) : view === "track" ? (
        <div className="grid grid-2 schedule-track-view">
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
          <div className="schedule-canvas-meta">
            {placedFormats.length ? (
              <p className="schedule-format-key">
                {placedFormats.map((format) => (
                  <span className={format.key} key={format.key}>
                    {format.label}
                  </span>
                ))}
              </p>
            ) : (
              <span />
            )}
            <p
              className={`schedule-scroll-hint${roomsOverflow ? " is-visible" : ""}`}
            >
              <span aria-hidden>↔</span> Scroll sideways to see every room
            </p>
          </div>
          <ol className="schedule-agenda">
            {workspace.entries
              .filter(
                (entry) =>
                  eventLocalCalendarDate(
                    entry.startsAt,
                    workspace.event.timezone,
                  ) === eventBoundaryCalendarDate(selectedDay),
              )
              .map((entry) => {
                const session = sessionById.get(entry.sessionId);
                const room = workspace.rooms.find(
                  (item) => item.id === entry.roomId,
                );
                if (!session) return null;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`schedule-agenda-item ${session.format}`}
                      onClick={() => selectQuickSession(session.id)}
                    >
                      <time>
                        {timeLabel(entry.startsAt, workspace.event.timezone)}
                      </time>
                      <strong>{session.title}</strong>
                      <small>
                        {room?.name ?? "Room"}
                        {session.speakerNames.length
                          ? ` · ${session.speakerNames.join(", ")}`
                          : ""}
                      </small>
                    </button>
                  </li>
                );
              })}
          </ol>
          <div
            className={`schedule-room-frame${roomsOverflow ? " is-overflowing" : ""}`}
          >
            <section
              ref={roomScrollRef}
              className="schedule-room-scroll"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
              tabIndex={0}
              aria-label={`${dateLabel(selectedDay, "UTC")} room schedule. Scroll horizontally to see every room.`}
            >
              <div
                className="schedule-room-board"
                style={{
                  gridTemplateColumns: `4.5rem repeat(${workspace.rooms.length}, minmax(120px, 1fr))`,
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
                {slots.flatMap((startsAt) => {
                  const hour = isHourMark(startsAt, workspace.event.timezone);
                  return [
                    <div
                      className={`time${hour ? " is-hour" : ""}`}
                      key={`time:${startsAt}`}
                    >
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
                          hour={hour}
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
                                      Math.round(
                                        (entry.startsAt - startsAt) / 60,
                                      ),
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
                                  formatLabel={sessionFormatLabel(
                                    workspace.sessionFormats,
                                    session.format,
                                  )}
                                  disabled={
                                    workspace.version?.status !== "draft"
                                  }
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
                  ];
                })}
              </div>
            </section>
          </div>
        </>
      )}
    </section>
  );
}
