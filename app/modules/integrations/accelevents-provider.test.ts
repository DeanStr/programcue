import { describe, expect, it, vi } from "vitest";

import {
  AcceleventsProvider,
  type AcceleventsSessionPayload,
  type AcceleventsSpeakerPayload,
} from "./accelevents-provider.server";

const credentials = {
  apiKey: "secret-key",
  eventUrl: "future-of-events",
  externalEventId: 441,
  sessionTypeFormat: "IN_PERSON" as const,
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Accelevents provider contract", () => {
  it("validates the configured event with the documented host endpoint and Key header", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ data: [] }));
    await new AcceleventsProvider(credentials, fetcher).validateConnection();

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    const requestUrl = new URL(String(url));
    expect(requestUrl.origin + requestUrl.pathname).toBe(
      "https://api.accelevents.com/rest/host/event/future-of-events/session",
    );
    expect(requestUrl.searchParams.get("eventId")).toBe("441");
    expect(new Headers(init?.headers).get("Key")).toBe("secret-key");
    expect(init?.signal).toBeTruthy();
    expect(init?.signal?.aborted).toBe(false);
  });

  it("creates an unmapped speaker without a heuristic provider lookup", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 712 }));
    const payload: AcceleventsSpeakerPayload = {
      firstName: "Avery",
      lastName: "Stone",
      email: "avery@example.com",
      allowAttendeeAccess: true,
      allowOverrideDetails: true,
    };

    await expect(
      new AcceleventsProvider(credentials, fetcher).upsertSpeaker(
        payload,
        null,
      ),
    ).resolves.toBe("712");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://api.accelevents.com/rest/host/event/future-of-events/speaker",
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(payload),
    });
  });

  it("rejects an undocumented speaker create response instead of saving status text as an id", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json("success"));

    await expect(
      new AcceleventsProvider(credentials, fetcher).upsertSpeaker(
        {
          firstName: "Avery",
          lastName: "Stone",
          email: "avery@example.com",
          allowAttendeeAccess: true,
          allowOverrideDetails: true,
        },
        null,
      ),
    ).rejects.toThrow("documented numeric id response");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("creates an unmapped session without a heuristic provider lookup", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(813));
    const payload: AcceleventsSessionPayload = {
      title: "Designing event systems",
      startTime: "2025/05/20 09:00",
      endTime: "2025/05/20 09:45",
      format: "BREAKOUT_SESSION",
      status: "VISIBLE",
      sessionVisibilityType: "PUBLIC",
      sessionTypeFormat: "IN_PERSON",
    };

    await expect(
      new AcceleventsProvider(credentials, fetcher).upsertSession(payload, null),
    ).resolves.toBe("813");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://api.accelevents.com/rest/host/event/future-of-events/session",
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(payload),
    });
  });

  it("updates a mapped session without a create lookup", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const payload: AcceleventsSessionPayload = {
      title: "Designing event systems",
      startTime: "2025/05/20 09:00",
      endTime: "2025/05/20 09:45",
      format: "BREAKOUT_SESSION",
      status: "VISIBLE",
      sessionVisibilityType: "PUBLIC",
      sessionTypeFormat: "IN_PERSON",
    };

    await expect(
      new AcceleventsProvider(credentials, fetcher).upsertSession(
        payload,
        "99",
      ),
    ).resolves.toBe("99");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://api.accelevents.com/rest/host/event/future-of-events/session/99",
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify(payload),
    });
  });

  it("creates a track through the documented key-value endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(812));
    const payload = {
      type: "TRACK" as const,
      name: "Event operations",
      color: "#4f46e5",
      description: "Program Cue track: event-operations",
      position: 3,
    };

    await expect(
      new AcceleventsProvider(credentials, fetcher).createTrack(payload),
    ).resolves.toBe("812");
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://api.accelevents.com/rest/host/event/future-of-events/key-value",
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(payload),
    });
  });

  it("rejects status text instead of treating it as a track identifier", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json("success"));

    await expect(
      new AcceleventsProvider(credentials, fetcher).createTrack({
        type: "TRACK",
        name: "Event operations",
        position: 3,
      }),
    ).rejects.toThrow("documented numeric id response");
  });

  it("rejects an unbounded external identifier", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ id: "a".repeat(513) }));

    await expect(
      new AcceleventsProvider(credentials, fetcher).createTrack({
        type: "TRACK",
        name: "Event operations",
        position: 3,
      }),
    ).rejects.toThrow("documented numeric id response");
  });

  it("fails explicitly when the published API has no association write", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new AcceleventsProvider(credentials, fetcher).associateSessionSpeaker(
        "session-1",
        "speaker-1",
        {
          sessionId: "local-session",
          speakerId: "local-speaker",
          position: 0,
          roleLabel: "Speaker",
        },
      ),
    ).rejects.toThrow("no session-speaker association write endpoint");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
