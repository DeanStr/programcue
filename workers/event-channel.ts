import {
  EVENT_CHANGE_MAX_POLL_INTERVAL_MS,
  isEventChangeSummary,
  type EventChangeSummary,
} from "../app/platform/realtime/realtime-types";

type ChannelIdentity = { organisationId: string; eventId: string };

const IDENTITY_KEY = "identity";
const CURSOR_KEY = "latestCursor";

function identityFrom(request: Request): ChannelIdentity | null {
  const organisationId = request.headers.get("x-program-cue-organisation-id")?.trim();
  const eventId = request.headers.get("x-program-cue-event-id")?.trim();
  return organisationId && eventId ? { organisationId, eventId } : null;
}

export class EventChannel implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CloudflareEnvironment,
  ) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const requestedIdentity = identityFrom(request);
    if (!requestedIdentity) return new Response("Event channel identity is required.", { status: 400 });
    if (!await this.acceptIdentity(requestedIdentity)) {
      return new Response("Event channel tenant/event mismatch.", { status: 409 });
    }

    const pathname = new URL(request.url).pathname;
    if (pathname === "/connect" && request.method === "GET") return this.connectClient(requestedIdentity, request);
    if (pathname === "/publish" && request.method === "POST") return this.publish(requestedIdentity, request);
    return new Response("Not found", { status: 404 });
  }

  private async acceptIdentity(requested: ChannelIdentity) {
    const current = await this.state.storage.get<ChannelIdentity>(IDENTITY_KEY);
    if (!current) {
      await this.state.storage.put(IDENTITY_KEY, requested);
      return true;
    }
    return current.organisationId === requested.organisationId && current.eventId === requested.eventId;
  }

  private async connectClient(identity: ChannelIdentity, request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426, headers: { upgrade: "websocket" } });
    }

    return this.state.blockConcurrencyWhile(async () => {
      const event = await this.env.DB.prepare(`
        SELECT COALESCE(MAX(c.sequence), 0) AS cursor
          FROM events e
          LEFT JOIN event_changes c ON c.event_id = e.id
         WHERE e.id = ? AND e.organisation_id = ?
         GROUP BY e.id
      `).bind(identity.eventId, identity.organisationId).first<{ cursor: number }>();
      const cursor = Number(event?.cursor);
      if (!event || !Number.isSafeInteger(cursor) || cursor < 0) {
        return new Response("The authorised event cursor could not be loaded.", { status: event ? 500 : 404 });
      }

      // D1 is authoritative. Reconcile persisted channel state on every new
      // connection so a database restore/reset cannot leave this signal-only
      // Durable Object silently rejecting valid committed changes forever.
      await this.state.storage.put(CURSOR_KEY, cursor);

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server, ["event-clients"]);
      server.send(JSON.stringify({
        type: "ready",
        eventId: identity.eventId,
        cursor,
        maxPollingIntervalMs: EVENT_CHANGE_MAX_POLL_INTERVAL_MS,
      }));
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  private async publish(identity: ChannelIdentity, request: Request) {
    let summary: unknown;
    try {
      summary = await request.json();
    } catch {
      return new Response("Invalid event change JSON.", { status: 400 });
    }
    if (!isEventChangeSummary(summary) || summary.eventId !== identity.eventId) {
      return new Response("Invalid event change summary.", { status: 422 });
    }

    return this.state.blockConcurrencyWhile(async () => {
      const latestCursor = await this.state.storage.get<number>(CURSOR_KEY) ?? 0;
      if (summary.cursor <= latestCursor) {
        return Response.json({ accepted: false, cursor: latestCursor });
      }

      // Signals can arrive out of order even though their D1 rows committed in
      // sequence. If a newer notification skipped an event-owned row, send a
      // ready watermark instead of advancing clients past the missing change.
      const prior = await this.env.DB.prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS priorCursor
           FROM event_changes
          WHERE event_id = ? AND sequence < ?`,
      )
        .bind(identity.eventId, summary.cursor)
        .first<{ priorCursor: number }>();
      const priorCursor = Number(prior?.priorCursor ?? 0);
      if (!Number.isSafeInteger(priorCursor) || priorCursor < 0) {
        return new Response("The committed event cursor could not be verified.", {
          status: 500,
        });
      }

      await this.state.storage.put(CURSOR_KEY, summary.cursor);
      const message = priorCursor > latestCursor
        ? {
            type: "ready" as const,
            eventId: identity.eventId,
            cursor: summary.cursor,
            maxPollingIntervalMs: EVENT_CHANGE_MAX_POLL_INTERVAL_MS,
          }
        : summary satisfies EventChangeSummary;
      const encoded = JSON.stringify(message);
      let delivered = 0;
      for (const socket of this.state.getWebSockets("event-clients")) {
        try {
          socket.send(encoded);
          delivered += 1;
        } catch {
          socket.close(1011, "Realtime delivery failed; reconnect or poll for changes.");
        }
      }
      return Response.json({
        accepted: true,
        cursor: summary.cursor,
        delivered,
        pollingRequired: priorCursor > latestCursor,
      });
    });
  }
}
