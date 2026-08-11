import { describe, expect, it } from "vitest";

import { GoogleCalendarProvider } from "./calendar-providers.server";

describe("calendar provider response bounds", () => {
  it("rejects an unbounded provider event identifier", async () => {
    const provider = new GoogleCalendarProvider(
      "access-token",
      "primary",
      async () => Response.json({ id: "g".repeat(513) }),
      "https://calendar.test",
    );

    await expect(
      provider.apply({
        uid: "session@example.com",
        title: "Session",
        description: "Description",
        location: "Room 1",
        startsAtIso: "2026-08-10T10:00:00.000Z",
        endsAtIso: "2026-08-10T11:00:00.000Z",
        timezone: "UTC",
        attendeeEmail: "speaker@example.com",
        attendeeName: "Speaker",
        sequence: 0,
        method: "REQUEST",
      }),
    ).rejects.toMatchObject({
      name: "CalendarProviderRequestError",
      provider: "google",
    });
  });
});
