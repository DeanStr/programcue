import { describe, expect, it } from "vitest";

import { speakerBlackoutCreateSchema } from "./speaker-availability-schema";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    eventRevision: "11",
    startDate: "2027-05-21",
    endDate: "2027-05-21",
    startTime: "09:00",
    endTime: "10:00",
    allDay: false,
    note: "Travel buffer",
    ...overrides,
  };
}

describe("speakerBlackoutCreateSchema", () => {
  it("accepts an all-day window when FormData omitted the unmounted time fields", () => {
    expect(
      speakerBlackoutCreateSchema.parse(
        payload({
          startTime: null,
          endTime: null,
          allDay: "true",
        }),
      ),
    ).toMatchObject({
      eventRevision: 11,
      startDate: "2027-05-21",
      endDate: "2027-05-21",
      startTime: undefined,
      endTime: undefined,
      allDay: true,
      note: "Travel buffer",
    });
  });

  it("treats empty all-day time fields as absent", () => {
    expect(
      speakerBlackoutCreateSchema.parse(
        payload({
          startTime: "",
          endTime: "  ",
          allDay: true,
        }),
      ),
    ).toMatchObject({
      startTime: undefined,
      endTime: undefined,
      allDay: true,
    });
  });

  it("still requires times when the period is not all day", () => {
    expect(() =>
      speakerBlackoutCreateSchema.parse(
        payload({
          startTime: null,
          endTime: null,
          allDay: false,
        }),
      ),
    ).toThrow(/start time/i);
  });

  it("rejects an invalid clock even when all day is set", () => {
    expect(() =>
      speakerBlackoutCreateSchema.parse(
        payload({
          startTime: "25:00",
          endTime: null,
          allDay: true,
        }),
      ),
    ).toThrow(/valid time/i);
  });
});
