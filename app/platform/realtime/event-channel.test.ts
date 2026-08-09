import { describe, expect, it } from "vitest";

import { EventChannel } from "../../../workers/event-channel";
import type { EventChangeSummary } from "./realtime-types";

function request(path: string, organisationId: string, eventId: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-program-cue-organisation-id", organisationId);
  headers.set("x-program-cue-event-id", eventId);
  return new Request(`https://event-channel.internal${path}`, { ...init, headers });
}

function fakeState(deliveries: string[], initialValues: ReadonlyArray<readonly [string, unknown]> = []) {
  const values = new Map<string, unknown>(initialValues);
  const state = {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { values.set(key, value); },
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
    setWebSocketAutoResponse() {},
    getWebSockets() {
      return [{
        send(value: string) { deliveries.push(value); },
        close() {},
      }];
    },
    acceptWebSocket(socket: WebSocket) { socket.accept(); },
  } as unknown as DurableObjectState;
  return { state, values };
}

function fakeEnvironment(cursor = 0) {
  return {
    DB: {
      prepare() {
        return {
          bind() {
            return { first: async () => ({ cursor }) };
          },
        };
      },
    },
  } as unknown as CloudflareEnvironment;
}

describe("event channel isolation", () => {
  it("broadcasts a committed cursor summary immediately and rejects cross-event reuse", async () => {
    const deliveries: string[] = [];
    const { state } = fakeState(deliveries);
    const channel = new EventChannel(state, fakeEnvironment());
    const summary: EventChangeSummary = {
      type: "event-change",
      eventId: "event-1",
      cursor: 42,
      entityType: "session",
      entityId: "session-1",
      changeType: "updated",
      correlationId: null,
      committedAt: 1_800_000_000,
    };

    const published = await channel.fetch(request("/publish", "org-1", "event-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(summary),
    }));
    expect(published.status).toBe(200);
    expect(deliveries.map((value) => JSON.parse(value))).toEqual([summary]);

    const mismatch = await channel.fetch(request("/publish", "org-1", "event-2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...summary, eventId: "event-2", cursor: 43 }),
    }));
    expect(mismatch.status).toBe(409);
    expect(deliveries).toHaveLength(1);
  });

  it("deduplicates stale cursors", async () => {
    const deliveries: string[] = [];
    const { state } = fakeState(deliveries);
    const channel = new EventChannel(state, fakeEnvironment());
    const summary: EventChangeSummary = {
      type: "event-change",
      eventId: "event-1",
      cursor: 3,
      entityType: "task",
      entityId: "task-1",
      changeType: "progress",
      correlationId: null,
      committedAt: 1_800_000_000,
    };
    const publish = () => channel.fetch(request("/publish", "org-1", "event-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(summary),
    }));

    await publish();
    const duplicate = await publish();
    expect(await duplicate.json()).toMatchObject({ accepted: false, cursor: 3 });
    expect(deliveries).toHaveLength(1);
  });

  it("reconciles a stale persisted cursor to authoritative D1 before accepting a client", async () => {
    const deliveries: string[] = [];
    const { state, values } = fakeState(deliveries, [["latestCursor", 11]]);
    const channel = new EventChannel(state, fakeEnvironment(5));

    const connected = await channel.fetch(request("/connect", "org-1", "event-1", {
      headers: { upgrade: "websocket" },
    }));
    expect(connected.status).toBe(101);
    expect(values.get("latestCursor")).toBe(5);

    const summary: EventChangeSummary = {
      type: "event-change",
      eventId: "event-1",
      cursor: 6,
      entityType: "event",
      entityId: "event-1",
      changeType: "updated",
      correlationId: null,
      committedAt: 1_800_000_001,
    };
    const published = await channel.fetch(request("/publish", "org-1", "event-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(summary),
    }));

    expect(await published.json()).toMatchObject({ accepted: true, cursor: 6, delivered: 1 });
    expect(deliveries.map((value) => JSON.parse(value))).toEqual([summary]);
    connected.webSocket?.accept();
    connected.webSocket?.close(1000, "Test complete");
  });
});
