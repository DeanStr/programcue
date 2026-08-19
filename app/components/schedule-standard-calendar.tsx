import FullCalendar, {
  type EventDropInfo,
  type EventResizeDoneInfo,
} from "@fullcalendar/react";
import interactionPlugin from "@fullcalendar/react/interaction";
import listPlugin from "@fullcalendar/react/list";
import breezyTheme from "@fullcalendar/react/themes/breezy";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/breezy/theme.css";
import "@fullcalendar/react/themes/breezy/palettes/indigo.css";

import type { ScheduleWorkspace } from "~/modules/schedule/schedule-service.server";
import { sessionFormatLabel } from "./schedule-planner-workspace-helpers";

type StandardScheduleView = "list" | "day" | "week";

type StandardScheduleEventContent = {
  event: { title: string };
  timeText: string;
  timeClass: string;
  titleClass: string;
  formatLabel?: string;
  speaker?: string;
  roomName?: string;
};

export function ScheduleStandardEventContent({
  event,
  timeText,
  timeClass,
  titleClass,
  formatLabel,
  speaker,
  roomName,
}: StandardScheduleEventContent) {
  return (
    <div className="schedule-standard-event-content">
      {formatLabel ? (
        <span className="schedule-standard-event-format">{formatLabel}</span>
      ) : null}
      {timeText ? (
        <span
          className={`schedule-standard-event-time${timeClass ? ` ${timeClass}` : ""}`}
        >
          {timeText}
        </span>
      ) : null}
      <span
        className={`schedule-standard-event-title${titleClass ? ` ${titleClass}` : ""}`}
      >
        {event.title || "\u00a0"}
      </span>
      {speaker || roomName ? (
        <span className="schedule-standard-event-meta">
          {[speaker, roomName].filter(Boolean).join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

function calendarDate(epoch: number) {
  return new Date(epoch * 1_000).toISOString().slice(0, 10);
}

export function scheduleStandardFirstDay(epoch: number) {
  return new Date(`${calendarDate(epoch)}T12:00:00Z`).getUTCDay();
}

export function scheduleStandardChangedTimes(
  info: EventDropInfo | EventResizeDoneInfo,
  entryById: Map<string, ScheduleWorkspace["entries"][number]>,
): {
  entry: ScheduleWorkspace["entries"][number];
  startsAt: number;
  endsAt: number;
} | null {
  const entry = entryById.get(info.event.id);
  const start = info.event.start;
  const end = info.event.end;
  const startsAt = start ? Math.floor(start.getTime() / 1_000) : null;
  const endsAt = end ? Math.floor(end.getTime() / 1_000) : null;
  if (!entry || startsAt === null || endsAt === null || endsAt <= startsAt) {
    info.revert();
    return null;
  }
  return { entry, startsAt, endsAt };
}

export function ScheduleStandardCalendar({
  workspace,
  view,
  selectedDay,
  placementAvailable,
  busy,
  onMove,
  onResize,
  onSelectSession,
}: {
  workspace: ScheduleWorkspace;
  view: StandardScheduleView;
  selectedDay: number;
  placementAvailable: boolean;
  busy: boolean;
  onMove: (
    entry: ScheduleWorkspace["entries"][number],
    startsAt: number,
    endsAt: number,
  ) => void;
  onResize: (
    entry: ScheduleWorkspace["entries"][number],
    durationMinutes: number,
  ) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const sessionById = new Map(
    workspace.sessions.map((session) => [session.id, session]),
  );
  const roomById = new Map(workspace.rooms.map((room) => [room.id, room]));
  const entryById = new Map(
    workspace.entries.map((entry) => [entry.id, entry]),
  );
  const events = workspace.entries.map((entry) => {
    const session = sessionById.get(entry.sessionId);
    const room = roomById.get(entry.roomId);
    if (!session) {
      throw new Error(
        `Schedule entry ${entry.id} references an unavailable session.`,
      );
    }
    if (!room) {
      throw new Error(
        `Schedule entry ${entry.id} references an unavailable room.`,
      );
    }
    return {
      id: entry.id,
      title: session.title,
      start: new Date(entry.startsAt * 1_000).toISOString(),
      end: new Date(entry.endsAt * 1_000).toISOString(),
      classNames: ["schedule-fc-event", session.format],
      extendedProps: {
        sessionId: entry.sessionId,
        format: session.format,
        formatLabel: sessionFormatLabel(
          workspace.sessionFormats,
          session.format,
        ),
        speaker: session.speakerNames.join(", "),
        roomName: room.name,
      },
    };
  });

  return (
    <section
      className={`schedule-standard-calendar schedule-standard-calendar-${view}`}
      data-schedule-standard-view={view}
      aria-label={`${view} schedule calendar`}
    >
      <div
        className="schedule-standard-scroll-frame"
        tabIndex={view === "list" ? undefined : 0}
        aria-describedby={
          view === "list" ? undefined : "schedule-standard-scroll-help"
        }
      >
        <div
          className={`schedule-standard-calendar-width schedule-standard-calendar-width-${view}`}
        >
          <FullCalendar
            key={`${view}:${selectedDay}:${workspace.version?.id ?? "none"}`}
            plugins={[
              breezyTheme,
              interactionPlugin,
              listPlugin,
              timeGridPlugin,
            ]}
            initialView={
              view === "list"
                ? "listWeek"
                : view === "day"
                  ? "timeGridDay"
                  : "timeGridWeek"
            }
            initialDate={calendarDate(selectedDay)}
            firstDay={scheduleStandardFirstDay(workspace.event.startsAt)}
            timeZone={workspace.event.timezone}
            validRange={{
              start: calendarDate(workspace.event.startsAt),
              end: calendarDate(workspace.event.endsAt + 86_400),
            }}
            events={events}
            editable={placementAvailable && !busy && view !== "list"}
            eventStartEditable={placementAvailable && !busy && view !== "list"}
            eventDurationEditable={
              placementAvailable && !busy && view !== "list"
            }
            eventResizableFromStart={false}
            allDaySlot={false}
            nowIndicator
            height={view === "list" ? "auto" : 720}
            slotDuration="00:15:00"
            snapDuration="00:05:00"
            scrollTime="07:00:00"
            headerToolbar={{
              left:
                view === "day"
                  ? ""
                  : view === "week"
                    ? "prev,next title"
                    : "prev,next",
              center: view === "week" ? "" : "title",
              right: "",
            }}
            eventTimeFormat={{ hour: "numeric", minute: "2-digit" }}
            eventContent={(arg) => (
              <ScheduleStandardEventContent
                event={arg.event}
                timeText={arg.timeText}
                timeClass=""
                titleClass=""
                formatLabel={String(arg.event.extendedProps.formatLabel ?? "")}
                speaker={String(arg.event.extendedProps.speaker ?? "")}
                roomName={String(arg.event.extendedProps.roomName ?? "")}
              />
            )}
            noEventsContent="No sessions are placed in this period."
            eventClick={(info) => {
              const sessionId = String(
                info.event.extendedProps.sessionId ?? "",
              );
              if (sessionId) onSelectSession(sessionId);
            }}
            eventDrop={(info) => {
              const changed = scheduleStandardChangedTimes(info, entryById);
              if (changed)
                onMove(changed.entry, changed.startsAt, changed.endsAt);
            }}
            eventResize={(info) => {
              const changed = scheduleStandardChangedTimes(info, entryById);
              if (!changed) return;
              const durationMinutes = (changed.endsAt - changed.startsAt) / 60;
              if (
                Number.isInteger(durationMinutes) &&
                durationMinutes >= 5 &&
                durationMinutes <= 480
              ) {
                onResize(changed.entry, durationMinutes);
              } else {
                info.revert();
              }
            }}
          />
        </div>
      </div>
      {view !== "list" ? (
        <p
          className="help mt schedule-standard-scroll-hint"
          id="schedule-standard-scroll-help"
        >
          Swipe, scroll, or use the arrow keys to inspect the full {view} view.
          Choose List for a compact keyboard-friendly view.
        </p>
      ) : null}
      {placementAvailable && view !== "list" ? (
        <p className="help mt">
          Drag to change time or day, or drag an event’s lower edge to resize.
          Changes appear immediately, then roll back if authoritative server
          validation rejects them. Use “Place or move with form” for a complete
          keyboard alternative, including room changes.
        </p>
      ) : null}
    </section>
  );
}
