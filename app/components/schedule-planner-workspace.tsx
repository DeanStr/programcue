import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";

import { Dialog } from "~/components/dialog";
import { ScheduleContentWorkflows } from "~/components/schedule-content-workflows";
import type {
  AutoPlacementPreview,
  AutoPlacementUnplaced,
} from "~/modules/schedule/schedule-auto-placement";
import type { ScheduleWorkspace } from "~/modules/schedule/schedule-service.server";
import {
  eventBoundaryCalendarDate,
  eventCalendarDayBoundaries,
  eventDayScheduleSlots,
  eventDayUsableScheduleSlots,
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

function scheduleDateTimeLabel(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

type AutoPlacementResultNotice = {
  appliedCount: number;
  unplacedCount: number;
  unplaced: AutoPlacementUnplaced[];
  warning: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAutoPlacementUnplaced(
  value: unknown,
): value is AutoPlacementUnplaced {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.reason === "string" &&
    value.reason.length > 0
  );
}

function isAutoPlacementPreview(value: unknown): value is AutoPlacementPreview {
  if (!isRecord(value)) return false;
  if (
    typeof value.idempotencyKey !== "string" ||
    typeof value.scheduleVersionId !== "string" ||
    !isPositiveSafeInteger(value.scheduleRevision) ||
    !isPositiveSafeInteger(value.eventRevision) ||
    !isPositiveSafeInteger(value.policyRevision) ||
    !Array.isArray(value.sessionRevisions) ||
    !Array.isArray(value.placements) ||
    !Array.isArray(value.unplaced)
  ) {
    return false;
  }
  if (
    !value.sessionRevisions.every(
      (revision) =>
        isRecord(revision) &&
        typeof revision.sessionId === "string" &&
        revision.sessionId.length > 0 &&
        isPositiveSafeInteger(revision.revision),
    )
  ) {
    return false;
  }
  if (!value.unplaced.every(isAutoPlacementUnplaced)) return false;
  return value.placements.every((placement) => {
    if (!isRecord(placement)) return false;
    if (
      typeof placement.sessionId !== "string" ||
      placement.sessionId.length === 0 ||
      typeof placement.roomId !== "string" ||
      placement.roomId.length === 0 ||
      !isPositiveSafeInteger(placement.startsAt) ||
      !isPositiveSafeInteger(placement.endsAt) ||
      placement.endsAt <= placement.startsAt ||
      !Array.isArray(placement.warnings)
    ) {
      return false;
    }
    return placement.warnings.every(
      (warning) =>
        isRecord(warning) &&
        typeof warning.type === "string" &&
        (warning.severity === "warning" || warning.severity === "blocking") &&
        typeof warning.message === "string" &&
        (warning.conflictingEntryId === undefined ||
          typeof warning.conflictingEntryId === "string"),
    );
  });
}

type AutoPlacementConfirmation = {
  committed: true;
  appliedCount: number;
  scheduleRevision: number;
  unplacedCount: number;
  warning: string | null;
};

function isAutoPlacementConfirmation(
  value: unknown,
): value is AutoPlacementConfirmation {
  return (
    isRecord(value) &&
    value.committed === true &&
    isNonNegativeSafeInteger(value.appliedCount) &&
    isPositiveSafeInteger(value.scheduleRevision) &&
    isNonNegativeSafeInteger(value.unplacedCount) &&
    (value.warning === null ||
      (typeof value.warning === "string" && value.warning.length > 0))
  );
}

function autoPlacementResponseError(result: Record<string, unknown>) {
  return typeof result.error === "string" && result.error.length > 0
    ? result.error
    : "Auto-place returned an invalid response. Refresh and try again.";
}

function serializeAutoPlacementPreview(preview: AutoPlacementPreview) {
  const payload = JSON.stringify({
    ...preview,
    placements: preview.placements.map(
      ({ sessionId, roomId, startsAt, endsAt }) => ({
        sessionId,
        roomId,
        startsAt,
        endsAt,
      }),
    ),
  });
  if (payload === undefined) {
    throw new Error("The auto-place preview could not be serialized.");
  }
  return payload;
}

export function SchedulePlannerWorkspace({
  workspace,
}: {
  workspace: SchedulePlannerWorkspaceData;
}) {
  const fetcher = useFetcher<typeof action>();
  const autoPlacementFetcher = useFetcher<typeof action>();
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
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(
    null,
  );
  const [autoPreview, setAutoPreview] = useState<AutoPlacementPreview | null>(
    null,
  );
  const [autoResult, setAutoResult] =
    useState<AutoPlacementResultNotice | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
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
  const contentReviewAdvisories = useMemo(
    () =>
      workspace.entries.flatMap((entry) => {
        const session = sessionById.get(entry.sessionId);
        return session && session.contentStatus !== "approved"
          ? [session]
          : [];
      }),
    [sessionById, workspace.entries],
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
    (session) =>
      session.status === "unscheduled" && !scheduledSessionIds.has(session.id),
  );
  const allPlacementSlots = useMemo(
    () =>
      eventDays.flatMap((eventDay) =>
        eventDayUsableScheduleSlots(eventDay, workspace.event.timezone),
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

  const autoActionResult = autoPlacementFetcher.data;
  useEffect(() => {
    if (autoActionResult === undefined) return;
    if (!isRecord(autoActionResult)) {
      setAutoPreview(null);
      setAutoResult(null);
      setAutoError(
        "Auto-place returned an invalid response. Refresh and try again.",
      );
      return;
    }
    const result = autoActionResult as unknown as Record<string, unknown>;
    if (result.intent === "auto-place-preview") {
      if (isAutoPlacementPreview(result.autoPreview)) {
        setAutoPreview(result.autoPreview);
        setAutoResult(null);
        setAutoError(null);
      } else {
        setAutoPreview(null);
        setAutoResult(null);
        setAutoError(autoPlacementResponseError(result));
      }
      return;
    }
    if (result.intent === "auto-place-confirm") {
      if (isAutoPlacementConfirmation(result)) {
        setAutoResult({
          appliedCount: result.appliedCount,
          unplacedCount: result.unplacedCount,
          unplaced: autoPreview?.unplaced ?? [],
          warning: result.warning,
        });
        setAutoPreview(null);
        setAutoError(null);
        return;
      }
      setAutoPreview(null);
      setAutoResult(null);
      setAutoError(autoPlacementResponseError(result));
      return;
    }
    setAutoPreview(null);
    setAutoResult(null);
    setAutoError(autoPlacementResponseError(result));
  }, [autoActionResult]);

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

  function sessionLabel(active: { data: { current?: Record<string, unknown> } }) {
    const sessionId = String(active.data.current?.sessionId ?? "");
    return sessionById.get(sessionId)?.title ?? "this session";
  }

  function slotLabel(over: { data: { current?: Record<string, unknown> } }) {
    const roomId = String(over.data.current?.roomId ?? "");
    const startsAt = Number(over.data.current?.startsAt);
    const room = workspace.rooms.find((candidate) => candidate.id === roomId);
    if (!room || !startsAt) return "that slot";
    return `${room.name} at ${scheduleDateTimeLabel(startsAt, workspace.event.timezone)}`;
  }

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
  const autoPlacementPayload = autoPreview
    ? serializeAutoPlacementPreview(autoPreview)
    : undefined;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Schedule Planner</h1>
          <p>Build and publish a conflict-checked programme.</p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            type="button"
            disabled={
              !placementAvailable ||
              unscheduledSessions.length === 0 ||
              autoPlacementFetcher.state !== "idle"
            }
            title={
              !workspace.version
                ? "Create a draft schedule before auto-placing sessions."
                : workspace.version.status !== "draft"
                  ? "Create the next draft before auto-placing sessions."
                  : unscheduledSessions.length === 0
                    ? "There are no unscheduled sessions to place."
                    : undefined
            }
            onClick={() => {
              setAutoError(null);
              setAutoResult(null);
              autoPlacementFetcher.submit(
                { intent: "auto-place-preview" },
                { method: "post" },
              );
            }}
          >
            {autoPlacementFetcher.state === "idle"
              ? "Auto-place unscheduled sessions"
              : "Preparing auto-place preview…"}
          </button>
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
      {autoError ? (
        <div className="validation-item error mb" role="alert">
          <strong>Auto-place blocked</strong>
          <span>{autoError}</span>
        </div>
      ) : null}
      {autoResult ? (
        <div
          className={`validation-item ${autoResult.warning || autoResult.unplacedCount ? "warn" : "ok"} mb`}
          role="status"
        >
          <strong>
            Auto-place applied {autoResult.appliedCount} placement
            {autoResult.appliedCount === 1 ? "" : "s"}.
          </strong>
          <span>The draft schedule was refreshed and was not published.</span>
          {autoResult.warning ? <span>{autoResult.warning}</span> : null}
          {autoResult.unplacedCount ? (
            <>
              <span>
                {autoResult.unplacedCount} session
                {autoResult.unplacedCount === 1 ? " remains" : "s remain"} in
                the source list.
              </span>
              {autoResult.unplaced.length ? (
                <div
                  className="stack"
                  data-testid="auto-placement-confirmed-unplaced"
                >
                  <strong>Unplaced reasons</strong>
                  {autoResult.unplaced.map((item) => (
                    <span key={item.sessionId}>
                      {sessionById.get(item.sessionId)?.title ?? item.sessionId}
                      : {item.reason}
                    </span>
                  ))}
                </div>
              ) : (
                <span>
                  Prepare a fresh preview to review the blocking reasons.
                </span>
              )}
            </>
          ) : null}
        </div>
      ) : null}
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
        accessibility={{
          screenReaderInstructions: {
            draggable:
              "Press space or enter to pick up this session. Use the arrow keys to move it between rooms and times, space or enter to place it, and escape to cancel.",
          },
          /* dnd-kit's defaults read the raw identifiers aloud, so a keyboard
             user heard "slot:room-301a:1747742400" rather than a room and a
             time. */
          announcements: {
            onDragStart: ({ active }) => `Picked up ${sessionLabel(active)}.`,
            onDragOver: ({ over }) =>
              over ? `Over ${slotLabel(over)}.` : "Not over a placement slot.",
            onDragEnd: ({ active, over }) =>
              over
                ? `Placed ${sessionLabel(active)} in ${slotLabel(over)}.`
                : `${sessionLabel(active)} was not placed.`,
            onDragCancel: ({ active }) =>
              `Cancelled. ${sessionLabel(active)} was not moved.`,
          },
        }}
        onDragStart={(event: DragStartEvent) =>
          setDraggingSessionId(
            String(event.active.data.current?.sessionId ?? ""),
          )
        }
        onDragCancel={() => setDraggingSessionId(null)}
        onDragEnd={(event) => {
          setDraggingSessionId(null);
          place(event);
        }}
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
        {/* Rendered in a portal above both panes. Without it the dragged card
            is clipped the moment it leaves the source list, which has
            overflow:auto, on its way to a board with overflow:hidden. */}
        <DragOverlay dropAnimation={null}>
          {draggingSessionId ? (
            <div className="session-card is-dragging">
              <strong>
                {sessionById.get(draggingSessionId)?.title ?? "Session"}
              </strong>
              <small>
                {sessionById.get(draggingSessionId)?.durationMinutes ?? 0} min
              </small>
            </div>
          ) : null}
        </DragOverlay>
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
      {autoPreview ? (
        <Dialog
          title="Preview auto-placement"
          onClose={() => {
            if (autoPlacementFetcher.state === "idle") setAutoPreview(null);
          }}
          footer={
            <>
              <button
                className="btn"
                type="button"
                disabled={autoPlacementFetcher.state !== "idle"}
                onClick={() => setAutoPreview(null)}
              >
                Cancel
              </button>
              <autoPlacementFetcher.Form
                method="post"
                onSubmit={() => setAutoError(null)}
              >
                <input type="hidden" name="intent" value="auto-place-confirm" />
                <input
                  type="hidden"
                  name="proposal"
                  value={autoPlacementPayload}
                />
                <button
                  className="btn primary"
                  type="submit"
                  disabled={
                    autoPreview.placements.length === 0 ||
                    autoPlacementFetcher.state !== "idle"
                  }
                >
                  {autoPlacementFetcher.state === "idle"
                    ? "Confirm placements"
                    : "Applying placements…"}
                </button>
              </autoPlacementFetcher.Form>
            </>
          }
        >
          <div className="stack" data-testid="auto-placement-preview">
            <p>
              Deterministic first-fit assistance for draft version{" "}
              <strong>{autoPreview.scheduleVersionId}</strong> at expected
              schedule revision <strong>{autoPreview.scheduleRevision}</strong>.
              No publication is part of this action.
            </p>
            <div className="grid grid-3">
              <div className="metric">
                <span className="value">
                  {autoPreview.sessionRevisions.length}
                </span>
                <span className="label">Unscheduled inspected</span>
              </div>
              <div className="metric">
                <span className="value">{autoPreview.placements.length}</span>
                <span className="label">Proposed placements</span>
              </div>
              <div className="metric">
                <span className="value">{autoPreview.unplaced.length}</span>
                <span className="label">Unplaced</span>
              </div>
            </div>
            <p className="help">
              Event configuration revision {autoPreview.eventRevision}, conflict
              policy revision {autoPreview.policyRevision}, and every listed
              session revision will be revalidated on confirmation.
            </p>
            <section aria-labelledby="auto-placement-proposed-heading">
              <h3 id="auto-placement-proposed-heading">Proposed placements</h3>
              {autoPreview.placements.length ? (
                <div className="stack">
                  {autoPreview.placements.map((placement) => {
                    const session = sessionById.get(placement.sessionId);
                    const room = workspace.rooms.find(
                      (candidate) => candidate.id === placement.roomId,
                    );
                    return (
                      <div
                        className={`validation-item ${placement.warnings.length ? "warn" : "ok"}`}
                        data-testid="auto-placement-proposal"
                        key={placement.sessionId}
                      >
                        <strong>{session?.title ?? placement.sessionId}</strong>
                        <span>
                          {room?.name ?? placement.roomId} ·{" "}
                          {scheduleDateTimeLabel(
                            placement.startsAt,
                            workspace.event.timezone,
                          )}{" "}
                          –{" "}
                          {scheduleDateTimeLabel(
                            placement.endsAt,
                            workspace.event.timezone,
                          )}
                        </span>
                        {placement.warnings.length ? (
                          <small>
                            Warning:{" "}
                            {placement.warnings
                              .map((warning) => warning.message)
                              .join(" ")}
                          </small>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="validation-item warn">
                  No valid placements were found. Confirmation is disabled.
                </div>
              )}
            </section>
            <section aria-labelledby="auto-placement-unplaced-heading">
              <h3 id="auto-placement-unplaced-heading">Unplaced sessions</h3>
              {autoPreview.unplaced.length ? (
                <div className="stack">
                  {autoPreview.unplaced.map((item) => (
                    <div
                      className="validation-item warn"
                      data-testid="auto-placement-unplaced"
                      key={item.sessionId}
                    >
                      <strong>
                        {sessionById.get(item.sessionId)?.title ??
                          item.sessionId}
                      </strong>
                      <span>{item.reason}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="help">
                  Every inspected unscheduled session has a proposal.
                </p>
              )}
            </section>
          </div>
        </Dialog>
      ) : null}
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
          {contentReviewAdvisories.length ? (
            <div className="validation-item warn">
              <strong>
                {contentReviewAdvisories.length} scheduled content record
                {contentReviewAdvisories.length === 1 ? " is" : "s are"} not
                marked Approved.
              </strong>{" "}
              Content review status is advisory. Confirming publication makes
              this exact schedule-version snapshot authoritative; editorial
              statuses stay unchanged, and public views continue to enforce
              visibility.
              <ul>
                {contentReviewAdvisories.slice(0, 5).map((session) => (
                  <li key={session.id}>
                    {session.title} · {session.contentStatus.replaceAll("_", " ")}
                  </li>
                ))}
                {contentReviewAdvisories.length > 5 ? (
                  <li>{contentReviewAdvisories.length - 5} more</li>
                ) : null}
              </ul>
            </div>
          ) : (
            <div className="validation-item ok">
              Every scheduled content record is marked Approved.
            </div>
          )}
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
