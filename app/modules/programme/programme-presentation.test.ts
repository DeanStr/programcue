import { describe, expect, it } from "vitest";

import { formatProgrammeDateTime, formatProgrammeEventDay, publicProgrammeSessionUrl, summarizeProgramme } from "./programme-presentation";

describe("programme presentation rules", () => {
  it("counts only scheduled public records as published to attendees", () => {
    expect(summarizeProgramme([
      { startsAt: 100, visibility: "public" },
      { startsAt: 200, visibility: "private" },
      { startsAt: null, visibility: "public" },
    ])).toEqual({ total: 3, scheduled: 2, unscheduled: 1, publishedPublic: 1 });
  });

  it("renders an instant in the event timezone with an explicit zone", () => {
    const epoch = Date.parse("2025-05-20T13:00:00Z") / 1_000;
    const formatted = formatProgrammeDateTime(epoch, "America/Toronto");

    expect(formatted).toContain("May 20, 2025");
    expect(formatted).toContain("9:00 AM");
    expect(formatted).toMatch(/EDT|GMT-4/);
  });

  it("renders a date-only event boundary without treating it as an instant", () => {
    expect(formatProgrammeEventDay("2025-05-20")).toBe("Tuesday, May 20");
    expect(() => formatProgrammeEventDay("2025-02-30")).toThrow(/invalid/i);
  });

  it("keeps calendar links scoped to the requested public event", () => {
    expect(publicProgrammeSessionUrl(
      "https://events.example.com",
      "second-event",
      "opening-keynote",
    )).toBe("https://events.example.com/public/programme/second-event#session-opening-keynote");
  });
});
