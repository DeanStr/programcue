import { describe, expect, it } from "vitest";

import {
  GoogleCalendarProvider,
  MicrosoftCalendarProvider,
  microsoftUtcDateTime,
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

  it("sends unambiguous UTC instants for both DST fall-back occurrences", async () => {
    const firstOccurrence = "2025-11-02T05:30:00.000Z";
    const secondOccurrence = "2025-11-02T06:30:00.000Z";
    expect(microsoftUtcDateTime(firstOccurrence)).toBe("2025-11-02T05:30:00");
    expect(microsoftUtcDateTime(secondOccurrence)).toBe("2025-11-02T06:30:00");

    const bodies: unknown[] = [];
    const provider = new MicrosoftCalendarProvider(
      "access-token",
      (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "provider-id" });
      }) as typeof fetch,
      "https://calendar.test",
    );
    await provider.apply({
      uid: "session@example.com",
      title: "Session",
      description: "Description",
      location: "Room 1",
      startsAtIso: secondOccurrence,
      endsAtIso: "2025-11-02T07:30:00.000Z",
      timezone: "America/Toronto",
      attendeeEmail: "speaker@example.com",
      attendeeName: "Speaker",
      sequence: 0,
      method: "REQUEST",
    });
    expect(bodies[0]).toMatchObject({
      start: { dateTime: "2025-11-02T06:30:00", timeZone: "UTC" },
      end: { dateTime: "2025-11-02T07:30:00", timeZone: "UTC" },
    });
  });
});
