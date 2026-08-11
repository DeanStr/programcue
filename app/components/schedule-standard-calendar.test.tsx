import { describe, expect, it } from "vitest";

import { scheduleStandardFirstDay } from "./schedule-standard-calendar";

describe("standard schedule calendar presentation", () => {
  it("starts a conference week on the event's first calendar day", () => {
    expect(
      scheduleStandardFirstDay(Date.UTC(2025, 4, 20, 9, 0, 0) / 1_000),
    ).toBe(2);
  });
});
