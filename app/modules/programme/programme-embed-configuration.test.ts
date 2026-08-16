import { describe, expect, it } from "vitest";

import {
  defaultProgrammeEmbedConfiguration,
  managedProgrammeEmbedUrl,
  managedProgrammeWidgetSnippet,
  parsePersistedProgrammeEmbedConfiguration,
  parseProgrammeEmbedControls,
  parseProgrammeEmbedDensity,
  parseProgrammeEmbedFields,
  parseProgrammeEmbedHeight,
  parseProgrammeEmbedSearchParameters,
  parseProgrammeEmbedSpeakerDirectory,
  parseProgrammeEmbedSurface,
  parseProgrammeEmbedTheme,
  programmeEmbedFilterOptions,
  programmeEmbedUrl,
  programmeIframeSnippet,
  programmeWidgetSnippet,
} from "./programme-embed-configuration";

describe("programme embed configuration", () => {
  it("offers only values that can appear in the public programme", () => {
    expect(
      programmeEmbedFilterOptions(
        [
          {
            startsAt: Date.parse("2025-05-20T13:00:00Z") / 1_000,
            status: "published",
            visibility: "public",
            track: "Public track",
            format: "keynote",
            room: "Main stage",
          },
          {
            startsAt: Date.parse("2025-05-21T13:00:00Z") / 1_000,
            status: "scheduled",
            visibility: "public",
            track: "Not published",
            format: "workshop",
            room: "Room 2",
          },
          {
            startsAt: Date.parse("2025-05-21T14:00:00Z") / 1_000,
            status: "published",
            visibility: "private",
            track: "Private session",
            format: "panel",
            room: "Room 3",
          },
        ],
        "America/Toronto",
      ),
    ).toEqual({
      days: ["2025-05-20"],
      tracks: ["Public track"],
      formats: ["keynote"],
      rooms: ["Main stage"],
    });
  });

  it("serializes only selected, allowlisted embed behavior", () => {
    const configuration = {
      ...defaultProgrammeEmbedConfiguration(),
      day: "2025-05-21",
      track: "AI & Innovation",
      format: "breakout",
      room: "Room 303",
      query: "  better data  ",
      accent: "#0d9488",
      controls: ["search", "day"] as const,
      density: "compact" as const,
      showSpeakerDirectory: false,
      fields: ["time", "description"] as const,
    };
    expect(
      programmeEmbedUrl("https://events.example.com", "future-of-events-2027", {
        ...configuration,
        controls: [...configuration.controls],
        fields: [...configuration.fields],
      }),
    ).toBe(
      "https://events.example.com/embed/future-of-events-2027/sessions?day=2025-05-21&track=AI+%26+Innovation&format=breakout&room=Room+303&query=better+data&accent=%230d9488&controls=search%2Cday&density=compact&directory=hide&fields=time%2Cdescription",
    );
  });

  it("keeps the default embed bound to the event's live brand colour", () => {
    expect(
      programmeEmbedUrl(
        "https://events.example.com",
        "future-of-events-2027",
        defaultProgrammeEmbedConfiguration(),
      ),
    ).toBe("https://events.example.com/embed/future-of-events-2027/sessions");
    expect(
      programmeEmbedUrl("https://events.example.com", "event", {
        ...defaultProgrammeEmbedConfiguration(),
        surface: "gallery",
        showSpeakerDirectory: false,
      }),
    ).toBe("https://events.example.com/embed/event/gallery");
  });

  it("accepts only explicit widget surfaces and allowlisted visible fields", () => {
    expect(parseProgrammeEmbedSurface(undefined)).toBe("sessions");
    expect(parseProgrammeEmbedSurface("gallery")).toBe("gallery");
    expect(() => parseProgrammeEmbedSurface("timeline")).toThrow(
      /surface must be sessions, speakers, agenda, schedule or gallery/i,
    );
    expect(parseProgrammeEmbedFields("time,location,description")).toEqual([
      "time",
      "location",
      "description",
    ]);
    expect(parseProgrammeEmbedFields("none")).toEqual([]);
    expect(parseProgrammeEmbedFields("speaker-details")).toEqual([
      "speaker-details",
    ]);
    expect(() => parseProgrammeEmbedFields("time,time")).toThrow(
      /unique comma-separated selection/i,
    );
    expect(() => parseProgrammeEmbedFields("time,sponsors")).toThrow(
      /unique comma-separated selection/i,
    );
  });

  it("rejects malformed control, field, density and speaker options", () => {
    expect(() => parseProgrammeEmbedControls("search,search")).toThrow(
      /unique comma-separated selection/i,
    );
    expect(() => parseProgrammeEmbedControls("search,unknown")).toThrow(
      /unique comma-separated selection/i,
    );
    expect(parseProgrammeEmbedControls("none")).toEqual([]);
    expect(() => parseProgrammeEmbedDensity("dense")).toThrow(
      /comfortable or compact/i,
    );
    expect(() => parseProgrammeEmbedSpeakerDirectory("maybe")).toThrow(
      /show or hide/i,
    );
    expect(parseProgrammeEmbedTheme("dark")).toBe("dark");
    expect(parseProgrammeEmbedTheme(null)).toBe("system");
    expect(() => parseProgrammeEmbedTheme("brand")).toThrow(
      /light, dark or system/i,
    );
    expect(() =>
      parseProgrammeEmbedSearchParameters(
        new URLSearchParams("fields=time,unknown"),
      ),
    ).toThrow(/supported public fields/i);
  });

  it("serializes an explicit controlled theme", () => {
    const configuration = {
      ...defaultProgrammeEmbedConfiguration(),
      theme: "dark" as const,
    };
    expect(
      programmeEmbedUrl(
        "https://events.example.com",
        "future-of-events-2027",
        configuration,
      ),
    ).toBe(
      "https://events.example.com/embed/future-of-events-2027/sessions?theme=dark",
    );
    expect(
      programmeWidgetSnippet({
        origin: "https://events.example.com",
        eventSlug: "future-of-events-2027",
        target: "programme-widget",
        title: "Programme",
        configuration,
      }),
    ).toContain('data-theme="dark"');
  });

  it("parses supported parameters and rejects empty, unknown or duplicate input", () => {
    expect(
      parseProgrammeEmbedSearchParameters(
        new URLSearchParams(
          "day=2027-05-20&track=AI&format=panel&room=Main&accent=%230d9488",
        ),
      ),
    ).toMatchObject({
      day: "2027-05-20",
      track: "AI",
      format: "panel",
      room: "Main",
      accent: "#0d9488",
    });
    expect(() =>
      parseProgrammeEmbedSearchParameters(new URLSearchParams("day=")),
    ).toThrow(/embed day must not be empty/i);
    expect(() =>
      parseProgrammeEmbedSearchParameters(
        new URLSearchParams("densitty=compact"),
      ),
    ).toThrow(/unsupported parameter/i);
    expect(() =>
      parseProgrammeEmbedSearchParameters(
        new URLSearchParams("density=compact&density=comfortable"),
      ),
    ).toThrow(/density must appear at most once/i);
    expect(
      parseProgrammeEmbedSearchParameters(new URLSearchParams("query=")).query,
    ).toBe("");
  });

  it("rejects invalid generated configuration before producing install code", () => {
    expect(() =>
      programmeEmbedUrl("https://events.example.com", "event", {
        ...defaultProgrammeEmbedConfiguration(),
        accent: "red",
      }),
    ).toThrow(/six-digit hexadecimal colour/i);
    expect(() =>
      programmeEmbedUrl("https://events.example.com", "event", {
        ...defaultProgrammeEmbedConfiguration(),
        room: "r".repeat(121),
      }),
    ).toThrow(/at most 120 characters/i);
    expect(() =>
      programmeEmbedUrl("https://events.example.com", "event", {
        ...defaultProgrammeEmbedConfiguration(),
        day: "2025-02-30",
      }),
    ).toThrow(/valid YYYY-MM-DD date/i);
    expect(() =>
      programmeEmbedUrl("https://events.example.com", "event", {
        ...defaultProgrammeEmbedConfiguration(),
        showSpeakerDirectory: "false" as never,
      }),
    ).toThrow(/speaker directory visibility must be a boolean/i);
    expect(() =>
      programmeIframeSnippet(
        "https://events.example.com/embed/event/sessions",
        "Event",
        159,
      ),
    ).toThrow(/160 to 20000 pixels/i);
    expect(() => parseProgrammeEmbedHeight("not-a-height")).toThrow(
      /integer from 160 to 20000 pixels/i,
    );
    expect(() => parseProgrammeEmbedHeight("159")).toThrow(
      /integer from 160 to 20000 pixels/i,
    );
    expect(parseProgrammeEmbedHeight("640")).toBe(640);
  });

  it("escapes copied iframe and widget attributes", () => {
    const configuration = {
      ...defaultProgrammeEmbedConfiguration(),
      surface: "gallery" as const,
      query: 'accessibility & "inclusion"',
      fields: ["images", "biography"] as const,
      height: 640,
    };
    const url = programmeEmbedUrl(
      "https://events.example.com",
      "future-of-events-2027",
      { ...configuration, fields: [...configuration.fields] },
    );
    expect(programmeIframeSnippet(url, 'Programme "preview"', 640)).toContain(
      "query=accessibility+%26+%22inclusion%22",
    );
    expect(programmeIframeSnippet(url, 'Programme "preview"', 640)).toContain(
      'title="Programme &quot;preview&quot;',
    );
    expect(
      programmeWidgetSnippet({
        origin: "https://events.example.com",
        eventSlug: "future-of-events-2027",
        target: "programme-widget",
        title: "Programme",
        configuration: { ...configuration, fields: [...configuration.fields] },
      }),
    ).toContain('data-query="accessibility &amp; &quot;inclusion&quot;"');
    expect(
      programmeWidgetSnippet({
        origin: "https://events.example.com",
        eventSlug: "future-of-events-2027",
        target: "programme-widget",
        title: "Programme",
        configuration: { ...configuration, fields: [...configuration.fields] },
      }),
    ).toContain('data-surface="gallery"');
  });

  it("validates persisted managed configurations without filling missing values", () => {
    const configuration = defaultProgrammeEmbedConfiguration();
    expect(
      parsePersistedProgrammeEmbedConfiguration(
        JSON.parse(JSON.stringify(configuration)),
      ),
    ).toEqual(configuration);
    const { density: _density, ...missingDensity } = configuration;
    expect(() =>
      parsePersistedProgrammeEmbedConfiguration(missingDensity),
    ).toThrow(/invalid shape/i);
    expect(() =>
      parsePersistedProgrammeEmbedConfiguration({
        ...configuration,
        accent: "red",
      }),
    ).toThrow(/six-digit hexadecimal colour/i);
  });

  it("generates stable managed iframe and widget destinations", () => {
    expect(
      managedProgrammeEmbedUrl(
        "https://events.example.com",
        "future-of-events-2027",
        "homepage-schedule",
      ),
    ).toBe(
      "https://events.example.com/embed/future-of-events-2027/saved/homepage-schedule",
    );
    expect(
      managedProgrammeWidgetSnippet({
        origin: "https://events.example.com",
        eventSlug: "future-of-events-2027",
        embedSlug: "homepage-schedule",
        target: "programme-widget",
        title: "Homepage programme",
        height: 640,
      }),
    ).toContain('data-programcue-embed="homepage-schedule"');
    expect(() =>
      managedProgrammeEmbedUrl(
        "https://events.example.com",
        "future-of-events-2027",
        "Invalid Slug",
      ),
    ).toThrow(/managed embed slug/i);
  });
});
