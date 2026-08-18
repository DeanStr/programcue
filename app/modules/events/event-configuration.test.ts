import { describe, expect, it } from "vitest";

import { CANONICAL_EVENT_FILE_POLICY } from "~/modules/files/file-policy";

import {
  EventConfigurationDataError,
  findSessionFormatConfiguration,
  INITIAL_EVENT_SESSION_FORMATS,
  parseSessionFormatsConfiguration,
} from "./event-configuration";
import { eventSetupInputSchema } from "./event-schema";
import { isCredentialFreeHttpsUrl } from "./https-url";

function setupInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    revision: 1,
    name: "Event",
    timezone: "UTC",
    startDate: "2027-05-20",
    endDate: "2027-05-22",
    venue: "",
    venueAddress: "",
    venueMapUrl: "",
    city: "",
    programmeHeroImageUrl: "",
    publicSlug: "event",
    brandAccent: "#123456",
    participantLogoUrl: "",
    participantWelcomeText: "",
    participantSupportUrl: "",
    description: "",
    repositoryProvider: "d1",
    retentionMonths: 12,
    submissionAccessMode: "email_verified",
    allowAnonymousDrafts: false,
    duplicatePersonWarnings: false,
    filePolicy: CANONICAL_EVENT_FILE_POLICY,
    rooms: [],
    tracks: [],
    sessionFormats: INITIAL_EVENT_SESSION_FORMATS,
    ...overrides,
  };
}

describe("event configuration", () => {
  it("strictly parses and deterministically orders session formats", () => {
    expect(
      parseSessionFormatsConfiguration(
        JSON.stringify([
          {
            key: "workshop",
            label: "Workshop",
            defaultDurationMinutes: 90,
            position: 2,
          },
          {
            key: "presentation",
            label: "Presentation",
            defaultDurationMinutes: 45,
            position: 1,
          },
        ]),
      ).map((format) => format.key),
    ).toEqual(["presentation", "workshop"]);
  });

  it("rejects malformed, empty and duplicate configuration", () => {
    expect(() => parseSessionFormatsConfiguration("not-json")).toThrow(
      EventConfigurationDataError,
    );
    expect(() => parseSessionFormatsConfiguration("[]")).toThrow(
      EventConfigurationDataError,
    );
    expect(() =>
      parseSessionFormatsConfiguration(
        JSON.stringify([
          {
            key: "panel",
            label: "Panel",
            defaultDurationMinutes: 60,
            position: 0,
          },
          {
            key: "panel",
            label: "Duplicate",
            defaultDurationMinutes: 45,
            position: 1,
          },
        ]),
      ),
    ).toThrow(EventConfigurationDataError);
    expect(() =>
      parseSessionFormatsConfiguration(
        JSON.stringify([
          {
            key: "talk",
            label: "Talk",
            defaultDurationMinutes: 45,
            position: 0,
          },
          {
            key: "short-talk",
            label: "talk",
            defaultDurationMinutes: 20,
            position: 1,
          },
        ]),
      ),
    ).toThrow(EventConfigurationDataError);
    expect(() =>
      parseSessionFormatsConfiguration(
        JSON.stringify([
          {
            key: "lab",
            label: "Workshop",
            defaultDurationMinutes: 45,
            position: 0,
          },
          {
            key: "workshop",
            label: "Lab",
            defaultDurationMinutes: 90,
            position: 1,
          },
        ]),
      ),
    ).toThrow(EventConfigurationDataError);
  });

  it("resolves configured keys and human labels without guessing ambiguity", () => {
    const formats = parseSessionFormatsConfiguration(
      JSON.stringify([
        {
          key: "round-table",
          label: "Round Table",
          defaultDurationMinutes: 75,
          position: 0,
        },
        {
          key: "panel",
          label: "Panel",
          defaultDurationMinutes: 60,
          position: 1,
        },
      ]),
    );
    expect(findSessionFormatConfiguration(formats, "Round Table")?.key).toBe(
      "round-table",
    );
    expect(findSessionFormatConfiguration(formats, "round_table")?.key).toBe(
      "round-table",
    );
    expect(
      findSessionFormatConfiguration(formats, "not configured"),
    ).toBeNull();
    expect(() =>
      findSessionFormatConfiguration(
        [
          ...formats,
          {
            key: "round-table-alternate",
            label: "Round Table",
            defaultDurationMinutes: 45,
            position: 2,
          },
        ],
        "Round Table",
      ),
    ).toThrow(/ambiguous/i);
  });

  it("rejects credentialed HTTPS URLs used as public event assets", () => {
    expect(
      isCredentialFreeHttpsUrl("https://user:secret@maps.example.test/hall"),
    ).toBe(false);
    expect(
      eventSetupInputSchema.safeParse(
        setupInput({
          venueMapUrl: "https://user:secret@maps.example.test/hall",
        }),
      ).success,
    ).toBe(false);
    expect(
      eventSetupInputSchema.safeParse(
        setupInput({
          programmeHeroImageUrl:
            "https://user:secret@cdn.example.test/hero.png",
        }),
      ).success,
    ).toBe(false);
    expect(
      eventSetupInputSchema.safeParse(
        setupInput({
          participantLogoUrl: "https://user:secret@cdn.example.test/logo.png",
        }),
      ).success,
    ).toBe(false);
    expect(
      eventSetupInputSchema.safeParse(
        setupInput({
          venueMapUrl: "https://maps.example.test/hall",
        }),
      ).success,
    ).toBe(true);
  });
});
