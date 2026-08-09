import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeToEventChanges } from "./realtime-client";

class TestWebSocket extends EventTarget {
  static instance: TestWebSocket | null = null;
  closed = false;

  constructor(readonly url: string) {
    super();
    TestWebSocket.instance = this;
  }

  close() {
    this.closed = true;
    // Browsers can emit an error while a still-connecting socket is closed.
    this.dispatchEvent(new Event("error"));
    this.dispatchEvent(new Event("close"));
  }

  message(data: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}

describe("realtime client lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    TestWebSocket.instance = null;
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid initial cursor %s instead of silently replaying from zero",
    (initialCursor) => {
      vi.stubGlobal("window", {
        location: { href: "https://programcue.test/admin/command" },
      });
      vi.stubGlobal("WebSocket", TestWebSocket);
      vi.stubGlobal("fetch", vi.fn());

      expect(() =>
        subscribeToEventChanges({
          liveUrl: "/admin/events/event-1/changes",
          pollUrl: "/admin/events/event-1/changes",
          initialCursor,
          onInvalidate: vi.fn(),
        }),
      ).toThrow("Realtime initial cursor must be a non-negative safe integer.");
      expect(TestWebSocket.instance).toBeNull();
    },
  );

  it("does not report transport errors or invalidate after the subscription stops", async () => {
    let resolvePoll!: (response: Response) => void;
    const poll = new Promise<Response>((resolve) => {
      resolvePoll = resolve;
    });
    const onError = vi.fn();
    const onInvalidate = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://programcue.test/admin/command" },
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => poll),
    );

    const stop = subscribeToEventChanges({
      liveUrl: "/admin/events/event-1/changes",
      pollUrl: "/admin/events/event-1/changes",
      initialCursor: 1,
      onError,
      onInvalidate,
    });
    const socket = TestWebSocket.instance;
    expect(socket).not.toBeNull();

    stop();
    socket?.message({
      type: "event-change",
      eventId: "event-1",
      cursor: 2,
      entityType: "event",
      entityId: "event-1",
      changeType: "updated",
      correlationId: null,
      committedAt: 1_800_000_000,
    });
    resolvePoll(
      Response.json({
        changes: [
          {
            type: "event-change",
            eventId: "event-1",
            cursor: 2,
            entityType: "event",
            entityId: "event-1",
            changeType: "updated",
            correlationId: null,
            committedAt: 1_800_000_000,
          },
        ],
        cursor: 2,
        hasMore: false,
        pollAfterMs: 10_000,
      }),
    );
    await poll;
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it("rejects a malformed poll page without advancing its cursor", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const onInvalidate = vi.fn();
    const onStatusChange = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          changes: [{ type: "event-change", cursor: 9 }],
          cursor: 9,
          hasMore: false,
          pollAfterMs: 10_000,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          changes: [],
          cursor: 1,
          hasMore: false,
          pollAfterMs: 10_000,
        }),
      );
    vi.stubGlobal("window", {
      location: { href: "https://programcue.test/admin/command" },
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", fetchMock);

    const stop = subscribeToEventChanges({
      liveUrl: "/admin/events/event-1/changes",
      pollUrl: "/admin/events/event-1/changes",
      initialCursor: 1,
      onError,
      onInvalidate,
      onStatusChange,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Realtime cursor poll returned an invalid response.",
      }),
    );
    expect(onInvalidate).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith("unavailable");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(retryUrl.searchParams.get("cursor")).toBe("1");
    expect(onStatusChange).toHaveBeenCalledWith("polling");
    stop();
  });

  it("accepts an authoritative lower poll cursor after D1 is restored", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          changes: [],
          cursor: 4,
          hasMore: false,
          pollAfterMs: 10_000,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          changes: [
            {
              type: "event-change",
              eventId: "event-1",
              cursor: 5,
              entityType: "event",
              entityId: "event-1",
              changeType: "updated",
              correlationId: null,
              committedAt: 1_800_000_000,
            },
          ],
          cursor: 5,
          hasMore: false,
          pollAfterMs: 10_000,
        }),
      );
    const onInvalidate = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://programcue.test/admin/command" },
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", fetchMock);

    const stop = subscribeToEventChanges({
      liveUrl: "/admin/events/event-1/changes",
      pollUrl: "/admin/events/event-1/changes",
      initialCursor: 12,
      onInvalidate,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onInvalidate).toHaveBeenNthCalledWith(1, []);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("cursor"),
    ).toBe("4");
    expect(onInvalidate).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ cursor: 5, entityId: "event-1" }),
    ]);
    stop();
  });

  it("does not treat a stale poll as an authoritative rollback after a WebSocket advance", async () => {
    let resolvePoll!: (response: Response) => void;
    const poll = new Promise<Response>((resolve) => {
      resolvePoll = resolve;
    });
    const onInvalidate = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://programcue.test/admin/command" },
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => poll),
    );

    const stop = subscribeToEventChanges({
      liveUrl: "/admin/events/event-1/changes",
      pollUrl: "/admin/events/event-1/changes",
      initialCursor: 5,
      onInvalidate,
    });
    TestWebSocket.instance?.message({
      type: "event-change",
      eventId: "event-1",
      cursor: 6,
      entityType: "event",
      entityId: "event-1",
      changeType: "updated",
      correlationId: null,
      committedAt: 1_800_000_000,
    });
    resolvePoll(
      Response.json({
        changes: [],
        cursor: 4,
        hasMore: false,
        pollAfterMs: 10_000,
      }),
    );
    await poll;
    await Promise.resolve();

    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledWith([
      expect.objectContaining({ cursor: 6, entityId: "event-1" }),
    ]);
    stop();
  });

  it("reports and closes an unsupported WebSocket protocol message", async () => {
    const onError = vi.fn();
    const onStatusChange = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://programcue.test/admin/command" },
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    const stop = subscribeToEventChanges({
      liveUrl: "/admin/events/event-1/changes",
      pollUrl: "/admin/events/event-1/changes",
      initialCursor: 1,
      onError,
      onInvalidate: vi.fn(),
      onStatusChange,
    });
    TestWebSocket.instance?.message({ type: "future-protocol-message" });
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Realtime WebSocket returned an unsupported message.",
      }),
    );
    expect(onStatusChange).toHaveBeenCalledWith("unavailable");
    stop();
  });

  it("ignores an already-seen valid WebSocket change without degrading the transport", async () => {
    const onError = vi.fn();
    const onInvalidate = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://programcue.test/admin/command" },
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    const stop = subscribeToEventChanges({
      liveUrl: "/admin/events/event-1/changes",
      pollUrl: "/admin/events/event-1/changes",
      initialCursor: 2,
      onError,
      onInvalidate,
    });
    const socket = TestWebSocket.instance;
    socket?.message({
      type: "event-change",
      eventId: "event-1",
      cursor: 2,
      entityType: "event",
      entityId: "event-1",
      changeType: "updated",
      correlationId: null,
      committedAt: 1_800_000_000,
    });
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
    expect(onInvalidate).not.toHaveBeenCalled();
    expect(socket?.closed).toBe(false);
    stop();
  });
});
