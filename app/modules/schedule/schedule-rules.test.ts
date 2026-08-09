import { describe, expect, it } from "vitest";

import {
  assertPublishable,
  detectScheduleConflicts,
  intervalsOverlap,
} from "./schedule-rules";
import { eventLocalTimeEpoch } from "./schedule-time";

const policies = {
  room: "block",
  speaker: "block",
  track: "warn",
  capacity: "warn",
} as const;

describe("authoritative schedule rules", () => {
  it("treats touching intervals as non-overlapping", () => {
    expect(intervalsOverlap(100, 200, 200, 300)).toBe(false);
  });

  it("finds room, speaker, track and capacity conflicts", () => {
    const conflicts = detectScheduleConflicts({
      candidate: {
        sessionId: "new",
        roomId: "main",
        startsAt: 150,
        endsAt: 250,
        trackId: "track-a",
        trackExclusive: true,
        speakerIds: ["speaker-a"],
        expectedAttendance: 120,
      },
      existing: [
        {
          entryId: "entry-existing",
          sessionId: "existing",
          roomId: "main",
          startsAt: 100,
          endsAt: 200,
          trackId: "track-a",
          trackExclusive: true,
          speakerIds: ["speaker-a"],
          expectedAttendance: 40,
          title: "Existing session",
        },
      ],
      rooms: [{ id: "main", capacity: 100 }],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies,
    });
    expect(conflicts.map((conflict) => conflict.type)).toEqual([
      "capacity",
      "room",
      "speaker",
      "track",
    ]);
    expect(() => assertPublishable(conflicts)).toThrow(/2 blocking/);
  });

  it("always blocks an entry outside event bounds", () => {
    const conflicts = detectScheduleConflicts({
      candidate: {
        sessionId: "new",
        roomId: "main",
        startsAt: -1,
        endsAt: 30,
        trackId: null,
        trackExclusive: false,
        speakerIds: [],
        expectedAttendance: null,
      },
      existing: [],
      rooms: [{ id: "main", capacity: 100 }],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies: {
        room: "ignore",
        speaker: "ignore",
        track: "ignore",
        capacity: "ignore",
      },
    });
    expect(conflicts).toMatchObject([
      { type: "event_boundary", severity: "blocking" },
    ]);
  });

  it("uses the event-local first and last calendar days for boundary checks", () => {
    const firstDayMarker = Date.parse("2025-10-05T00:00:00Z") / 1_000;
    const lastDayMarker = Date.parse("2025-10-07T23:59:59Z") / 1_000;
    const noConflicts = (timezone: string, startsAt: number, endsAt: number) =>
      detectScheduleConflicts({
        candidate: {
          sessionId: "new",
          roomId: "main",
          startsAt,
          endsAt,
          trackId: null,
          trackExclusive: false,
          speakerIds: [],
          expectedAttendance: null,
        },
        existing: [],
        rooms: [{ id: "main", capacity: 100 }],
        eventStartsAt: firstDayMarker,
        eventEndsAt: lastDayMarker,
        eventTimezone: timezone,
        policies: {
          room: "ignore",
          speaker: "ignore",
          track: "ignore",
          capacity: "ignore",
        },
      });

    const melbourneStart = eventLocalTimeEpoch(
      firstDayMarker,
      "Australia/Melbourne",
      9,
    );
    expect(
      noConflicts(
        "Australia/Melbourne",
        melbourneStart,
        melbourneStart + 3_600,
      ),
    ).not.toContainEqual(expect.objectContaining({ type: "event_boundary" }));

    const torontoEnd = eventLocalTimeEpoch(
      lastDayMarker,
      "America/Toronto",
      23,
    );
    expect(
      noConflicts("America/Toronto", torontoEnd, torontoEnd + 3_600),
    ).not.toContainEqual(expect.objectContaining({ type: "event_boundary" }));
  });

  it("allows overlapping sessions on a non-exclusive track", () => {
    const conflicts = detectScheduleConflicts({
      candidate: {
        sessionId: "new",
        roomId: "second",
        startsAt: 150,
        endsAt: 250,
        trackId: "track-a",
        trackExclusive: false,
        speakerIds: [],
        expectedAttendance: null,
      },
      existing: [
        {
          entryId: "entry-existing",
          sessionId: "existing",
          roomId: "main",
          startsAt: 100,
          endsAt: 200,
          trackId: "track-a",
          trackExclusive: false,
          speakerIds: [],
          expectedAttendance: null,
          title: "Existing session",
        },
      ],
      rooms: [
        { id: "main", capacity: 100 },
        { id: "second", capacity: 100 },
      ],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies: { ...policies, track: "block" },
    });

    expect(conflicts).not.toContainEqual(
      expect.objectContaining({ type: "track" }),
    );
  });
});
