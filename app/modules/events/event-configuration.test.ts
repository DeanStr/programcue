import { describe, expect, it } from "vitest";

import {
  EventConfigurationDataError,
  findSessionFormatConfiguration,
  parseSessionFormatsConfiguration,
} from "./event-configuration";

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
});
