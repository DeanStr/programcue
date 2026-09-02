import { ScheduleUndoUnavailableError } from "./schedule-errors";
import type { ScheduleConflict } from "./schedule-rules";
import type {
  ScheduleEntry,
  SchedulePlacementResult,
  SchedulePlacementSessionUpdate,
  SchedulePlacementWarning,
  ScheduleSession,
} from "./schedule-service.server";

export type ScheduleEntrySnapshot = Pick<
  ScheduleEntry,
  "id" | "sessionId" | "roomId" | "startsAt" | "endsAt" | "revision"
>;

export type ContentApprovalSource = "editorial" | "legacy_publication";

export type ScheduleUndoMetadata = {
  undoToken: string;
  expiresAt: number;
  scheduleVersionId: string;
  previous: ScheduleEntrySnapshot | null;
  next: ScheduleEntrySnapshot | null;
  previousDurationMinutes: number | null;
  previousContentRevision: number | null;
  previousContentStatus: ScheduleSession["contentStatus"] | null;
  previousApprovedByPersonId: string | null;
  previousApprovedAt: number | null;
  previousApprovalSource: ContentApprovalSource | null;
};

function entrySnapshot(value: unknown): ScheduleEntrySnapshot | null {
  if (value === null) return null;
  if (!value || typeof value !== "object")
    throw new ScheduleUndoUnavailableError();
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.roomId !== "string" ||
    typeof candidate.startsAt !== "number" ||
    !Number.isSafeInteger(candidate.startsAt) ||
    typeof candidate.endsAt !== "number" ||
    !Number.isSafeInteger(candidate.endsAt) ||
    typeof candidate.revision !== "number" ||
    !Number.isSafeInteger(candidate.revision)
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  return candidate as ScheduleEntrySnapshot;
}

const contentStatuses = new Set<ScheduleSession["contentStatus"]>([
  "draft",
  "in_review",
  "approved",
  "changes_requested",
]);

function durationMinutesSnapshot(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1_440
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  return value;
}

function contentRevisionSnapshot(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ScheduleUndoUnavailableError();
  }
  return value;
}

function epochSnapshot(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ScheduleUndoUnavailableError();
  }
  return value;
}

function contentStatusSnapshot(
  value: unknown,
): ScheduleSession["contentStatus"] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !contentStatuses.has(value as never)) {
    throw new ScheduleUndoUnavailableError();
  }
  return value as ScheduleSession["contentStatus"];
}

function optionalStringSnapshot(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new ScheduleUndoUnavailableError();
  }
  return value;
}

function approvalSourceSnapshot(value: unknown): ContentApprovalSource | null {
  if (value === undefined || value === null) return null;
  if (value !== "editorial" && value !== "legacy_publication") {
    throw new ScheduleUndoUnavailableError();
  }
  return value;
}

export function parseUndoMetadata(value: string): ScheduleUndoMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ScheduleUndoUnavailableError();
  }
  if (!parsed || typeof parsed !== "object")
    throw new ScheduleUndoUnavailableError();
  const metadata = parsed as Record<string, unknown>;
  if (
    typeof metadata.undoToken !== "string" ||
    typeof metadata.expiresAt !== "number" ||
    !Number.isSafeInteger(metadata.expiresAt) ||
    typeof metadata.scheduleVersionId !== "string"
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  return {
    undoToken: metadata.undoToken,
    expiresAt: metadata.expiresAt,
    scheduleVersionId: metadata.scheduleVersionId,
    previous: entrySnapshot(metadata.previous),
    next: entrySnapshot(metadata.next),
    previousDurationMinutes: durationMinutesSnapshot(
      metadata.previousDurationMinutes,
    ),
    previousContentRevision: contentRevisionSnapshot(
      metadata.previousContentRevision,
    ),
    previousContentStatus: contentStatusSnapshot(
      metadata.previousContentStatus,
    ),
    previousApprovedByPersonId: optionalStringSnapshot(
      metadata.previousApprovedByPersonId,
    ),
    previousApprovedAt: epochSnapshot(metadata.previousApprovedAt),
    previousApprovalSource: approvalSourceSnapshot(
      metadata.previousApprovalSource,
    ),
  };
}

const scheduleConflictTypes = new Set<ScheduleConflict["type"]>([
  "event_boundary",
  "room",
  "speaker",
  "track",
  "capacity",
  "required_resource",
  "resource_configuration",
  "room_resource",
  "turnaround",
  "speaker_unavailable",
]);

export function parseSchedulePlacementResult(
  value: unknown,
): SchedulePlacementResult {
  if (!value || typeof value !== "object") {
    throw new Error(
      "The completed schedule placement is missing its durable result.",
    );
  }
  const candidate = value as Record<string, unknown>;
  const undo = candidate.undo;
  const entry = candidate.entry;
  const session = candidate.session;
  if (
    typeof candidate.entryId !== "string" ||
    candidate.entryId.length === 0 ||
    !entry ||
    typeof entry !== "object" ||
    typeof candidate.movedExistingEntry !== "boolean" ||
    typeof candidate.scheduleRevision !== "number" ||
    !Number.isSafeInteger(candidate.scheduleRevision) ||
    candidate.scheduleRevision < 1 ||
    !Array.isArray(candidate.warnings) ||
    !undo ||
    typeof undo !== "object"
  ) {
    throw new Error(
      "The completed schedule placement has an invalid durable result.",
    );
  }
  let parsedSession: SchedulePlacementSessionUpdate | undefined;
  if (session !== undefined) {
    if (!session || typeof session !== "object") {
      throw new Error(
        "The completed schedule placement has invalid durable session data.",
      );
    }
    const candidateSession = session as Record<string, unknown>;
    if (
      typeof candidateSession.id !== "string" ||
      candidateSession.id.length === 0 ||
      typeof candidateSession.durationMinutes !== "number" ||
      !Number.isSafeInteger(candidateSession.durationMinutes) ||
      candidateSession.durationMinutes < 5 ||
      candidateSession.durationMinutes > 480 ||
      typeof candidateSession.contentStatus !== "string" ||
      !contentStatuses.has(candidateSession.contentStatus as never) ||
      typeof candidateSession.contentRevision !== "number" ||
      !Number.isSafeInteger(candidateSession.contentRevision) ||
      candidateSession.contentRevision < 1 ||
      (candidateSession.status !== "scheduled" &&
        candidateSession.status !== "published") ||
      typeof candidateSession.revision !== "number" ||
      !Number.isSafeInteger(candidateSession.revision) ||
      candidateSession.revision < 1
    ) {
      throw new Error(
        "The completed schedule placement has invalid durable session data.",
      );
    }
    parsedSession = candidateSession as SchedulePlacementSessionUpdate;
  }
  const parsedEntry = entry as Record<string, unknown>;
  if (
    typeof parsedEntry.id !== "string" ||
    parsedEntry.id !== candidate.entryId ||
    typeof parsedEntry.sessionId !== "string" ||
    parsedEntry.sessionId.length === 0 ||
    typeof parsedEntry.roomId !== "string" ||
    parsedEntry.roomId.length === 0 ||
    typeof parsedEntry.startsAt !== "number" ||
    !Number.isSafeInteger(parsedEntry.startsAt) ||
    parsedEntry.startsAt <= 0 ||
    typeof parsedEntry.endsAt !== "number" ||
    !Number.isSafeInteger(parsedEntry.endsAt) ||
    parsedEntry.endsAt <= parsedEntry.startsAt ||
    typeof parsedEntry.revision !== "number" ||
    !Number.isSafeInteger(parsedEntry.revision) ||
    parsedEntry.revision < 1
  ) {
    throw new Error(
      "The completed schedule placement has invalid durable entry data.",
    );
  }
  if (
    parsedSession &&
    (parsedSession.id !== parsedEntry.sessionId ||
      parsedSession.durationMinutes * 60 !==
        (parsedEntry.endsAt as number) - (parsedEntry.startsAt as number))
  ) {
    throw new Error(
      "The completed schedule placement session does not match its entry.",
    );
  }
  const parsedWarnings = candidate.warnings.map((warning) => {
    if (!warning || typeof warning !== "object") {
      throw new Error(
        "The completed schedule placement has an invalid durable warning.",
      );
    }
    const parsed = warning as Record<string, unknown>;
    if (
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      typeof parsed.type !== "string" ||
      !scheduleConflictTypes.has(parsed.type as ScheduleConflict["type"]) ||
      parsed.severity !== "warning" ||
      typeof parsed.message !== "string" ||
      parsed.message.length === 0 ||
      (parsed.conflictingEntryId !== undefined &&
        typeof parsed.conflictingEntryId !== "string") ||
      (parsed.speakerId !== undefined &&
        typeof parsed.speakerId !== "string") ||
      (parsed.blackoutWindowId !== undefined &&
        typeof parsed.blackoutWindowId !== "string") ||
      (parsed.resource !== undefined && typeof parsed.resource !== "string")
    ) {
      throw new Error(
        "The completed schedule placement has an invalid durable warning.",
      );
    }
    return {
      id: parsed.id,
      type: parsed.type,
      severity: parsed.severity,
      message: parsed.message,
      ...(parsed.conflictingEntryId === undefined
        ? {}
        : { conflictingEntryId: parsed.conflictingEntryId }),
      ...(parsed.speakerId === undefined
        ? {}
        : { speakerId: parsed.speakerId }),
      ...(parsed.blackoutWindowId === undefined
        ? {}
        : { blackoutWindowId: parsed.blackoutWindowId }),
      ...(parsed.resource === undefined ? {} : { resource: parsed.resource }),
    } as SchedulePlacementWarning;
  });
  const parsedUndo = undo as Record<string, unknown>;
  if (
    typeof parsedUndo.token !== "string" ||
    parsedUndo.token.length === 0 ||
    typeof parsedUndo.expiresAt !== "number" ||
    !Number.isSafeInteger(parsedUndo.expiresAt) ||
    parsedUndo.expiresAt < 1
  ) {
    throw new Error(
      "The completed schedule placement has invalid durable undo metadata.",
    );
  }
  return {
    entryId: candidate.entryId,
    entry: parsedEntry as ScheduleEntrySnapshot,
    ...(parsedSession ? { session: parsedSession } : {}),
    movedExistingEntry: candidate.movedExistingEntry,
    scheduleRevision: candidate.scheduleRevision,
    warnings: parsedWarnings,
    undo: { token: parsedUndo.token, expiresAt: parsedUndo.expiresAt },
  };
}
