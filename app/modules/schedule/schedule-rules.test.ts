import { describe, expect, it } from "vitest";

import { scheduleConflictFingerprint } from "./schedule-conflict-fingerprint";
import {
  assertPublishable,
  detectScheduleConflicts,
  intervalsOverlap,
  type SpeakerBlackoutWindow,
} from "./schedule-rules";
import { eventLocalTimeEpoch } from "./schedule-time";

const policies = {
  room: "block",
  speaker: "block",
  resource: "block",
  track: "warn",
  boundary: "block",
  capacity: "warn",
  speakerUnavailable: "block",
  minimumTurnaroundMinutes: 0,
} as const;

function detect(
  args: Omit<
    Parameters<typeof detectScheduleConflicts>[0],
    "speakerBlackouts"
  > & {
    speakerBlackouts?: ReadonlyArray<SpeakerBlackoutWindow>;
  },
) {
  return detectScheduleConflicts({
    ...args,
    speakerBlackouts: args.speakerBlackouts ?? [],
  });
}

describe("authoritative schedule rules", () => {
  it("treats touching intervals as non-overlapping", () => {
    expect(intervalsOverlap(100, 200, 200, 300)).toBe(false);
  });

  it("finds room, speaker, resource, track and capacity conflicts", () => {
    const conflicts = detect({
      candidate: {
        sessionId: "new",
        title: "New session",
        roomId: "main",
        startsAt: 150,
        endsAt: 250,
        trackId: "track-a",
        trackExclusive: true,
        speakerIds: ["speaker-a"],
        speakerNames: ["Priya Raman"],
        requiredResources: ["av-kit"],
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
          speakerNames: ["Priya Raman"],
          requiredResources: ["av-kit"],
          expectedAttendance: 40,
          title: "Existing session",
        },
      ],
      rooms: [{ id: "main", capacity: 100, resources: ["av-kit"] }],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies,
    });
    expect(conflicts.map((conflict) => conflict.type)).toEqual([
      "capacity",
      "room",
      "speaker",
      "required_resource",
      "track",
    ]);
    expect(conflicts).toContainEqual(
      expect.objectContaining({
        type: "speaker",
        message:
          "Priya Raman appears in both “New session” and “Existing session”.",
      }),
    );
    expect(() => assertPublishable(conflicts)).toThrow(/3 blocking/);
  });

  it("blocks a session that overlaps a speaker blackout window", () => {
    const conflicts = detect({
      candidate: {
        sessionId: "new",
        title: "Keynote",
        roomId: "main",
        startsAt: 150,
        endsAt: 250,
        trackId: null,
        trackExclusive: false,
        speakerIds: ["speaker-a"],
        speakerNames: ["Priya Raman"],
        requiredResources: [],
        expectedAttendance: null,
      },
      existing: [],
      rooms: [{ id: "main", capacity: 100, resources: [] }],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies,
      speakerBlackouts: [
        {
          id: "window-a",
          personId: "speaker-a",
          startsAt: 200,
          endsAt: 300,
        },
      ],
    });
    expect(conflicts).toEqual([
      expect.objectContaining({
        type: "speaker_unavailable",
        severity: "blocking",
        speakerId: "speaker-a",
        blackoutWindowId: "window-a",
      }),
    ]);
    expect(conflicts[0]?.conflictingEntryId).toBeUndefined();
    expect(conflicts[0]?.message).toContain("Priya Raman");
    expect(conflicts[0]?.message).toContain("Keynote");
  });

  it("allows a session that only touches a blackout and does not apply turnaround to it", () => {
    const conflicts = detect({
      candidate: {
        sessionId: "new",
        title: "Keynote",
        roomId: "main",
        startsAt: 200,
        endsAt: 300,
        trackId: null,
        trackExclusive: false,
        speakerIds: ["speaker-a"],
        speakerNames: ["Priya Raman"],
        requiredResources: [],
        expectedAttendance: null,
      },
      existing: [],
      rooms: [{ id: "main", capacity: 100, resources: [] }],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies: { ...policies, minimumTurnaroundMinutes: 15 },
      speakerBlackouts: [
        {
          id: "window-a",
          personId: "speaker-a",
          startsAt: 100,
          endsAt: 200,
        },
      ],
    });
    expect(conflicts).toEqual([]);
  });

  it("records one unavailability conflict per speaker and window", () => {
    const conflicts = detect({
      candidate: {
        sessionId: "new",
        title: "Panel",
        roomId: "main",
        startsAt: 100,
        endsAt: 400,
        trackId: null,
        trackExclusive: false,
        speakerIds: ["speaker-a", "speaker-b"],
        speakerNames: ["Priya Raman", "Alex Morgan"],
        requiredResources: [],
        expectedAttendance: null,
      },
      existing: [],
      rooms: [{ id: "main", capacity: 100, resources: [] }],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies,
      speakerBlackouts: [
        {
          id: "window-a1",
          personId: "speaker-a",
          startsAt: 50,
          endsAt: 150,
        },
        {
          id: "window-a2",
          personId: "speaker-a",
          startsAt: 300,
          endsAt: 450,
        },
        {
          id: "window-b",
          personId: "speaker-b",
          startsAt: 200,
          endsAt: 250,
        },
      ],
    });
    expect(
      conflicts.map((conflict) => [
        conflict.speakerId,
        conflict.blackoutWindowId,
      ]),
    ).toEqual([
      ["speaker-a", "window-a1"],
      ["speaker-a", "window-a2"],
      ["speaker-b", "window-b"],
    ]);
  });

  it("fingerprints unavailability by entry, speaker and window", () => {
    expect(
      scheduleConflictFingerprint("entry-a", {
        type: "speaker_unavailable",
        speakerId: "speaker-a",
        blackoutWindowId: "window-a",
      }),
    ).toBe("speaker_unavailable:entry-a:speaker-a:window-a");
    expect(
      scheduleConflictFingerprint("entry-a", {
        type: "room",
        conflictingEntryId: "entry-b",
      }),
    ).toBe(
      scheduleConflictFingerprint("entry-b", {
        type: "room",
        conflictingEntryId: "entry-a",
      }),
    );
    expect(() =>
      scheduleConflictFingerprint("entry-a", { type: "speaker_unavailable" }),
    ).toThrow(/speaker and window identifiers/);
    expect(
      scheduleConflictFingerprint("entry-a", {
        type: "resource_configuration",
        resource: "av-kit",
      }),
    ).toBe("resource_configuration:entry-a:av-kit");
    expect(
      scheduleConflictFingerprint("entry-a", {
        type: "resource_configuration",
        resource: "av-kit",
      }),
    ).not.toBe(
      scheduleConflictFingerprint("entry-a", {
        type: "resource_configuration",
        resource: "livestream crew",
      }),
    );
    expect(() =>
      scheduleConflictFingerprint("entry-a", {
        type: "room_resource",
      }),
    ).toThrow(/resource identifier/);
  });

  it("always blocks an entry outside event bounds", () => {
    const conflicts = detect({
      candidate: {
        sessionId: "new",
        title: "New session",
        roomId: "main",
        startsAt: -1,
        endsAt: 30,
        trackId: null,
        trackExclusive: false,
        speakerIds: [],
        speakerNames: [],
        requiredResources: [],
        expectedAttendance: null,
      },
      existing: [],
      rooms: [{ id: "main", capacity: 100, resources: [] }],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies: {
        room: "ignore",
        speaker: "ignore",
        resource: "ignore",
        track: "ignore",
        boundary: "block",
        capacity: "ignore",
        speakerUnavailable: "block",
        minimumTurnaroundMinutes: 0,
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
      detect({
        candidate: {
          sessionId: "new",
          title: "New session",
          roomId: "main",
          startsAt,
          endsAt,
          trackId: null,
          trackExclusive: false,
          speakerIds: [],
          speakerNames: [],
          requiredResources: [],
          expectedAttendance: null,
        },
        existing: [],
        rooms: [{ id: "main", capacity: 100, resources: [] }],
        eventStartsAt: firstDayMarker,
        eventEndsAt: lastDayMarker,
        eventTimezone: timezone,
        policies: {
          room: "ignore",
          speaker: "ignore",
          resource: "ignore",
          track: "ignore",
          boundary: "block",
          capacity: "ignore",
          speakerUnavailable: "block",
          minimumTurnaroundMinutes: 0,
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

  it("does not throw when an event date skips local midnight", () => {
    const lastDayMarker = Date.parse("2026-09-05T23:59:59Z") / 1_000;
    const start = eventLocalTimeEpoch(
      Date.parse("2026-09-05T00:00:00Z") / 1_000,
      "America/Santiago",
      9,
    );
    expect(() =>
      detect({
        candidate: {
          sessionId: "new",
          title: "Santiago session",
          roomId: "main",
          startsAt: start,
          endsAt: start + 3_600,
          trackId: null,
          trackExclusive: false,
          speakerIds: [],
          speakerNames: [],
          requiredResources: [],
          expectedAttendance: null,
        },
        existing: [],
        rooms: [{ id: "main", capacity: 100, resources: [] }],
        eventStartsAt: Date.parse("2026-09-04T00:00:00Z") / 1_000,
        eventEndsAt: lastDayMarker,
        eventTimezone: "America/Santiago",
        policies: {
          room: "ignore",
          speaker: "ignore",
          resource: "ignore",
          track: "ignore",
          boundary: "block",
          capacity: "ignore",
          speakerUnavailable: "block",
          minimumTurnaroundMinutes: 0,
        },
      }),
    ).not.toThrow();
  });

  it("blocks an overlap when the existing session already owns the exclusive track", () => {
    const conflicts = detect({
      candidate: {
        sessionId: "new",
        title: "New session",
        roomId: "second",
        startsAt: 150,
        endsAt: 250,
        trackId: "track-a",
        trackExclusive: false,
        speakerIds: [],
        speakerNames: [],
        requiredResources: [],
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
          trackExclusive: true,
          speakerIds: [],
          speakerNames: [],
          requiredResources: [],
          expectedAttendance: null,
          title: "Existing exclusive session",
        },
      ],
      rooms: [
        { id: "main", capacity: 100, resources: [] },
        { id: "second", capacity: 100, resources: [] },
      ],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies: { ...policies, track: "block" },
    });

    expect(conflicts).toContainEqual(
      expect.objectContaining({
        type: "track",
        severity: "blocking",
        message: "Track overlaps “Existing exclusive session”.",
      }),
    );
  });

  it("allows overlapping sessions on a non-exclusive track", () => {
    const conflicts = detect({
      candidate: {
        sessionId: "new",
        title: "New session",
        roomId: "second",
        startsAt: 150,
        endsAt: 250,
        trackId: "track-a",
        trackExclusive: false,
        speakerIds: [],
        speakerNames: [],
        requiredResources: [],
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
          speakerNames: [],
          requiredResources: [],
          expectedAttendance: null,
          title: "Existing session",
        },
      ],
      rooms: [
        { id: "main", capacity: 100, resources: [] },
        { id: "second", capacity: 100, resources: [] },
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

  it("enforces configured speaker turnaround without treating touching slots as overlaps", () => {
    const conflicts = detect({
      candidate: {
        sessionId: "new",
        title: "New session",
        roomId: "second",
        startsAt: 215,
        endsAt: 300,
        trackId: null,
        trackExclusive: false,
        speakerIds: ["speaker-a"],
        speakerNames: ["Priya Raman"],
        requiredResources: [],
        expectedAttendance: null,
      },
      existing: [
        {
          entryId: "entry-existing",
          sessionId: "existing",
          roomId: "main",
          startsAt: 100,
          endsAt: 200,
          trackId: null,
          trackExclusive: false,
          speakerIds: ["speaker-a"],
          speakerNames: ["Priya Raman"],
          requiredResources: [],
          expectedAttendance: null,
          title: "Existing session",
        },
      ],
      rooms: [
        { id: "main", capacity: 100, resources: [] },
        { id: "second", capacity: 100, resources: [] },
      ],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies: { ...policies, minimumTurnaroundMinutes: 1 },
    });

    expect(conflicts).toEqual([
      expect.objectContaining({ type: "turnaround", severity: "blocking" }),
    ]);
  });

  it("blocks unconfigured resources and resources unavailable in the selected room", () => {
    const base = {
      candidate: {
        sessionId: "new",
        title: "New session",
        roomId: "second",
        startsAt: 100,
        endsAt: 200,
        trackId: null,
        trackExclusive: false,
        speakerIds: [] as string[],
        speakerNames: [] as string[],
        expectedAttendance: null,
      },
      existing: [],
      rooms: [
        { id: "main", capacity: 100, resources: ["livestream crew"] },
        { id: "second", capacity: 100, resources: [] },
      ],
      eventStartsAt: 0,
      eventEndsAt: 86_399,
      eventTimezone: "UTC",
      policies: { ...policies, resource: "ignore" as const },
    };

    expect(
      detect({
        ...base,
        candidate: {
          ...base.candidate,
          requiredResources: ["unconfigured kit", "second kit"],
        },
      }).map((conflict) => [conflict.type, conflict.resource]),
    ).toEqual([
      ["resource_configuration", "unconfigured kit"],
      ["resource_configuration", "second kit"],
    ]);
    expect(
      detect({
        ...base,
        candidate: {
          ...base.candidate,
          requiredResources: ["unconfigured kit"],
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        type: "resource_configuration",
        severity: "blocking",
      }),
    );
    expect(
      detect({
        ...base,
        candidate: {
          ...base.candidate,
          requiredResources: ["livestream crew"],
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        type: "room_resource",
        severity: "blocking",
      }),
    );
  });
});
