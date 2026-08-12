import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "react-router";
import { EmptyState } from "~/components/ui/states";
import { SessionCopyAction } from "~/modules/ai/contextual-ai-actions";
import type { ScheduleSession } from "~/modules/schedule/schedule-service.server";
import type {
  ScheduleFetcher,
  SchedulePlannerWorkspaceData,
  StateSetter,
} from "./schedule-planner-panel-types";

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
}) {
  return (
    <aside className="card pad schedule-source">
      <div className="card-title">
        <h2>Sessions</h2>
      </div>
      {placementAvailable &&
      workspace.sessions.length &&
      workspace.rooms.length ? (
        <details className="mb pc-disclosure">
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
        <details
          className="mb pc-disclosure"
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
      <details className="mb pc-disclosure">
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
          <EmptyState
            title={
              workspace.activeFilter
                ? "No matching sessions"
                : "No sessions yet"
            }
            description={
              workspace.activeFilter
                ? "No sessions match this operational filter."
                : "Accepted and direct sessions will appear here."
            }
          />
        ) : null}
      </div>
    </aside>
  );
}
