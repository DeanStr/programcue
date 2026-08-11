import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";

import { Dialog } from "~/components/dialog";
import { ScheduleContentWorkflows } from "~/components/schedule-content-workflows";
import type { ScheduleWorkspace } from "~/modules/schedule/schedule-service.server";
import {
  eventBoundaryCalendarDate,
  eventCalendarDayBoundaries,
  eventDayScheduleSlots,
  eventLocalCalendarDate,
  eventLocalTimeEpoch,
} from "~/modules/schedule/schedule-time";
import type { action } from "~/routes/schedule-planner.server";
import { ScheduleCanvasPanel } from "./schedule-planner-canvas-panel";
import { ScheduleSourcePanel } from "./schedule-planner-source-panel";
import { ScheduleValidationPanel } from "./schedule-planner-validation-panel";
import type { SchedulePlannerWorkspaceData } from "./schedule-planner-panel-types";

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
