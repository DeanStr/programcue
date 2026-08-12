import { describe, expect, it } from "vitest";

import { computeAutoPlacements } from "./schedule-auto-placement";
import { autoPlacementD1StatementCount } from "./schedule-auto-placement-workflow.server";
import type { ScheduleWorkspace } from "./schedule-service.server";
import { eventLocalTimeEpoch } from "./schedule-time";

const eventStartsAt = Date.parse("2025-05-20T00:00:00Z") / 1_000;
const eventEndsAt = Date.parse("2025-05-20T23:59:59Z") / 1_000;

const blockingPolicies = {
  room: "block",
  speaker: "block",
  resource: "block",
  track: "block",
  boundary: "block",
  capacity: "block",
  minimumTurnaroundMinutes: 0,
} as const;

function session(
  id: string,
  title: string,
  overrides: Partial<ScheduleWorkspace["sessions"][number]> = {},
): ScheduleWorkspace["sessions"][number] {
  return {
    id,
    title,
    slug: id,
    description: "",
    trackId: null,
    trackName: null,
    trackExclusive: false,
    format: "presentation",
    durationMinutes: 60,
    expectedAttendance: null,
    requiredResources: [],
    visibility: "public",
    contentStatus: "draft",
    contentRevision: 1,
    speakerIds: [],
    speakerNames: [],
    status: "unscheduled",
    revision: 1,
    ...overrides,
  };
}

function workspace(
  sessions: ScheduleWorkspace["sessions"],
  overrides: Partial<ScheduleWorkspace> = {},
): ScheduleWorkspace {
  return {
    event: {
      id: "event-1",
      name: "Test event",
      startsAt: eventStartsAt,
      endsAt: eventEndsAt,
      timezone: "UTC",
      brandAccent: "#000000",
      revision: 1,
      repositoryProvider: "d1",
      sessionFormatsJson: "[]",
    },
    version: {
      id: "version-1",
      versionNumber: 1,
      status: "draft",
      revision: 4,
      notes: "",
    },
    rooms: [
      {
        id: "main",
        name: "Main room",
        position: 0,
        capacity: 100,
        resources: ["projector"],
      },
      {
        id: "second",
        name: "Second room",
        position: 1,
        capacity: 100,
        resources: ["projector"],
      },
    ],
    tracks: [],
    sessionFormats: [],
    sessions,
    entries: [],
    conflicts: [],
    publicationConflicts: [],
    policies: blockingPolicies,
    policyRevision: 1,
    ...overrides,
  };
}

describe("deterministic auto-placement", () => {
  it("counts the atomic D1 statements, including persisted warnings", () => {
    const proposal = {
      sessionId: "session",
      roomId: "main",
      startsAt: eventStartsAt,
      endsAt: eventStartsAt + 3_600,
      warnings: [],
    };
    const warning = {
      type: "room" as const,
      severity: "warning" as const,
      message: "A warning was detected.",
    };

    expect(autoPlacementD1StatementCount({ placements: [] })).toBe(3);
    expect(
      autoPlacementD1StatementCount({
        placements: [
          proposal,
          { ...proposal, sessionId: "session-2", warnings: [warning] },
        ],
      }),
    ).toBe(11);
  });

  it("places multiple sessions in stable first-fit order without moving an existing entry", () => {
    const fixedStart = eventLocalTimeEpoch(eventStartsAt, "UTC", 7);
    const input = workspace(
      [
        session("fixed", "Fixed session", {
          status: "scheduled",
          speakerIds: ["speaker-fixed"],
        }),
        session("beta", "Beta session"),
        session("alpha", "Alpha session"),
      ],
      {
        entries: [
          {
            id: "fixed-entry",
            sessionId: "fixed",
            roomId: "main",
            startsAt: fixedStart,
            endsAt: fixedStart + 3_600,
            revision: 1,
          },
        ],
      },
    );

    const result = computeAutoPlacements(input);

    expect(result.placements).toEqual([
      expect.objectContaining({
        sessionId: "alpha",
        roomId: "second",
        startsAt: fixedStart,
        endsAt: fixedStart + 3_600,
      }),
      expect.objectContaining({
        sessionId: "beta",
        roomId: "main",
        startsAt: fixedStart + 3_600,
        endsAt: fixedStart + 7_200,
      }),
    ]);
    expect(result.unplaced).toEqual([]);
    expect(input.entries).toHaveLength(1);
    expect(result).toEqual(computeAutoPlacements(input));
  });

  it("respects speaker conflicts even when another room is available", () => {
    const fixedStart = eventLocalTimeEpoch(eventStartsAt, "UTC", 7);
    const input = workspace(
      [
        session("fixed", "Fixed session", {
          status: "scheduled",
          speakerIds: ["speaker-1"],
        }),
        session("new", "New session", { speakerIds: ["speaker-1"] }),
      ],
      {
        entries: [
          {
            id: "fixed-entry",
            sessionId: "fixed",
            roomId: "main",
            startsAt: fixedStart,
            endsAt: fixedStart + 3_600,
            revision: 1,
          },
        ],
      },
    );

    const result = computeAutoPlacements(input);

    expect(result.placements[0]).toMatchObject({
      sessionId: "new",
      startsAt: fixedStart + 3_600,
      roomId: "main",
    });
  });

  it("keeps impossible duration, resource and capacity proposals unplaced with useful reasons", () => {
    const invalidDuration = workspace([
      session("invalid-duration", "Invalid duration", { durationMinutes: 0 }),
    ]);
    expect(computeAutoPlacements(invalidDuration).unplaced[0]).toEqual(
      expect.objectContaining({
        sessionId: "invalid-duration",
        reason: expect.stringContaining("positive whole number"),
      }),
    );

    const tooLong = workspace([
      session("too-long", "Too long", { durationMinutes: 1_500 }),
    ]);
    expect(computeAutoPlacements(tooLong).unplaced[0]).toEqual(
      expect.objectContaining({
        sessionId: "too-long",
        reason: expect.stringContaining("working day"),
      }),
    );

    const missingResource = workspace([
      session("needs-lights", "Needs lights", {
        requiredResources: ["lighting desk"],
      }),
    ]);
    expect(computeAutoPlacements(missingResource).unplaced[0]).toEqual(
      expect.objectContaining({
        sessionId: "needs-lights",
        reason: expect.stringContaining("not configured"),
      }),
    );

    const capacity = workspace(
      [session("large", "Large audience", { expectedAttendance: 200 })],
      {
        rooms: [
          {
            id: "small",
            name: "Small room",
            position: 0,
            capacity: 10,
            resources: [],
          },
        ],
      },
    );
    expect(computeAutoPlacements(capacity).unplaced[0]).toEqual(
      expect.objectContaining({
        sessionId: "large",
        reason: expect.stringContaining("capacity"),
      }),
    );
  });

  it("fails rather than defaulting an invalid room ordering position", () => {
    const input = workspace([session("new", "New session")], {
      rooms: [
        {
          id: "invalid",
          name: "Invalid room",
          position: Number.NaN,
          capacity: 100,
          resources: [],
        },
      ],
    });

    expect(() => computeAutoPlacements(input)).toThrow(
      /invalid ordering position/i,
    );
  });

  it("respects blocking track conflicts and session durations in the first-fit result", () => {
    const fixedStart = eventLocalTimeEpoch(eventStartsAt, "UTC", 7);
    const input = workspace(
      [
        session("fixed", "Fixed track session", {
          status: "scheduled",
          trackId: "track-1",
          trackExclusive: true,
        }),
        session("new", "New track session", {
          trackId: "track-1",
          trackExclusive: true,
          durationMinutes: 90,
        }),
      ],
      {
        entries: [
          {
            id: "fixed-entry",
            sessionId: "fixed",
            roomId: "main",
            startsAt: fixedStart,
            endsAt: fixedStart + 3_600,
            revision: 1,
          },
        ],
      },
    );

    const result = computeAutoPlacements(input);

    expect(result.placements[0]).toMatchObject({
      sessionId: "new",
      roomId: "main",
      startsAt: fixedStart + 3_600,
      endsAt: fixedStart + 9_000,
    });
  });

  it("rejects a late candidate that overruns the working day and continues on the next event day", () => {
    const secondDay = eventStartsAt + 24 * 60 * 60;
    const occupiedStart = eventLocalTimeEpoch(eventStartsAt, "UTC", 7);
    const occupiedEnd = eventLocalTimeEpoch(eventStartsAt, "UTC", 21, 30);
    const input = workspace(
      [
        session("fixed", "Fixed session", { status: "scheduled" }),
        session("new", "Late workshop", { durationMinutes: 90 }),
      ],
      {
        event: {
          ...workspace([]).event,
          endsAt: secondDay + 23 * 60 * 60 + 59 * 60 + 59,
        },
        rooms: [workspace([]).rooms[0]!],
        entries: [
          {
            id: "fixed-entry",
            sessionId: "fixed",
            roomId: "main",
            startsAt: occupiedStart,
            endsAt: occupiedEnd,
            revision: 1,
          },
        ],
      },
    );

    expect(computeAutoPlacements(input).placements[0]).toMatchObject({
      sessionId: "new",
      startsAt: eventLocalTimeEpoch(secondDay, "UTC", 7),
      endsAt: eventLocalTimeEpoch(secondDay, "UTC", 8, 30),
    });
  });

  it("does not place a 60-minute session at 21:30", () => {
    const occupiedStart = eventLocalTimeEpoch(eventStartsAt, "UTC", 7);
    const occupiedEnd = eventLocalTimeEpoch(eventStartsAt, "UTC", 21, 30);
    const input = workspace(
      [
        session("fixed", "Fixed session", { status: "scheduled" }),
        session("new", "Late session", { durationMinutes: 60 }),
      ],
      {
        rooms: [workspace([]).rooms[0]!],
        entries: [
          {
            id: "fixed-entry",
            sessionId: "fixed",
            roomId: "main",
            startsAt: occupiedStart,
            endsAt: occupiedEnd,
            revision: 1,
          },
        ],
      },
    );

    expect(computeAutoPlacements(input)).toMatchObject({
      placements: [],
      unplaced: [
        expect.objectContaining({
          sessionId: "new",
        }),
      ],
    });
  });

  it("accepts an exact 22:00 end on a daylight-saving transition day", () => {
    const transitionDay = Date.parse("2025-11-02T00:00:00Z") / 1_000;
    const occupiedStart = eventLocalTimeEpoch(
      transitionDay,
      "America/Toronto",
      7,
    );
    const occupiedEnd = eventLocalTimeEpoch(
      transitionDay,
      "America/Toronto",
      21,
      30,
    );
    const input = workspace(
      [
        session("fixed", "Fixed session", { status: "scheduled" }),
        session("new", "Closing session", { durationMinutes: 30 }),
      ],
      {
        event: {
          ...workspace([]).event,
          startsAt: transitionDay,
          endsAt: transitionDay + 23 * 60 * 60 + 59 * 60 + 59,
          timezone: "America/Toronto",
        },
        rooms: [workspace([]).rooms[0]!],
        entries: [
          {
            id: "fixed-entry",
            sessionId: "fixed",
            roomId: "main",
            startsAt: occupiedStart,
            endsAt: occupiedEnd,
            revision: 1,
          },
        ],
      },
    );

    expect(computeAutoPlacements(input).placements[0]).toMatchObject({
      startsAt: occupiedEnd,
      endsAt: eventLocalTimeEpoch(
        transitionDay,
        "America/Toronto",
        22,
      ),
    });
  });
});
