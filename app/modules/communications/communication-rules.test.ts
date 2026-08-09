import { describe, expect, it } from "vitest";

import { calculateRecipientCount, communicationDraftSchema } from "./communication-rules";
import { formatEventDateMarkers } from "./merge-template";

describe("communication and readiness rules", () => {
  it("calculates deliverable recipients", () => {
    expect(calculateRecipientCount({ selected: 100, suppressed: 7, invalid: 3 })).toBe(90);
  });

  it("validates the content required by each selected channel", () => {
    expect(() => communicationDraftSchema.parse({
      name: "Reminder",
      channels: ["email"],
      subject: "",
      emailBody: "Hello",
      physicalAddress: "",
    })).toThrow(/subject/);
  });

  it("renders event date markers without duplicating a single calendar day", () => {
    const start = Date.parse("2026-08-09T00:00:00Z") / 1_000;
    const end = Date.parse("2026-08-09T23:59:59Z") / 1_000;
    expect(formatEventDateMarkers(start, end)).toBe("Aug 9, 2026");
    expect(formatEventDateMarkers(start, end + 86_400)).toBe(
      "Aug 9, 2026 – Aug 10, 2026",
    );
  });
});
