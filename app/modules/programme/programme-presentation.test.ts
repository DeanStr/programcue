import { describe, expect, it } from "vitest";

import {
  formatProgrammeDateTime,
  formatProgrammeDateTimeRange,
  formatProgrammeEventDay,
  formatProgrammeTimeRange,
  programmeAccentPalette,
  publicProgrammeSessionUrl,
  sortPublishedSpeakers,
  speakerSurname,
  summarizeProgramme,
} from "./programme-presentation";

describe("programme presentation rules", () => {
  it("counts only scheduled public records as published to attendees", () => {
    expect(
      summarizeProgramme([
        { startsAt: 100, visibility: "public" },
        { startsAt: 200, visibility: "private" },
        { startsAt: null, visibility: "public" },
      ]),
    ).toEqual({ total: 3, scheduled: 2, unscheduled: 1, publishedPublic: 1 });
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

  it("keeps arbitrary event accents readable on light and solid surfaces", () => {
    expect(programmeAccentPalette("#4f46e5")).toEqual({
      accent: "#4f46e5",
      ink: "#4f46e5",
      onAccent: "#ffffff",
    });
    expect(programmeAccentPalette("#ffffff")).toMatchObject({
      accent: "#ffffff",
      onAccent: "#ffffff",
    });
    expect(programmeAccentPalette("#ffffff").ink).not.toBe("#ffffff");
    expect(() => programmeAccentPalette("white")).toThrow(/six-digit/i);
  });

  it("keeps calendar links scoped to the requested public event", () => {
    expect(
      publicProgrammeSessionUrl(
        "https://events.example.com",
        "second-event",
        "opening-keynote",
      ),
    ).toBe(
      "https://events.example.com/public/programme/second-event#session-opening-keynote",
    );
  });

  it("orders speakers by surname with deterministic honorific and suffix handling", () => {
    const speakers = [
      { id: "z", displayName: "Dr. Ada Lovelace" },
      { id: "y", displayName: "Grace Hopper Jr." },
      { id: "x", displayName: "van der Waals" },
      { id: "w", displayName: "Madonna" },
      { id: "a", displayName: "Alex Smith" },
      { id: "b", displayName: "Alex Smith" },
    ];

    expect(speakerSurname("Prof. Grace Hopper, PhD")).toBe("Hopper");
    expect(speakerSurname("Lovelace, Ada")).toBe("Lovelace");
    expect(
      sortPublishedSpeakers(speakers).map((speaker) => speaker.id),
    ).toEqual(["y", "z", "w", "a", "b", "x"]);
  });

  it("renders a complete event-local date and time range", () => {
    const range = formatProgrammeDateTimeRange(
      Date.parse("2025-05-20T13:00:00Z") / 1_000,
      Date.parse("2025-05-20T13:45:00Z") / 1_000,
      "America/Toronto",
    );
    expect(range).toContain("Tuesday, May 20, 2025");
    expect(range).toContain("9:00 AM–9:45 AM");
    expect(range).toMatch(/EDT|GMT-4/);
  });

  it("includes both event-local dates for a cross-day session", () => {
    const range = formatProgrammeDateTimeRange(
      Date.parse("2025-05-21T03:00:00Z") / 1_000,
      Date.parse("2025-05-21T05:00:00Z") / 1_000,
      "America/Toronto",
    );
    expect(range).toContain("Tuesday, May 20, 2025 · 11:00 PM EDT");
    expect(range).toContain("Wednesday, May 21, 2025 · 1:00 AM EDT");
  });

  it("includes the end date in a compact cross-day time range", () => {
    expect(
      formatProgrammeTimeRange(
        Date.parse("2025-05-21T03:00:00Z") / 1_000,
        Date.parse("2025-05-21T05:00:00Z") / 1_000,
        "America/Toronto",
      ),
    ).toBe("11:00 PM–Wed, May 21 · 1:00 AM");
  });

  it("includes both offsets when a compact range crosses the repeated hour", () => {
    expect(
      formatProgrammeTimeRange(
        Date.parse("2025-11-02T05:30:00Z") / 1_000,
        Date.parse("2025-11-02T06:30:00Z") / 1_000,
        "America/New_York",
      ),
    ).toMatch(/1:30 AM (?:EDT|GMT-4)–1:30 AM (?:EST|GMT-5)/u);
  });
});
