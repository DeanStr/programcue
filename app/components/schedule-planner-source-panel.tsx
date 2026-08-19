import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { EmptyState } from "~/components/ui/states";
import { requireValue } from "~/lib/required-value";
import { SessionCopyAction } from "~/modules/ai/contextual-ai-actions";
import type { ScheduleSession } from "~/modules/schedule/schedule-service.server";
import type {
  ScheduleEntry,
  ScheduleFetcher,
  SchedulePlannerWorkspaceData,
  StateSetter,
} from "./schedule-planner-panel-types";
import { sessionFormatLabel } from "./schedule-planner-workspace-helpers";

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

function DraggableSession({
  session,
  formatLabel,
  scheduled,
  focused,
  placementAvailable,
  readOnlyMessage,
}: {
  session: ScheduleSession;
  formatLabel: string;
  scheduled: boolean;
  focused: boolean;
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
      className={`schedule-session-source ${session.format}${isDragging ? " dragging" : ""}${focused ? " focused" : ""}${scheduled ? " is-placed" : ""}`}
      aria-current={focused ? "true" : undefined}
      aria-label={
        !scheduled && !placementAvailable
          ? `${session.title}. ${readOnlyMessage}`
          : undefined
      }
      style={{ transform: CSS.Translate.toString(transform) }}
      disabled={disabled}
      {...listeners}
      {...attributes}
    >
      <span className="schedule-session-source-format">{formatLabel}</span>
      <strong>{session.title}</strong>
      <small>
        {session.durationMinutes} min
        {session.speakerNames.length
          ? ` · ${session.speakerNames.join(", ")}`
          : ""}
      </small>
      {session.requiredResources.length ? (
        <small>Resources · {session.requiredResources.join(", ")}</small>
      ) : null}
    </button>
  );
}

export function ScheduleSourcePanel({
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
  resourceInventory,
  visibleSessions,
  scheduledSessionIds,
  readOnlyPlacementMessage,
  quickEntry,
  unassign,
  submitQuickPlacement,
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
  resourceInventory: string[];
  visibleSessions: ScheduleSession[];
  scheduledSessionIds: Set<string>;
  readOnlyPlacementMessage: string;
  quickEntry: ScheduleEntry | undefined;
  unassign(entry: ScheduleEntry): void;
  submitQuickPlacement(): void;
}) {
  const [placementFormOpen, setPlacementFormOpen] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessionQuery, setSessionQuery] = useState(
    searchParams.get("sourceQuery") ?? "",
  );
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (sessionQuery.trim()) next.set("sourceQuery", sessionQuery.trim());
      else next.delete("sourceQuery");
      if (next.toString() !== searchParams.toString())
        setSearchParams(next, { replace: true, preventScrollReset: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchParams, sessionQuery, setSearchParams]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only route navigation should synchronize URL state back into the input; depending on sessionQuery would erase each keystroke before the debounced URL update.
  useEffect(() => {
    const routeQuery = searchParams.get("sourceQuery") ?? "";
    if (routeQuery !== sessionQuery) setSessionQuery(routeQuery);
  }, [searchParams]);
  const normalisedSessionQuery = sessionQuery.trim().toLocaleLowerCase();
  const matchesSessionQuery = (session: ScheduleSession) =>
    !normalisedSessionQuery ||
    [
      session.title,
      session.speakerNames.join(" "),
      session.trackName,
      session.format,
      session.status,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalisedSessionQuery);
  const matchingWorkspaceSessions =
    workspace.sessions.filter(matchesSessionQuery);
  const selectedOutsideQuery = workspace.sessions.find(
    (session) => session.id === quickSessionId && !matchesSessionQuery(session),
  );
  const sessionOptions = selectedOutsideQuery
    ? [selectedOutsideQuery, ...matchingWorkspaceSessions]
    : matchingWorkspaceSessions;
  const matchingVisibleSessions = visibleSessions.filter(matchesSessionQuery);
  const unscheduledSessions = matchingVisibleSessions.filter(
    (session) => !scheduledSessionIds.has(session.id),
  );
  const placedSessions = matchingVisibleSessions.filter((session) =>
    scheduledSessionIds.has(session.id),
  );
  const unscheduledCount = workspace.sessions.filter(
    (session) => !scheduledSessionIds.has(session.id),
  ).length;
  return (
    <aside
      aria-labelledby="schedule-source-heading"
      className="schedule-source"
    >
      <div className="schedule-inbox-head">
        <h2 id="schedule-source-heading" tabIndex={-1}>
          Sessions
        </h2>
        <p className="schedule-inbox-count">{unscheduledCount} to place</p>
      </div>
      <div className="schedule-inbox-tools">
        {placementAvailable &&
        workspace.sessions.length &&
        workspace.rooms.length ? (
          <details
            className="pc-disclosure"
            open={placementFormOpen}
            onToggle={(event) => setPlacementFormOpen(event.currentTarget.open)}
          >
            <summary>
              <strong>Place or move with form</strong>
              <span className="help">
                Keyboard alternative across every event day
              </span>
            </summary>
            <fetcher.Form
              method="post"
              className="stack mt"
              onSubmit={(event) => {
                event.preventDefault();
                submitQuickPlacement();
              }}
            >
              <input type="hidden" name="intent" value="place" />
              <input
                type="hidden"
                name="scheduleVersionId"
                value={
                  requireValue(
                    workspace.version,
                    "Required workspace.version is unavailable.",
                  ).id
                }
              />
              <input
                type="hidden"
                name="scheduleRevision"
                value={
                  requireValue(
                    workspace.version,
                    "Required workspace.version is unavailable.",
                  ).revision
                }
              />
              {workspace.sessions.length > 15 || sessionQuery.trim() ? (
                <label className="label">
                  Find session
                  <input
                    className="field"
                    type="search"
                    value={sessionQuery}
                    onChange={(event) =>
                      setSessionQuery(event.currentTarget.value)
                    }
                    placeholder="Title, speaker, track, format or status"
                    autoComplete="off"
                  />
                  <span className="help" role="status">
                    {matchingWorkspaceSessions.length} of{" "}
                    {workspace.sessions.length} sessions match.
                  </span>
                </label>
              ) : null}
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
                  {sessionOptions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title} ·{" "}
                      {session.speakerNames.join(", ") || "No speaker"} ·{" "}
                      {session.trackName ?? "No track"}
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
                  quickDurationMinutes > 480 ||
                  fetcher.state !== "idle"
                }
              >
                {scheduledSessionIds.has(quickSessionId)
                  ? "Move or resize session"
                  : "Place session"}
              </button>
              {/* The board card used to carry its own slider and unassign
                button. Both blew the cell open and gave the same operation a
                third mental model; the form already names the session it is
                acting on. */}
              {quickEntry ? (
                <button
                  className="btn small"
                  type="button"
                  onClick={() => unassign(quickEntry)}
                  disabled={fetcher.state !== "idle"}
                >
                  Unassign from the board
                </button>
              ) : null}
            </fetcher.Form>
          </details>
        ) : null}
        {quickSession ? (
          <details className="pc-disclosure">
            <summary>
              <strong>Draft AI copy</strong>
              <span className="help">Public description only</span>
            </summary>
            <SessionCopyAction
              sessionId={quickSession.id}
              key={`ai-copy-${quickSession.id}`}
            />
          </details>
        ) : null}
        {placementAvailable && quickSession ? (
          <details
            className="pc-disclosure"
            key={`resources-${quickSession.id}`}
          >
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
                value={
                  requireValue(
                    workspace.version,
                    "Required workspace.version is unavailable.",
                  ).id
                }
              />
              <input
                type="hidden"
                name="scheduleRevision"
                value={
                  requireValue(
                    workspace.version,
                    "Required workspace.version is unavailable.",
                  ).revision
                }
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
                    settings before assigning session requirements.
                  </span>
                  <Link className="btn small" to="/admin/event">
                    Open Event settings
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
        <details className="pc-disclosure">
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
              <fieldset className="stack pc-plain-fieldset">
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
                No room resources are configured; this break will not reserve
                one.
              </p>
            )}
            <button className="btn" type="submit">
              Create unscheduled break
            </button>
          </fetcher.Form>
        </details>
      </div>
      <div className="schedule-inbox-list">
        {unscheduledSessions.map((session) => (
          <DraggableSession
            key={session.id}
            session={session}
            formatLabel={sessionFormatLabel(
              workspace.sessionFormats,
              session.format,
            )}
            scheduled={false}
            focused={workspace.focusedSessionId === session.id}
            placementAvailable={placementAvailable}
            readOnlyMessage={readOnlyPlacementMessage}
          />
        ))}
        {placedSessions.length ? (
          <p className="schedule-inbox-group">
            Placed · {placedSessions.length}
          </p>
        ) : null}
        {placedSessions.map((session) => (
          <DraggableSession
            key={session.id}
            session={session}
            formatLabel={sessionFormatLabel(
              workspace.sessionFormats,
              session.format,
            )}
            scheduled
            focused={workspace.focusedSessionId === session.id}
            placementAvailable={placementAvailable}
            readOnlyMessage={readOnlyPlacementMessage}
          />
        ))}
        {matchingVisibleSessions.length === 0 ? (
          <EmptyState
            title={
              workspace.activeFilter || normalisedSessionQuery
                ? "No matching sessions"
                : "No sessions yet"
            }
            description={
              workspace.activeFilter || normalisedSessionQuery
                ? "No sessions match the current source filters."
                : "Accepted and direct sessions will appear here."
            }
          />
        ) : null}
      </div>
    </aside>
  );
}
