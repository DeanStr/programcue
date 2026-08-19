import type {
  ScheduleEntry,
  SchedulePlacementWarning,
} from "~/modules/schedule/schedule-service.server";
import type { SchedulePlannerWorkspaceData } from "./schedule-planner-panel-types";
import {
  conflictEntryIds,
  isPositiveSafeInteger,
  isRecord,
  isScheduleActionConflictNotice,
} from "./schedule-planner-workspace-helpers";

export type PendingSchedulePlacement = {
  entry: ScheduleEntry;
};

export type CommittedScheduleMove = {
  placement: ScheduleEntry;
  scheduleRevision: number;
  warnings: SchedulePlacementWarning[];
};

const scheduleConflictTypes = new Set<SchedulePlacementWarning["type"]>([
  "event_boundary",
  "room",
  "speaker",
  "track",
  "capacity",
  "required_resource",
  "resource_configuration",
  "room_resource",
  "turnaround",
]);

function isScheduleConflictNotice(
  value: unknown,
): value is SchedulePlacementWarning {
  return (
    isScheduleActionConflictNotice(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    scheduleConflictTypes.has(value.type as SchedulePlacementWarning["type"])
  );
}

function isScheduleEntry(value: unknown): value is ScheduleEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.roomId === "string" &&
    value.roomId.length > 0 &&
    isPositiveSafeInteger(value.startsAt) &&
    isPositiveSafeInteger(value.endsAt) &&
    value.endsAt > value.startsAt &&
    isPositiveSafeInteger(value.revision)
  );
}

export function committedScheduleMove(
  value: unknown,
): CommittedScheduleMove | null {
  if (
    !isRecord(value) ||
    value.intent !== "place" ||
    value.committed !== true ||
    value.skipRevalidation !== true ||
    !isScheduleEntry(value.placement) ||
    !isPositiveSafeInteger(value.scheduleRevision) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(
      (warning) =>
        isScheduleConflictNotice(warning) && warning.severity === "warning",
    )
  ) {
    return null;
  }
  return {
    placement: value.placement,
    scheduleRevision: value.scheduleRevision,
    warnings: value.warnings,
  };
}

export function needsAuthoritativeScheduleMoveRefresh(value: unknown) {
  return (
    isRecord(value) &&
    value.intent === "place" &&
    value.committed === true &&
    value.skipRevalidation === true &&
    committedScheduleMove(value) === null
  );
}

export function applyOptimisticSchedulePlacement(
  workspace: SchedulePlannerWorkspaceData,
  pending: PendingSchedulePlacement | null,
): SchedulePlannerWorkspaceData {
  if (!pending) return workspace;
  const existingIndex = workspace.entries.findIndex(
    (entry) => entry.sessionId === pending.entry.sessionId,
  );
  const entries = [...workspace.entries];
  if (existingIndex === -1) entries.push(pending.entry);
  else entries[existingIndex] = pending.entry;
  return { ...workspace, entries };
}

export function reconcileCommittedScheduleMove(
  workspace: SchedulePlannerWorkspaceData,
  result: CommittedScheduleMove,
): SchedulePlannerWorkspaceData {
  const movedEntryId = result.placement.id;
  const entries = workspace.entries.map((entry) =>
    entry.sessionId === result.placement.sessionId ? result.placement : entry,
  );
  const retainedConflicts = workspace.conflicts.filter(
    (conflict) => !conflictEntryIds(conflict).includes(movedEntryId),
  );
  const nextConflicts = result.warnings.map((warning) => ({
    ...warning,
    entryIds: [movedEntryId, warning.conflictingEntryId].filter(
      (entryId): entryId is string => Boolean(entryId),
    ),
  }));
  const retainedPublicationConflicts = workspace.publicationConflicts.filter(
    (conflict) => !conflict.entryIds.includes(movedEntryId),
  );
  const calendarPreviews = Object.fromEntries(
    Object.entries(workspace.calendarPreviews).filter(
      ([sessionId]) => sessionId !== result.placement.sessionId,
    ),
  );

  return {
    ...workspace,
    version: workspace.version
      ? { ...workspace.version, revision: result.scheduleRevision }
      : null,
    entries,
    conflicts: [...retainedConflicts, ...nextConflicts],
    publicationConflicts: [...retainedPublicationConflicts, ...nextConflicts],
    calendarPreviews,
    // This is refreshed only when the operator asks to publish. Keeping an old
    // diff after an optimistic move would be worse than making that boundary
    // perform its deliberate authoritative read.
    publicationPreview: null,
  };
}
