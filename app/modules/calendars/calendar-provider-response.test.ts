import { describe, expect, it } from "vitest";

import {
  GoogleCalendarProvider,
  MicrosoftCalendarProvider,
} from "./calendar-providers.server";

describe("calendar provider response bounds", () => {
  it.each([
    [
      "google",
      (fetcher: typeof fetch) =>
        new GoogleCalendarProvider(
          "access-token",
          "primary",
          fetcher,
          "https://calendar.test",
        ),
    ],
    [
      "microsoft",
      (fetcher: typeof fetch) =>
        new MicrosoftCalendarProvider(
          "access-token",
          fetcher,
          "https://calendar.test",
        ),
    ],
  ] as const)(
    "invokes the %s calendar fetch dependency without the provider as its receiver",
    async (_provider, createProvider) => {
      const fetcher = function (this: unknown) {
        if (this !== undefined)
          throw new TypeError("fetch received an invalid this reference");
        return Promise.resolve(Response.json({ id: "provider-id" }));
      } as typeof fetch;
      const provider = createProvider(fetcher);

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
      ).resolves.toEqual({ providerEventId: "provider-id" });
    },
  );

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
