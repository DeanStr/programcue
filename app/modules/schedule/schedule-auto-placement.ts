import { ScheduleConfigurationError } from "./schedule-errors";
import {
  detectScheduleConflicts,
  type ScheduleConflict,
  type ScheduledItem,
} from "./schedule-rules";
import type { ScheduleWorkspace } from "./schedule-service.server";
import {
  eventCalendarDayBoundaries,
  eventDayUsableScheduleSlots,
  eventLocalTimeEpoch,
  SCHEDULE_DAY_END_HOUR,
} from "./schedule-time";

export const AUTO_ENTRY_PREFIX = "auto:";

export type AutoPlacementProposal = {
  sessionId: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
  warnings: ScheduleConflict[];
};

export type AutoPlacementUnplaced = {
  sessionId: string;
  reason: string;
};

export type AutoPlacementSessionRevision = {
  sessionId: string;
  revision: number;
};

export type AutoPlacementComputation = {
  sessionRevisions: AutoPlacementSessionRevision[];
  placements: AutoPlacementProposal[];
  unplaced: AutoPlacementUnplaced[];
};

export type AutoPlacementReadiness = {
  unscheduledCount: number;
  eligibleCount: number;
  eligibleSessionIds: string[];
  blocked: AutoPlacementUnplaced[];
  canPreview: boolean;
  disabledReason: string | null;
};

export type AutoPlacementPreview = AutoPlacementComputation & {
  idempotencyKey: string;
  scheduleVersionId: string;
  scheduleRevision: number;
  eventRevision: number;
  policyRevision: number;
  selectedSessionIds: string[];
};

export function plannedAutoEntryId(sessionId: string) {
  return `${AUTO_ENTRY_PREFIX}${sessionId}`;
}

function compareStable(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedSessions(
  workspace: Pick<ScheduleWorkspace, "sessions" | "entries">,
) {
  const scheduledIds = new Set(
    workspace.entries.map((entry) => entry.sessionId),
  );
  return workspace.sessions
    .filter(
      (session) =>
        session.status === "unscheduled" && !scheduledIds.has(session.id),
    )
    .sort(
      (left, right) =>
        compareStable(left.title, right.title) ||
        compareStable(left.id, right.id),
    );
}

function orderedRooms(workspace: Pick<ScheduleWorkspace, "rooms">) {
  for (const room of workspace.rooms) {
    if (!Number.isSafeInteger(room.position) || room.position < 0) {
      throw new ScheduleConfigurationError(
        `Room ${room.id} has an invalid ordering position.`,
      );
    }
  }
  return [...workspace.rooms].sort(
    (left, right) =>
      left.position - right.position ||
      compareStable(left.name, right.name) ||
      compareStable(left.id, right.id),
  );
}

function existingScheduleItems(
  workspace: Pick<ScheduleWorkspace, "sessions" | "entries">,
) {
  const sessionById = new Map(
    workspace.sessions.map((session) => [session.id, session]),
  );
  return workspace.entries.map((entry): ScheduledItem => {
    const session = sessionById.get(entry.sessionId);
    if (!session) {
      throw new Error(
        `Schedule entry ${entry.id} references an unavailable session.`,
      );
    }
    return {
      entryId: entry.id,
      sessionId: entry.sessionId,
      roomId: entry.roomId,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      trackId: session.trackId,
      trackExclusive: session.trackExclusive,
      speakerIds: session.speakerIds,
      speakerNames: session.speakerNames,
      requiredResources: session.requiredResources,
      expectedAttendance: session.expectedAttendance,
      title: session.title,
    };
  });
}

function unplacedReason(
  messages: ReadonlyArray<string>,
  attemptedCandidates: number,
  hasRooms: boolean,
  durationMinutes: number,
  exceededWorkingDay: boolean,
) {
  if (!hasRooms) return "No active rooms are configured for this event.";
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) {
    return "The session duration must be a positive whole number of minutes.";
  }
  if (!attemptedCandidates && exceededWorkingDay) {
    return "The session duration does not fit within the auto-placement working day.";
  }
  if (!attemptedCandidates) {
    return "No event-date placement slots are available for this session.";
  }
  const uniqueMessages = [...new Set(messages)];
  if (!uniqueMessages.length) {
    return "No valid placement is available in the configured event dates and active rooms.";
  }
  const displayed = uniqueMessages.slice(0, 4).join(" ");
  const omitted = uniqueMessages.length - Math.min(uniqueMessages.length, 4);
  return `No valid placement is available. Blocking checks included: ${displayed}${omitted > 0 ? ` ${omitted} additional blocking check${omitted === 1 ? "" : "s"} applied.` : ""}`;
}

export function computeAutoPlacements(
  workspace: Pick<
    ScheduleWorkspace,
    "event" | "rooms" | "sessions" | "entries" | "policies" | "speakerBlackouts"
  >,
): AutoPlacementComputation {
  const sessions = orderedSessions(workspace);
  const sessionRevisions = sessions.map(({ id: sessionId, revision }) => ({
    sessionId,
    revision,
  }));
  const placements: AutoPlacementProposal[] = [];
  const unplaced: AutoPlacementUnplaced[] = [];
  const rooms = orderedRooms(workspace);
  const working = existingScheduleItems(workspace);
  const days = eventCalendarDayBoundaries(
    workspace.event.startsAt,
    workspace.event.endsAt,
  );
  const slots = days.flatMap((day) => {
    const workingDayEnd = eventLocalTimeEpoch(
      day,
      workspace.event.timezone,
      SCHEDULE_DAY_END_HOUR,
    );
    return eventDayUsableScheduleSlots(day, workspace.event.timezone).map(
      (startsAt) => ({ startsAt, workingDayEnd }),
    );
  });

  for (const session of sessions) {
    if (typeof session.hasUnpublishedSpeaker !== "boolean") {
      throw new ScheduleConfigurationError(
        `Session ${session.id} is missing speaker publication visibility metadata.`,
      );
    }
    const durationSeconds = session.durationMinutes * 60;
    const failureMessages: string[] = [];
    let attemptedCandidates = 0;
    let exceededWorkingDay = false;
    let placed: AutoPlacementProposal | null = null;

    if (session.hasUnpublishedSpeaker) {
      unplaced.push({
        sessionId: session.id,
        reason: "One or more linked speakers are not published for this event.",
      });
      continue;
    }

    if (Number.isSafeInteger(durationSeconds) && durationSeconds > 0) {
      candidateLoop: for (const { startsAt, workingDayEnd } of slots) {
        const endsAt = startsAt + durationSeconds;
        if (endsAt > workingDayEnd) {
          exceededWorkingDay = true;
          continue;
        }
        for (const room of rooms) {
          attemptedCandidates += 1;
          const conflicts = detectScheduleConflicts({
            candidate: {
              sessionId: session.id,
              title: session.title,
              roomId: room.id,
              startsAt,
              endsAt,
              trackId: session.trackId,
              trackExclusive: session.trackExclusive,
              speakerIds: session.speakerIds,
              speakerNames: session.speakerNames,
              requiredResources: session.requiredResources,
              expectedAttendance: session.expectedAttendance,
            },
            existing: working,
            rooms,
            eventStartsAt: workspace.event.startsAt,
            eventEndsAt: workspace.event.endsAt,
            eventTimezone: workspace.event.timezone,
            policies: workspace.policies,
            speakerBlackouts: workspace.speakerBlackouts,
          });
          const blocking = conflicts.filter(
            (conflict) => conflict.severity === "blocking",
          );
          if (!blocking.length) {
            placed = {
              sessionId: session.id,
              roomId: room.id,
              startsAt,
              endsAt,
              warnings: conflicts,
            };
            break candidateLoop;
          }
          failureMessages.push(...blocking.map((conflict) => conflict.message));
        }
      }
    }

    if (!placed) {
      unplaced.push({
        sessionId: session.id,
        reason: unplacedReason(
          failureMessages,
          attemptedCandidates,
          rooms.length > 0,
          session.durationMinutes,
          exceededWorkingDay,
        ),
      });
      continue;
    }

    placements.push(placed);
    working.push({
      entryId: plannedAutoEntryId(session.id),
      sessionId: session.id,
      roomId: placed.roomId,
      startsAt: placed.startsAt,
      endsAt: placed.endsAt,
      trackId: session.trackId,
      trackExclusive: session.trackExclusive,
      speakerIds: session.speakerIds,
      speakerNames: session.speakerNames,
      requiredResources: session.requiredResources,
      expectedAttendance: session.expectedAttendance,
      title: session.title,
    });
  }

  return { sessionRevisions, placements, unplaced };
}

export function getAutoPlacementReadiness(
  workspace: Pick<
    ScheduleWorkspace,
    | "event"
    | "rooms"
    | "sessions"
    | "entries"
    | "policies"
    | "speakerBlackouts"
    | "version"
  >,
): AutoPlacementReadiness {
  const computation = computeAutoPlacements(workspace);
  const scheduledSessionIds = new Set(
    workspace.entries.map((entry) => entry.sessionId),
  );
  const unplacedCount = workspace.sessions.filter(
    (session) => !scheduledSessionIds.has(session.id),
  ).length;
  const unscheduledCount = workspace.sessions.filter(
    (session) =>
      session.status === "unscheduled" && !scheduledSessionIds.has(session.id),
  ).length;
  const eligibleSessionIds = computation.placements.map(
    (placement) => placement.sessionId,
  );
  const hasDraft = workspace.version?.status === "draft";
  return {
    unscheduledCount,
    eligibleCount: eligibleSessionIds.length,
    eligibleSessionIds,
    blocked: computation.unplaced,
    canPreview: hasDraft && eligibleSessionIds.length > 0,
    disabledReason:
      unplacedCount === 0
        ? "There are no unscheduled sessions to place."
        : !hasDraft
          ? "Create an active draft schedule before auto-placing sessions."
          : unscheduledCount === 0
            ? "The remaining unplaced sessions are not unscheduled, so auto-place cannot move them."
            : eligibleSessionIds.length === 0
              ? "No unscheduled session currently meets the placement rules. Review each blocker below."
              : null,
  };
}

export function revalidateSelectedAutoPlacements(
  workspace: Pick<
    ScheduleWorkspace,
    "event" | "rooms" | "sessions" | "entries" | "policies" | "speakerBlackouts"
  >,
  placements: ReadonlyArray<AutoPlacementProposal>,
) {
  const sessionById = new Map(
    workspace.sessions.map((session) => [session.id, session]),
  );
  const rooms = orderedRooms(workspace);
  const roomIds = new Set(rooms.map((room) => room.id));
  const working = existingScheduleItems(workspace);
  const validated: AutoPlacementProposal[] = [];

  for (const placement of placements) {
    const session = sessionById.get(placement.sessionId);
    if (!session || !roomIds.has(placement.roomId)) return null;
    if (typeof session.hasUnpublishedSpeaker !== "boolean") {
      throw new ScheduleConfigurationError(
        `Session ${session.id} is missing speaker publication visibility metadata.`,
      );
    }
    if (session.hasUnpublishedSpeaker) return null;
    const conflicts = detectScheduleConflicts({
      candidate: {
        sessionId: session.id,
        title: session.title,
        roomId: placement.roomId,
        startsAt: placement.startsAt,
        endsAt: placement.endsAt,
        trackId: session.trackId,
        trackExclusive: session.trackExclusive,
        speakerIds: session.speakerIds,
        speakerNames: session.speakerNames,
        requiredResources: session.requiredResources,
        expectedAttendance: session.expectedAttendance,
      },
      existing: working,
      rooms,
      eventStartsAt: workspace.event.startsAt,
      eventEndsAt: workspace.event.endsAt,
      eventTimezone: workspace.event.timezone,
      policies: workspace.policies,
      speakerBlackouts: workspace.speakerBlackouts,
    });
    if (conflicts.some((conflict) => conflict.severity === "blocking")) {
      return null;
    }
    const validatedPlacement = { ...placement, warnings: conflicts };
    validated.push(validatedPlacement);
    working.push({
      entryId: plannedAutoEntryId(session.id),
      sessionId: session.id,
      roomId: placement.roomId,
      startsAt: placement.startsAt,
      endsAt: placement.endsAt,
      trackId: session.trackId,
      trackExclusive: session.trackExclusive,
      speakerIds: session.speakerIds,
      speakerNames: session.speakerNames,
      requiredResources: session.requiredResources,
      expectedAttendance: session.expectedAttendance,
      title: session.title,
    });
  }
  return validated;
}

export function canonicalAutoPlacementPlan(computation: {
  placements: ReadonlyArray<
    Pick<AutoPlacementProposal, "sessionId" | "roomId" | "startsAt" | "endsAt">
  >;
  unplaced: ReadonlyArray<Pick<AutoPlacementUnplaced, "sessionId">>;
}) {
  return {
    placements: [...computation.placements]
      .map(({ sessionId, roomId, startsAt, endsAt }) => ({
        sessionId,
        roomId,
        startsAt,
        endsAt,
      }))
      .sort((left, right) => compareStable(left.sessionId, right.sessionId)),
    unplaced: [...computation.unplaced]
      .map(({ sessionId }) => ({ sessionId }))
      .sort((left, right) => compareStable(left.sessionId, right.sessionId)),
  };
}

export function canonicalAutoPlacementSessionRevisions(
  revisions: ReadonlyArray<AutoPlacementSessionRevision>,
) {
  return [...revisions].sort((left, right) =>
    compareStable(left.sessionId, right.sessionId),
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareStable(left, right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export async function autoPlacementRequestHash(value: unknown) {
  const canonicalValue =
    value && typeof value === "object" && !Array.isArray(value)
      ? (() => {
          const record = value as Record<string, unknown>;
          return Array.isArray(record.selectedSessionIds) &&
            record.selectedSessionIds.every(
              (sessionId) => typeof sessionId === "string",
            )
            ? {
                ...record,
                selectedSessionIds: [...record.selectedSessionIds].sort(
                  compareStable,
                ),
              }
            : value;
        })()
      : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(stableValue(canonicalValue))),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
