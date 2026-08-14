import type {
  AutoPlacementPreview,
  AutoPlacementUnplaced,
} from "~/modules/schedule/schedule-auto-placement";

export function localHour(epoch: number, timezone: string) {
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

export function scheduleDateTimeLabel(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

export type AutoPlacementResultNotice = {
  appliedCount: number;
  unplacedCount: number;
  unplaced: AutoPlacementUnplaced[];
  warning: string | null;
};

export type ScheduleActionConflictNotice = {
  type: string;
  severity: "warning" | "blocking";
  message: string;
};

export const SCHEDULE_ACTION_INVALID_RESPONSE_MESSAGE =
  "The schedule action returned an invalid response. Refresh and try again.";

export type ScheduleActionNotices = {
  conflicts: ScheduleActionConflictNotice[];
  warnings: ScheduleActionConflictNotice[];
  error: string | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isScheduleActionConflictNotice(
  value: unknown,
): value is ScheduleActionConflictNotice {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    value.type.length > 0 &&
    (value.severity === "warning" || value.severity === "blocking") &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    (value.conflictingEntryId === undefined ||
      typeof value.conflictingEntryId === "string")
  );
}

export function parseScheduleActionNotices(
  result: unknown,
): ScheduleActionNotices {
  const empty = { conflicts: [], warnings: [] };
  if (result === undefined) return { ...empty, error: null };
  if (!isRecord(result)) {
    return { ...empty, error: SCHEDULE_ACTION_INVALID_RESPONSE_MESSAGE };
  }
  const conflicts =
    "conflicts" in result && Array.isArray(result.conflicts)
      ? result.conflicts
      : "conflicts" in result
        ? null
        : [];
  const warnings =
    "warnings" in result && Array.isArray(result.warnings)
      ? result.warnings
      : "warnings" in result
        ? null
        : [];
  if (
    !conflicts ||
    !warnings ||
    !conflicts.every(isScheduleActionConflictNotice) ||
    !warnings.every(
      (warning) =>
        isScheduleActionConflictNotice(warning) &&
        warning.severity === "warning",
    )
  ) {
    return { ...empty, error: SCHEDULE_ACTION_INVALID_RESPONSE_MESSAGE };
  }
  return { conflicts, warnings, error: null };
}

export function conflictTypeLabel(type: string) {
  return type.replaceAll("_", " ");
}

export function isAutoPlacementUnplaced(
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

export function isAutoPlacementPreview(
  value: unknown,
): value is AutoPlacementPreview {
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

export type AutoPlacementConfirmation = {
  committed: true;
  appliedCount: number;
  scheduleRevision: number;
  unplacedCount: number;
  warning: string | null;
};

export function isAutoPlacementConfirmation(
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

export function autoPlacementResponseError(result: Record<string, unknown>) {
  return typeof result.error === "string" && result.error.length > 0
    ? result.error
    : "Auto-place returned an invalid response. Refresh and try again.";
}

export function serializeAutoPlacementPreview(preview: AutoPlacementPreview) {
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
    throw new Error("The suggested placements could not be prepared.");
  }
  return payload;
}
