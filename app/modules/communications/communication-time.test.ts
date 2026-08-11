import { describe, expect, it } from "vitest";

import {
  assertCommunicationScheduleStillMatchesPreview,
  communicationScheduledEpoch,
} from "./communication-time";

describe("event-local communication scheduling", () => {
  it("converts an event-local wall time to the correct UTC instant", () => {
    expect(
      communicationScheduledEpoch("2027-07-10T09:30", "America/Toronto"),
    ).toBe(Date.parse("2027-07-10T13:30:00Z") / 1_000);
  });

  it("rejects a wall time that does not exist across a DST transition", () => {
    expect(() =>
      communicationScheduledEpoch("2027-03-14T02:30", "America/Toronto"),
    ).toThrow(/does not exist in America\/Toronto/);
  });

  it("rejects incomplete values instead of guessing a timezone", () => {
    expect(() =>
      communicationScheduledEpoch("2027-07-10", "America/Toronto"),
    ).toThrow("complete local date and time");
  });

  it("requires confirmation to match the exact event-local preview instant", () => {
    expect(() =>
      assertCommunicationScheduleStillMatchesPreview("1815232600", 1815232600),
    ).not.toThrow();
    expect(() =>
      assertCommunicationScheduleStillMatchesPreview("1815232600", 1815236200),
    ).toThrow("changed after preview");
    expect(() =>
      assertCommunicationScheduleStillMatchesPreview("", 1815232600),
    ).toThrow("preview is missing");
  });
});
