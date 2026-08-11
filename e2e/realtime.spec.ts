import { expect, test } from "@playwright/test";

const DEMO_EVENT_ID = "evt-foe-2025";

type RealtimeMessage = {
  type?: string;
  eventId?: string;
  cursor?: number;
  entityType?: string;
  entityId?: string | null;
  changeType?: string;
};

type RealtimeProbe = {
  state: "connecting" | "open" | "closed" | "error";
  messages: RealtimeMessage[];
  error: string | null;
};

type ProbeGlobal = typeof globalThis & {
  __programCueRealtimeProbe?: RealtimeProbe;
  __programCueRealtimeSocket?: WebSocket;
};

test("an Event Setup commit invalidates another authenticated browser page over WebSocket", async ({
  context,
}) => {
  await context.addCookies([
    {
      name: "program_cue_event",
      value: DEMO_EVENT_ID,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const observer = await context.newPage();
  const editor = await context.newPage();
  let originalVenue: string | undefined;

  try {
    await observer.goto("/admin/event");
    await expect(
      observer.getByRole("heading", { name: "Event Setup" }),
    ).toBeVisible();

    const socketSeen = observer.waitForEvent("websocket");
    await observer.evaluate((eventId) => {
      const probeGlobal = globalThis as ProbeGlobal;
      const url = new URL(
        `/admin/events/${eventId}/changes`,
        window.location.href,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

      const probe: RealtimeProbe = {
        state: "connecting",
        messages: [],
        error: null,
      };
      const socket = new WebSocket(url);
      probeGlobal.__programCueRealtimeProbe = probe;
      probeGlobal.__programCueRealtimeSocket = socket;

      socket.addEventListener("open", () => {
        probe.state = "open";
      });
      socket.addEventListener("message", (message) => {
        try {
          probe.messages.push(
            JSON.parse(String(message.data)) as RealtimeMessage,
          );
        } catch (error) {
          probe.error = `Invalid realtime JSON: ${error instanceof Error ? error.message : String(error)}`;
        }
      });
      socket.addEventListener("error", () => {
        probe.state = "error";
        probe.error = "The event WebSocket emitted an error.";
      });
      socket.addEventListener("close", (closeEvent) => {
        probe.state = "closed";
        if (closeEvent.code !== 1000) {
          probe.error = `The event WebSocket closed unexpectedly (${closeEvent.code}: ${closeEvent.reason || "no reason"}).`;
        }
      });
    }, DEMO_EVENT_ID);

    const websocket = await socketSeen;
    expect(new URL(websocket.url()).pathname).toBe(
      `/admin/events/${DEMO_EVENT_ID}/changes`,
    );

    await expect
      .poll(
        () =>
          observer.evaluate(() => {
            const probe = (globalThis as ProbeGlobal).__programCueRealtimeProbe;
            return {
              state: probe?.state,
              error: probe?.error,
              ready: probe?.messages.find(
                (message) => message.type === "ready",
              ),
            };
          }),
        {
          message:
            "the authenticated event WebSocket should open and send its ready frame",
          timeout: 5_000,
        },
      )
      .toEqual({
        state: "open",
        error: null,
        ready: expect.objectContaining({
          type: "ready",
          eventId: DEMO_EVENT_ID,
          cursor: expect.any(Number),
        }),
      });

    const readyCursor = await observer.evaluate(() => {
      const messages =
        (globalThis as ProbeGlobal).__programCueRealtimeProbe?.messages ?? [];
      return messages.find((message) => message.type === "ready")?.cursor;
    });
    expect(Number.isSafeInteger(readyCursor)).toBeTruthy();

    await editor.goto("/admin/event");
    await expect(
      editor.getByRole("heading", { name: "Event Setup" }),
    ).toBeVisible();
    const venue = editor.getByLabel("Venue");
    originalVenue = await venue.inputValue();
    const changedVenue = `Realtime browser check ${Date.now()}`;

    await venue.fill(changedVenue);
    await editor.getByRole("button", { name: "Save event" }).click();
    const saveNotice = editor
      .locator(".validation-item.ok[role='status']")
      .filter({
        has: editor.getByText("Event settings saved to D1.", { exact: true }),
      });
    await expect(saveNotice).toBeVisible();

    await expect
      .poll(
        () =>
          observer.evaluate(
            ({ eventId, cursor }) => {
              const probe = (globalThis as ProbeGlobal)
                .__programCueRealtimeProbe;
              const invalidation = probe?.messages.find(
                (message) =>
                  message.type === "event-change" &&
                  message.eventId === eventId &&
                  message.entityType === "event" &&
                  message.entityId === eventId &&
                  message.changeType === "updated" &&
                  typeof message.cursor === "number" &&
                  message.cursor > cursor,
              );
              return { state: probe?.state, error: probe?.error, invalidation };
            },
            { eventId: DEMO_EVENT_ID, cursor: readyCursor as number },
          ),
        {
          message:
            "the first page should receive the committed event invalidation over its open WebSocket",
          timeout: 5_000,
          intervals: [50, 100, 250, 500],
        },
      )
      .toEqual({
        state: "open",
        error: null,
        invalidation: expect.objectContaining({
          type: "event-change",
          eventId: DEMO_EVENT_ID,
          entityType: "event",
          entityId: DEMO_EVENT_ID,
          changeType: "updated",
        }),
      });
  } finally {
    if (originalVenue !== undefined) {
      await editor.goto("/admin/event");
      const venue = editor.getByLabel("Venue");
      if ((await venue.inputValue()) !== originalVenue) {
        await venue.fill(originalVenue);
        await editor.getByRole("button", { name: "Save event" }).click();
        await editor.waitForLoadState("networkidle");
        await editor.reload();
        await expect(
          editor.getByLabel("Venue"),
          "the test must restore the event venue",
        ).toHaveValue(originalVenue);
      }
    }
    await observer
      .evaluate(() => {
        (globalThis as ProbeGlobal).__programCueRealtimeSocket?.close(
          1000,
          "Realtime browser test complete",
        );
      })
      .catch(() => undefined);
    await editor.close();
    await observer.close();
  }
});
