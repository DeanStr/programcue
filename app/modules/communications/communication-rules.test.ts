import { describe, expect, it } from "vitest";

import {
  previewCommunicationSchema,
  saveCommunicationTriggerSchema,
} from "./communication-schema";
import {
  calculateRecipientCount,
  communicationDraftSchema,
} from "./communication-rules";
import { eventEmailLogoUrl } from "./communication-service-shared";
import { formatEventDateMarkers, formatTaskDueDate } from "./merge-template";

describe("communication and readiness rules", () => {
  it("calculates deliverable recipients", () => {
    expect(
      calculateRecipientCount({ selected: 100, suppressed: 7, invalid: 3 }),
    ).toBe(90);
  });

  it("validates the content required by each selected channel", () => {
    expect(() =>
      communicationDraftSchema.parse({
        name: "Reminder",
        channels: ["email"],
        subject: "",
        emailBody: "Hello",
        physicalAddress: "",
      }),
    ).toThrow(/subject/);
  });

  it("requires explicit reminder policy and activation input", () => {
    const trigger = {
      templateId: "00000000-0000-4000-8000-000000000001",
      triggerType: "task_due",
      audienceType: "due_speakers",
      sendHourUtc: 9,
    };
    expect(saveCommunicationTriggerSchema.safeParse(trigger).success).toBe(
      false,
    );
    expect(
      saveCommunicationTriggerSchema.safeParse({
        ...trigger,
        kind: "transactional",
        enabled: "false",
      }).success,
    ).toBe(false);
    expect(
      saveCommunicationTriggerSchema.parse({
        ...trigger,
        kind: "optional",
        enabled: false,
      }),
    ).toMatchObject({ kind: "optional", enabled: false });
    expect(
      previewCommunicationSchema.safeParse({
        templateVersionId: "00000000-0000-4000-8000-000000000002",
        audienceType: "manual",
        manualRecipients: "recipient@example.com",
      }).success,
    ).toBe(false);
  });

  it("renders event date markers without duplicating a single calendar day", () => {
    const start = Date.parse("2026-08-09T00:00:00Z") / 1_000;
    const end = Date.parse("2026-08-09T23:59:59Z") / 1_000;
    expect(formatEventDateMarkers(start, end)).toBe("Aug 9, 2026");
    expect(formatEventDateMarkers(start, end + 86_400)).toBe(
      "Aug 9, 2026 – Aug 10, 2026",
    );
  });

  it("renders task due dates in the event timezone", () => {
    const dueAt = Date.parse("2026-09-20T21:00:00Z") / 1_000;
    expect(formatTaskDueDate(dueAt, "America/Toronto")).toBe(
      "Sep 20, 2026, 5:00 PM (America/Toronto)",
    );
  });

  it("keeps legacy HTTPS email logos and resolves managed logo paths", () => {
    expect(
      eventEmailLogoUrl({} as CloudflareEnvironment, {
        logoUrl: "https://cdn.example.test/event-logo.png",
      }),
    ).toBe("https://cdn.example.test/event-logo.png");
    expect(
      eventEmailLogoUrl(
        {
          BETTER_AUTH_URL: "https://events.example.test",
        } as unknown as CloudflareEnvironment,
        { logoUrl: "/public/brand/event/logo" },
      ),
    ).toBe("https://events.example.test/public/brand/event/logo");
    expect(() =>
      eventEmailLogoUrl({} as CloudflareEnvironment, {
        logoUrl: "/public/brand/event/logo",
      }),
    ).toThrow(/BETTER_AUTH_URL/);
  });
});
