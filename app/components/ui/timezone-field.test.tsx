import { describe, expect, it } from "vitest";

import { timezoneLabel } from "./timezone-field";

describe("timezone suggestions", () => {
  it("uses stable IANA labels without a today-dependent abbreviation", () => {
    expect(timezoneLabel("America/Toronto")).toBe(
      "Toronto · America/Toronto",
    );
    expect(timezoneLabel("Europe/London")).toBe("London · Europe/London");
    expect(timezoneLabel("UTC")).toBe("Coordinated Universal Time");
  });
});
