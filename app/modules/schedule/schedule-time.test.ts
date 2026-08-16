import { describe, expect, it } from "vitest";

import {
  eventBoundaryCalendarDate,
  eventCalendarDayBoundaries,
  eventDayHourlySlots,
  eventDayScheduleSlots,
  eventDayUsableScheduleSlots,
  eventLocalCalendarDate,
  eventLocalEndOfDayEpoch,
  eventLocalExclusiveEndEpoch,
  eventLocalTimeEpoch,
} from "./schedule-time";

describe("event-local schedule time", () => {
  it("treats a UTC-midnight boundary as an event calendar date", () => {
    const boundary = Date.parse("2025-05-20T00:00:00Z") / 1_000;

    expect(eventBoundaryCalendarDate(boundary)).toBe("2025-05-20");
    expect(
      new Date(
        eventLocalTimeEpoch(boundary, "America/Toronto", 9) * 1_000,
      ).toISOString(),
    ).toBe("2025-05-20T13:00:00.000Z");
    expect(eventDayHourlySlots(boundary, "America/Toronto")).toHaveLength(9);
  });

  it("uses the IANA offset in effect on a daylight-saving transition date", () => {
    const melbourneBoundary = Date.parse("2025-10-05T00:00:00Z") / 1_000;
    const londonBoundary = Date.parse("2025-03-30T00:00:00Z") / 1_000;

    expect(
      new Date(
        eventLocalTimeEpoch(melbourneBoundary, "Australia/Melbourne", 9) *
          1_000,
      ).toISOString(),
    ).toBe("2025-10-04T22:00:00.000Z");
    expect(
      new Date(
        eventLocalTimeEpoch(londonBoundary, "Europe/London", 9) * 1_000,
      ).toISOString(),
    ).toBe("2025-03-30T08:00:00.000Z");
  });

  it("resolves the end of an event calendar date in the event timezone", () => {
    const boundary = Date.parse("2025-05-20T00:00:00Z") / 1_000;

    expect(
      new Date(
        eventLocalEndOfDayEpoch(boundary, "America/Toronto") * 1_000,
      ).toISOString(),
    ).toBe("2025-05-21T03:59:59.000Z");
    expect(
      new Date(
        eventLocalEndOfDayEpoch(boundary, "Australia/Melbourne") * 1_000,
      ).toISOString(),
    ).toBe("2025-05-20T13:59:59.000Z");
  });

  it("uses the first valid instant when the following local midnight is skipped", () => {
    const santiagoBoundary = Date.parse("2026-09-05T23:59:59Z") / 1_000;

    expect(
      new Date(
        eventLocalExclusiveEndEpoch(santiagoBoundary, "America/Santiago") *
          1_000,
      ).toISOString(),
    ).toBe("2026-09-06T04:00:00.000Z");
  });

  it("resolves an end-of-day marker at the maximum positive IANA offset", () => {
    const boundary = Date.parse("2026-05-20T23:59:59Z") / 1_000;

    expect(
      new Date(
        eventLocalExclusiveEndEpoch(boundary, "Pacific/Kiritimati") * 1_000,
      ).toISOString(),
    ).toBe("2026-05-20T10:00:00.000Z");
  });

  it("fails when a requested wall-clock time does not exist", () => {
    const springForwardBoundary = Date.parse("2025-03-09T00:00:00Z") / 1_000;

    expect(() =>
      eventLocalTimeEpoch(springForwardBoundary, "America/Toronto", 2),
    ).toThrow(/does not exist/);
  });

  it("builds every event day with half-hour placement slots and preserves exact existing starts", () => {
    const start = Date.parse("2025-05-20T00:00:00Z") / 1_000;
    const end = Date.parse("2025-05-22T23:59:59Z") / 1_000;
    const existingStart = Date.parse("2025-05-21T13:15:00Z") / 1_000;
    const days = eventCalendarDayBoundaries(start, end);

    expect(days.map(eventBoundaryCalendarDate)).toEqual([
      "2025-05-20",
      "2025-05-21",
      "2025-05-22",
    ]);
    expect(eventLocalCalendarDate(existingStart, "America/Toronto")).toBe(
      "2025-05-21",
    );
    expect(
      eventDayScheduleSlots(days[1]!, "America/Toronto", [existingStart]),
    ).toContain(existingStart);
    expect(eventDayScheduleSlots(days[1]!, "America/Toronto")).toHaveLength(48);
    expect(
      eventDayUsableScheduleSlots(days[1]!, "America/Toronto", [existingStart]),
    ).toHaveLength(31);
    expect(
      eventDayUsableScheduleSlots(days[1]!, "America/Toronto", [existingStart]),
    ).toContain(existingStart);
    expect(
      eventDayUsableScheduleSlots(days[1]!, "America/Toronto"),
    ).not.toContain(eventLocalTimeEpoch(days[1]!, "America/Toronto", 0));
  });

  it("uses the actual length of a daylight-saving event day", () => {
    const springForward = Date.parse("2025-03-09T00:00:00Z") / 1_000;
    const fallBack = Date.parse("2025-11-02T00:00:00Z") / 1_000;

    expect(
      eventDayScheduleSlots(springForward, "America/Toronto"),
    ).toHaveLength(46);
    expect(eventDayScheduleSlots(fallBack, "America/Toronto")).toHaveLength(50);
  });
});
