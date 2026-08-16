import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigation } from "react-router";
import type { ScheduleWorkspace } from "~/modules/schedule/schedule-service.server";
import {
  eventBoundaryCalendarDate,
  eventCalendarDayBoundaries,
  eventDayUsableScheduleSlots,
  eventLocalCalendarDate,
  eventLocalTimeEpoch,
} from "~/modules/schedule/schedule-time";
import type { action } from "~/routes/schedule-planner.server";
import type { SchedulePlannerWorkspaceData } from "./schedule-planner-panel-types";
import { useScheduleAutoPlacement } from "./use-schedule-auto-placement";
import { useScheduleUndoAvailability } from "./use-schedule-undo-availability";
import {
  conflictEntryIds,
  containingScheduleSlot,
  isRecord,
  localHour,
  parseScheduleActionNotices,
  scheduleDateTimeLabel,
} from "./schedule-planner-workspace-helpers";

export function useSchedulePlannerController(
  workspace: SchedulePlannerWorkspaceData,
) {
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

  const [revealedEntryIds, setRevealedEntryIds] = useState<string[]>([]);

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

  /* The board offered 00:00–24:00 while the placement form only ever offered
     07:00–22:00, so two thirds of the axis were drop targets the keyboard
     path refused to name. An entry can still sit outside that window — an
     import, or a policy that has since changed — and the axis stretches to
     reach it rather than drawing it at a time it does not happen. */
  const slots = useMemo(() => {
    const usable = eventDayUsableScheduleSlots(
      selectedDay,
      workspace.event.timezone,
    );
    const first = usable[0];
    const last = usable[usable.length - 1];
    if (first === undefined || last === undefined) return usable;
    const halfHour = 30 * 60;
    const starts = selectedDayEntries.map((entry) => entry.startsAt);
    const leading: number[] = [];
    const earliest = Math.min(first, ...starts);
    for (
      let epoch = first - Math.ceil((first - earliest) / halfHour) * halfHour;
      epoch < first;
      epoch += halfHour
    ) {
      leading.push(epoch);
    }
    const trailing: number[] = [];
    for (
      let epoch = last + halfHour;
      epoch <= Math.max(last, ...starts);
      epoch += halfHour
    ) {
      trailing.push(epoch);
    }
    return [...leading, ...usable, ...trailing];
  }, [selectedDay, selectedDayEntries, workspace.event.timezone]);

  const entriesBySlot = useMemo(() => {
    const grouped = new Map<string, ScheduleWorkspace["entries"]>();
    for (const entry of selectedDayEntries) {
      const row = containingScheduleSlot(slots, entry.startsAt);
      if (row === undefined) continue;
      const key = `${entry.roomId}:${row}`;
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    return grouped;
  }, [selectedDayEntries, slots]);

  /* Severity, not just membership: a warning and a blocking overlap must not
     paint the same card the same colour. */
  const conflictSeverityByEntryId = useMemo(() => {
    const severities = new Map<string, "warning" | "blocking">();
    for (const conflict of workspace.conflicts) {
      for (const entryId of conflictEntryIds(conflict)) {
        if (conflict.severity === "blocking" || !severities.has(entryId)) {
          severities.set(
            entryId,
            conflict.severity === "blocking" ? "blocking" : "warning",
          );
        }
      }
    }
    return severities;
  }, [workspace.conflicts]);

  const sessionById = useMemo(
    () => new Map(workspace.sessions.map((session) => [session.id, session])),
    [workspace.sessions],
  );

  const contentApprovalBlockers = useMemo(
    () =>
      workspace.entries.flatMap((entry) => {
        const session = sessionById.get(entry.sessionId);
        return session &&
          session.sourceVisibility === "public" &&
          session.contentStatus !== "approved"
          ? [session]
          : [];
      }),
    [sessionById, workspace.entries],
  );

  const publicContentVisibilityBlockers = useMemo(
    () =>
      workspace.entries.flatMap((entry) => {
        const session = sessionById.get(entry.sessionId);
        return session &&
          session.sourceVisibility === "public" &&
          session.visibility !== "public"
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

  const {
    preview: autoPreview,
    outcome: autoResult,
    error: autoError,
    clearError: clearAutoError,
    clearFeedback: clearAutoFeedback,
    dismissPreview: dismissAutoPreview,
  } = useScheduleAutoPlacement(autoActionResult);

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
    const firstEntryStart = selectedDayEntries[0]?.startsAt;
    const preferredStart =
      (firstEntryStart === undefined
        ? undefined
        : containingScheduleSlot(slots, firstEntryStart)) ??
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
      /* The room header row is sticky, so a fixed offset parks the first
         session underneath it at whichever width the header wraps to two
         lines. */
      const headerHeight =
        scroll.querySelector<HTMLElement>(".schedule-room-board > .header")
          ?.offsetHeight ?? 48;
      scroll.scrollTop = Math.max(0, targetTop - headerHeight - 8);
    }
  }, [selectedDay, selectedDayEntries, slots, workspace.event.timezone]);

  /* Naming a conflict in a 280px rail leaves the operator to find the cards
     themselves. Switching the day first means the jump works for a conflict
     that is not on the day currently on screen. */
  function revealConflictEntries(entryIds: string[]) {
    // Conflict cards only exist in the room board. Switch views in the same
    // render that stages the reveal so the focus effect can find its target.
    setView("room");
    const implicated = workspace.entries.filter((entry) =>
      entryIds.includes(entry.id),
    );
    const first = implicated[0];
    if (first) {
      const date = eventLocalCalendarDate(
        first.startsAt,
        workspace.event.timezone,
      );
      const day = eventDays.find(
        (eventDay) => eventBoundaryCalendarDate(eventDay) === date,
      );
      if (day !== undefined) setSelectedDay(day);
    }
    setRevealedEntryIds(entryIds);
  }

  useEffect(() => {
    if (!revealedEntryIds.length) return;
    const target = revealedEntryIds
      .map((entryId) =>
        document.querySelector<HTMLElement>(
          `[data-entry-id="${CSS.escape(entryId)}"]`,
        ),
      )
      .find((node): node is HTMLElement => node !== null);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center", inline: "center" });
    const clear = window.setTimeout(() => setRevealedEntryIds([]), 2400);
    return () => window.clearTimeout(clear);
  }, [revealedEntryIds]);

  useEffect(() => {
    if (!workspace.focusedSessionId) return;
    const target = document.getElementById(
      `schedule-session-${workspace.focusedSessionId}`,
    );
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", inline: "center" });
  }, [selectedDay, workspace.focusedSessionId, workspace.entries]);

  function sessionLabel(active: {
    data: { current?: Record<string, unknown> };
  }) {
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

  const actionNotices = parseScheduleActionNotices(actionResult);

  useEffect(() => {
    if (
      !isRecord(actionResult) ||
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
    isRecord(actionResult) &&
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

  const undoAvailable = useScheduleUndoAvailability(undo);

  return {
    actionNotices,
    actionResult,
    allPlacementSlots,
    autoError,
    autoPlacementFetcher,
    autoPreview,
    autoResult,
    clearAutoError,
    clearAutoFeedback,
    conflictSeverityByEntryId,
    contentApprovalBlockers,
    dismissAutoPreview,
    draggingSessionId,
    entriesBySlot,
    eventDays,
    fetcher,
    moveInStandardCalendar,
    navigation,
    place,
    placementAvailable,
    publicContentVisibilityBlockers,
    publishOpen,
    quickDurationMinutes,
    quickEntry,
    quickRoomId,
    quickSession,
    quickSessionId,
    quickStartsAt,
    readOnlyPlacementMessage,
    resize,
    resourceInventory,
    revealConflictEntries,
    revealedEntryIds,
    roomScrollRef,
    scheduledSessionIds,
    selectQuickSession,
    selectedDay,
    sensors,
    sessionById,
    sessionLabel,
    setDraggingSessionId,
    setPublishOpen,
    setQuickDurationMinutes,
    setQuickRoomId,
    setQuickStartsAt,
    setSelectedDay,
    setView,
    slotLabel,
    slots,
    trackGroups,
    unassign,
    undoAvailable,
    unscheduledSessions,
    view,
    visibleSessions,
  };
}
