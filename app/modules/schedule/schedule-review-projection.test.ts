import { describe, expect, it } from "vitest";

import {
  buildScheduleReviewProjection,
  hashScheduleReviewProjection,
  parseScheduleReviewProjection,
  SCHEDULE_REVIEW_PROJECTION_MAX_BYTES,
  ScheduleReviewProjectionError,
  serializeScheduleReviewProjection,
} from "./schedule-review-projection";

const entry = {
  id: "entry-2",
  startsAt: 1_800,
  endsAt: 2_400,
  title: "Beta",
  formatLabel: "Panel",
  roomName: "Hall",
  trackName: "Ops",
  speakers: ["Jordan"],
};

describe("schedule review projection", () => {
  it("serializes only the allowlisted keys in stable order", async () => {
    const projection = buildScheduleReviewProjection({
      eventName: "Future of Events",
      timezone: "America/Toronto",
      entries: [
        entry,
        {
          ...entry,
          id: "entry-1",
          startsAt: 1_200,
          title: "Alpha",
          speakers: ["Priya", "Alex"],
          trackName: null,
        },
      ],
    });
    const serialized = serializeScheduleReviewProjection(projection);
    expect(JSON.parse(serialized)).toEqual({
      schemaVersion: 1,
      event: { name: "Future of Events", timezone: "America/Toronto" },
      entries: [
        {
          startsAt: 1_200,
          endsAt: 2_400,
          title: "Alpha",
          format: "Panel",
          room: "Hall",
          track: null,
          speakers: ["Priya", "Alex"],
        },
        {
          startsAt: 1_800,
          endsAt: 2_400,
          title: "Beta",
          format: "Panel",
          room: "Hall",
          track: "Ops",
          speakers: ["Jordan"],
        },
      ],
    });
    expect(serialized).not.toContain("entry-1");
    expect(parseScheduleReviewProjection(serialized)).toEqual(
      JSON.parse(serialized),
    );
    await expect(hashScheduleReviewProjection(serialized)).resolves.toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(await hashScheduleReviewProjection(serialized)).toBe(
      await hashScheduleReviewProjection(serialized),
    );
  });

  it("uses the internal entry id only as a non-serialized sort tie-breaker", () => {
    const serialized = serializeScheduleReviewProjection(
      buildScheduleReviewProjection({
        eventName: "Future of Events",
        timezone: "UTC",
        entries: [
          { ...entry, id: "z", title: "Same" },
          { ...entry, id: "a", title: "Same" },
        ],
      }),
    );
    expect(JSON.parse(serialized).entries).toHaveLength(2);
    expect(serialized).not.toContain('"id"');
  });

  it("rejects unknown keys and oversized snapshots", () => {
    expect(() =>
      parseScheduleReviewProjection(
        JSON.stringify({
          schemaVersion: 1,
          event: { name: "Future of Events", timezone: "UTC" },
          entries: [],
          extra: true,
        }),
      ),
    ).toThrow(ScheduleReviewProjectionError);

    const huge = buildScheduleReviewProjection({
      eventName: "Future of Events",
      timezone: "UTC",
      entries: Array.from({ length: 180 }, (_, index) => ({
        ...entry,
        id: `entry-${index}`,
        title: "T".repeat(240),
        speakers: Array.from({ length: 50 }, () => "N".repeat(120)),
      })),
    });
    expect(() => serializeScheduleReviewProjection(huge)).toThrow(
      /larger than 1 MiB/i,
    );
    expect(SCHEDULE_REVIEW_PROJECTION_MAX_BYTES).toBe(1_048_576);
  });

  it("rejects an invalid timezone as a projection error rather than a raw schema throw", () => {
    expect(() =>
      buildScheduleReviewProjection({
        eventName: "Future of Events",
        timezone: "Not/AZone",
        entries: [entry],
      }),
    ).toThrow(ScheduleReviewProjectionError);
  });
});
