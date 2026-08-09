import { eventLocalTimeEpoch } from "./schedule-time";

export type ConflictPolicy = "ignore" | "warn" | "block";

export type ScheduleCandidate = {
  sessionId: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
  trackId: string | null;
  trackExclusive: boolean;
  speakerIds: ReadonlyArray<string>;
  expectedAttendance: number | null;
};

export type ScheduledItem = ScheduleCandidate & {
  entryId: string;
  title: string;
};

export type ScheduleRoom = {
  id: string;
  capacity: number;
};

export type ScheduleConflict = {
  type: "event_boundary" | "room" | "speaker" | "track" | "capacity";
  severity: "warning" | "blocking";
  message: string;
  conflictingEntryId?: string;
};

export type SchedulePolicies = {
  room: ConflictPolicy;
  speaker: ConflictPolicy;
  track: ConflictPolicy;
  capacity: ConflictPolicy;
};

export function intervalsOverlap(
  aStartsAt: number,
  aEndsAt: number,
  bStartsAt: number,
  bEndsAt: number,
) {
  return aStartsAt < bEndsAt && bStartsAt < aEndsAt;
}

function severity(policy: ConflictPolicy): ScheduleConflict["severity"] | null {
  if (policy === "ignore") return null;
  return policy === "block" ? "blocking" : "warning";
}

export function detectScheduleConflicts({
  candidate,
  existing,
  rooms,
  eventStartsAt,
  eventEndsAt,
  eventTimezone,
  policies,
  excludeEntryId,
}: {
  candidate: ScheduleCandidate;
  existing: ReadonlyArray<ScheduledItem>;
  rooms: ReadonlyArray<ScheduleRoom>;
  eventStartsAt: number;
  eventEndsAt: number;
  eventTimezone: string;
  policies: SchedulePolicies;
  excludeEntryId?: string;
}): ScheduleConflict[] {
  if (candidate.endsAt <= candidate.startsAt)
    throw new Error("A schedule entry must end after it starts.");
  const conflicts: ScheduleConflict[] = [];
  // Event Setup stores inclusive calendar-date markers in UTC. Scheduling uses
  // real instants, so compare against those dates in the event timezone rather
  // than treating the UTC markers as instants in the event timezone.
  const eventLocalStartsAt = eventLocalTimeEpoch(
    eventStartsAt,
    eventTimezone,
    0,
  );
  const eventLocalEndsAtExclusive = eventLocalTimeEpoch(
    eventEndsAt + 1,
    eventTimezone,
    0,
  );
  if (
    candidate.startsAt < eventLocalStartsAt ||
    candidate.endsAt > eventLocalEndsAtExclusive
  ) {
    conflicts.push({
      type: "event_boundary",
      severity: "blocking",
      message: "The session must remain within the event dates.",
    });
  }

  const room = rooms.find((item) => item.id === candidate.roomId);
  if (!room) {
    conflicts.push({
      type: "room",
      severity: "blocking",
      message: "Choose a room that belongs to this event.",
    });
  } else if (
    candidate.expectedAttendance !== null &&
    candidate.expectedAttendance > room.capacity
  ) {
    const level = severity(policies.capacity);
    if (level)
      conflicts.push({
        type: "capacity",
        severity: level,
        message: `Expected attendance (${candidate.expectedAttendance}) exceeds room capacity (${room.capacity}).`,
      });
  }

  for (const item of existing) {
    if (
      item.entryId === excludeEntryId ||
      item.sessionId === candidate.sessionId
    )
      continue;
    if (
      !intervalsOverlap(
        candidate.startsAt,
        candidate.endsAt,
        item.startsAt,
        item.endsAt,
      )
    )
      continue;

    if (item.roomId === candidate.roomId) {
      const level = severity(policies.room);
      if (level)
        conflicts.push({
          type: "room",
          severity: level,
          message: `Room overlaps “${item.title}”.`,
          conflictingEntryId: item.entryId,
        });
    }
    const sharedSpeaker = candidate.speakerIds.find((personId) =>
      item.speakerIds.includes(personId),
    );
    if (sharedSpeaker) {
      const level = severity(policies.speaker);
      if (level)
        conflicts.push({
          type: "speaker",
          severity: level,
          message: `A speaker also appears in “${item.title}”.`,
          conflictingEntryId: item.entryId,
        });
    }
    if (
      candidate.trackExclusive &&
      candidate.trackId &&
      item.trackId === candidate.trackId
    ) {
      const level = severity(policies.track);
      if (level)
        conflicts.push({
          type: "track",
          severity: level,
          message: `Track overlaps “${item.title}”.`,
          conflictingEntryId: item.entryId,
        });
    }
  }
  return conflicts;
}

export function assertPublishable(conflicts: ReadonlyArray<ScheduleConflict>) {
  const blockers = conflicts.filter(
    (conflict) => conflict.severity === "blocking",
  );
  if (blockers.length) {
    throw new Error(
      `Resolve ${blockers.length} blocking schedule conflict${blockers.length === 1 ? "" : "s"} before publishing.`,
    );
  }
}
