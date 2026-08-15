import { eventLocalTimeEpoch } from "./schedule-time";

export type ConflictPolicy = "ignore" | "warn" | "block";

export type ScheduleCandidate = {
  sessionId: string;
  title: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
  trackId: string | null;
  trackExclusive: boolean;
  speakerIds: ReadonlyArray<string>;
  speakerNames: ReadonlyArray<string>;
  requiredResources: ReadonlyArray<string>;
  expectedAttendance: number | null;
};

export type ScheduledItem = ScheduleCandidate & {
  entryId: string;
};

export type ScheduleRoom = {
  id: string;
  capacity: number;
  resources: ReadonlyArray<string>;
};

export type ScheduleConflict = {
  type:
    | "event_boundary"
    | "room"
    | "speaker"
    | "track"
    | "capacity"
    | "required_resource"
    | "resource_configuration"
    | "room_resource"
    | "turnaround";
  severity: "warning" | "blocking";
  message: string;
  conflictingEntryId?: string;
};

export type SchedulePolicies = {
  room: ConflictPolicy;
  speaker: ConflictPolicy;
  resource: ConflictPolicy;
  track: ConflictPolicy;
  boundary: ConflictPolicy;
  capacity: ConflictPolicy;
  minimumTurnaroundMinutes: number;
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
  const assertSpeakerLabels = (item: ScheduleCandidate) => {
    if (
      item.speakerNames.length !== item.speakerIds.length ||
      item.speakerNames.some((name) => !name.trim())
    ) {
      throw new Error(
        `Session ${item.sessionId} has incomplete speaker conflict labels.`,
      );
    }
  };
  assertSpeakerLabels(candidate);
  for (const item of existing) assertSpeakerLabels(item);
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
    const level = severity(policies.boundary);
    if (level)
      conflicts.push({
        type: "event_boundary",
        severity: level,
        message: "The session must remain within the event dates.",
      });
  }

  const room = rooms.find((item) => item.id === candidate.roomId);
  const configuredResources = new Set(
    rooms.flatMap((configuredRoom) => configuredRoom.resources),
  );
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
  for (const resource of candidate.requiredResources) {
    if (!configuredResources.has(resource)) {
      conflicts.push({
        type: "resource_configuration",
        severity: "blocking",
        message: `Required resource “${resource}” is not configured in any active room.`,
      });
    } else if (room && !room.resources.includes(resource)) {
      conflicts.push({
        type: "room_resource",
        severity: "blocking",
        message: `Required resource “${resource}” is not available in this room.`,
      });
    }
  }

  for (const item of existing) {
    if (
      item.entryId === excludeEntryId ||
      item.sessionId === candidate.sessionId
    )
      continue;
    const overlaps = intervalsOverlap(
      candidate.startsAt,
      candidate.endsAt,
      item.startsAt,
      item.endsAt,
    );
    const sharedSpeaker = candidate.speakerIds.find((personId) =>
      item.speakerIds.includes(personId),
    );
    let sharedSpeakerName: string | null = null;
    if (sharedSpeaker) {
      const candidateName =
        candidate.speakerNames[candidate.speakerIds.indexOf(sharedSpeaker)];
      const existingName =
        item.speakerNames[item.speakerIds.indexOf(sharedSpeaker)];
      if (!candidateName || !existingName || candidateName !== existingName) {
        throw new Error(
          `Speaker ${sharedSpeaker} has inconsistent schedule conflict labels.`,
        );
      }
      sharedSpeakerName = candidateName;
    }
    if (!overlaps) {
      const gapSeconds =
        candidate.startsAt >= item.endsAt
          ? candidate.startsAt - item.endsAt
          : item.startsAt - candidate.endsAt;
      if (
        sharedSpeaker &&
        policies.minimumTurnaroundMinutes > 0 &&
        gapSeconds < policies.minimumTurnaroundMinutes * 60
      ) {
        const level = severity(policies.speaker);
        if (level)
          conflicts.push({
            type: "turnaround",
            severity: level,
            message: `${sharedSpeakerName} has less than ${policies.minimumTurnaroundMinutes} minutes between “${candidate.title}” and “${item.title}”.`,
            conflictingEntryId: item.entryId,
          });
      }
      continue;
    }

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
    if (sharedSpeaker) {
      const level = severity(policies.speaker);
      if (level)
        conflicts.push({
          type: "speaker",
          severity: level,
          message: `${sharedSpeakerName} appears in both “${candidate.title}” and “${item.title}”.`,
          conflictingEntryId: item.entryId,
        });
    }
    const sharedResource = candidate.requiredResources.find((resource) =>
      item.requiredResources.includes(resource),
    );
    if (sharedResource) {
      const level = severity(policies.resource);
      if (level)
        conflicts.push({
          type: "required_resource",
          severity: level,
          message: `Required resource “${sharedResource}” is also needed by “${item.title}”.`,
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
