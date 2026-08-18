import { describe, expect, it } from "vitest";

import {
  formatProgrammeDateTime,
  formatProgrammeDateTimeRange,
  formatProgrammeEventDay,
  formatProgrammeSessionDayTime,
  formatProgrammeTimeRange,
  programmeAccentPalette,
  programmeContrastRatio,
  publicSessionDetailPath,
  publicSessionPagePath,
  publicSpeakerProfilePath,
  sortPublishedSpeakers,
  speakerSurname,
  summarizeProgramme,
} from "./programme-presentation";

function mixHex(foreground: string, background: string, weight: number) {
  const channel = (value: string, start: number) =>
    Number.parseInt(value.slice(start, start + 2), 16);
  return `#${[1, 3, 5]
    .map((start) =>
      Math.round(
        channel(foreground, start) * weight +
          channel(background, start) * (1 - weight),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

describe("programme presentation rules", () => {
  it("builds a server-resolvable public speaker profile path", () => {
    expect(publicSpeakerProfilePath("future/events", "speaker ? one")).toBe(
      "/public/programme/future%2Fevents?speaker=speaker+%3F+one",
    );
  });

  it("builds a server-resolvable public session detail path", () => {
    expect(publicSessionDetailPath("future/events", "session ? one")).toBe(
      "/public/programme/future%2Fevents/sessions?session=session+%3F+one",
    );
  });

  it("keeps shared-itinerary context when opening a session page", () => {
    expect(
      publicSessionPagePath(
        "future-of-events-2027",
        "session-1",
        "?share=itinerary-token&day=2027-06-12&speaker=speaker-1",
      ),
    ).toBe(
      "/public/programme/future-of-events-2027/sessions?share=itinerary-token&day=2027-06-12&session=session-1",
    );
  });

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
      onRawAccent: "#ffffff",
      onDark: "#8d87ee",
      onDarkSolid: "#0f172a",
    });
    expect(programmeAccentPalette("#ffffff")).toMatchObject({
      accent: "#ffffff",
    });
    expect(programmeAccentPalette("#ffffff").ink).not.toBe("#ffffff");
    expect(() => programmeAccentPalette("white")).toThrow(/six-digit/i);
  });

  /* Controls use the derived ink while solid accent fills use the raw colour;
     dark-canvas ink is a third surface. Each needs its own readable foreground. */
  it("derives contrast-safe inks for arbitrary event accents", () => {
    for (const accent of [
      "#9d4a31",
      "#4f46e5",
      "#0f766e",
      "#e11d48",
      "#f97316",
      "#facc15",
      "#84cc16",
      "#ffffff",
      "#000000",
      "#808080",
      "#767676",
      "#78969b",
      "#90eefb",
    ]) {
      const { ink, onAccent, onRawAccent, onDark, onDarkSolid } =
        programmeAccentPalette(accent);
      const lightAccentSoft = mixHex(accent, "#ffffff", 0.08);
      expect(programmeContrastRatio(ink, "#ffffff")).toBeGreaterThanOrEqual(
        4.75,
      );
      expect(programmeContrastRatio(ink, "#f7f5f1")).toBeGreaterThanOrEqual(
        4.75,
      );
      expect(
        programmeContrastRatio(ink, lightAccentSoft),
      ).toBeGreaterThanOrEqual(4.75);
      expect(
        programmeContrastRatio(onRawAccent, accent),
      ).toBeGreaterThanOrEqual(4.5);
      expect(programmeContrastRatio(onAccent, ink)).toBeGreaterThanOrEqual(4.5);
      const accentSoft = mixHex(accent, "#172220", 0.15);
      expect(programmeContrastRatio(onDark, accentSoft)).toBeGreaterThanOrEqual(
        4.75,
      );
      expect(programmeContrastRatio(onDark, "#1c2927")).toBeGreaterThanOrEqual(
        4.75,
      );
      expect(programmeContrastRatio(onDark, "#101817")).toBeGreaterThanOrEqual(
        4.75,
      );
      expect(
        programmeContrastRatio(onDarkSolid, onDark),
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(programmeAccentPalette("#facc15").onRawAccent).not.toBe("#ffffff");
    expect(programmeAccentPalette("#000000").onRawAccent).toBe("#ffffff");
    expect(programmeAccentPalette("#000000").onDark).not.toBe("#000000");
    expect(programmeAccentPalette("#9d4a31").onDark).not.toBe("#d7e4e1");
    expect(programmeAccentPalette("#78969b").onDark).not.toBe("#78969b");
    expect(programmeAccentPalette("#90eefb").ink).toBe("#467384");
  });

  it("checks solid-accent contrast after converting the colour to hex", () => {
    const { onRawAccent } = programmeAccentPalette("#0070fb");
    expect(
      programmeContrastRatio(onRawAccent, "#0070fb"),
    ).toBeGreaterThanOrEqual(4.5);
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

  it("states the day with the clock range for a featured session", () => {
    expect(
      formatProgrammeSessionDayTime(
        Date.parse("2025-05-20T13:00:00Z") / 1_000,
        Date.parse("2025-05-20T13:45:00Z") / 1_000,
        "America/Toronto",
      ),
    ).toBe("Tue, May 20 · 9:00–9:45 AM");
  });

  it("names the start day in the event timezone, not the viewer's", () => {
    expect(
      formatProgrammeSessionDayTime(
        Date.parse("2025-05-21T03:00:00Z") / 1_000,
        Date.parse("2025-05-21T05:00:00Z") / 1_000,
        "America/Toronto",
      ),
    ).toBe("Tue, May 20 · 11:00 PM–Wed, May 21 · 1:00 AM");
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
