import {
  EVENT_CHANGE_BATCH_LIMIT,
  EVENT_CHANGE_POLL_INTERVAL_MS,
  type EventChangePage,
  type EventChangeSummary,
  type EventChangeType,
} from "./realtime-types";

type ChangeRow = {
  sequence: number;
  eventId: string;
  entityType: string;
  entityId: string | null;
  changeType: EventChangeType;
  correlationId: string | null;
  createdAt: number;
};

export type RecordEventChangeInput = {
  entityType: string;
  entityId?: string | null;
  changeType: EventChangeType;
  correlationId?: string | null;
};

export type EventScope = {
  organisationId: string;
  eventId: string;
};

export class EventRealtimeConfigurationError extends Error {
  constructor() {
    super(
      "EVENT_CHANNEL Durable Object binding is required for realtime event updates.",
    );
    this.name = "EventRealtimeConfigurationError";
  }
}

export class EventChangeNotFoundError extends Error {
  constructor() {
    super("The committed event change was not found in the authorised event.");
    this.name = "EventChangeNotFoundError";
  }
}

function safeCursor(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(
      "Event change cursor must be a non-negative safe integer.",
    );
  return value;
}

function safeLimit(value: number) {
  if (!Number.isFinite(value)) return EVENT_CHANGE_BATCH_LIMIT;
  return Math.max(1, Math.min(EVENT_CHANGE_BATCH_LIMIT, Math.trunc(value)));
}

function channelName(scope: EventScope) {
  return `${scope.organisationId.length}:${scope.organisationId}${scope.eventId}`;
}

function toSummary(row: ChangeRow): EventChangeSummary {
  return {
    type: "event-change",
    eventId: row.eventId,
    cursor: Number(row.sequence),
    entityType: row.entityType,
    entityId: row.entityId,
    changeType: row.changeType,
    correlationId: row.correlationId,
    committedAt: Number(row.createdAt),
  };
}

export class EventRealtimeService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async getLatestCursor(scope: EventScope) {
    const event = await this.env.DB.prepare(
      `SELECT COALESCE(MAX(change.sequence), 0) AS cursor
         FROM events event
         LEFT JOIN event_changes change ON change.event_id = event.id
        WHERE event.id = ? AND event.organisation_id = ?
        GROUP BY event.id`,
    )
      .bind(scope.eventId, scope.organisationId)
      .first<{ cursor: number }>();
    if (!event) throw new EventChangeNotFoundError();
    return safeCursor(Number(event.cursor));
  }

  /**
   * Records durable intent first, then emits an invalidation. A channel failure is
   * surfaced to the caller; D1 polling can still observe the committed row.
   */
  async recordChange(
    scope: EventScope,
    input: RecordEventChangeInput,
  ): Promise<EventChangeSummary> {
    const summary = await this.commitChange(scope, input);
    await this.broadcast(summary, scope);
    return summary;
  }

  /** Persists the authoritative cursor without requiring the signal channel. */
  async commitChange(
    scope: EventScope,
    input: RecordEventChangeInput,
  ): Promise<EventChangeSummary> {
    if (!input.entityType.trim())
      throw new TypeError("Event change entityType is required.");

    const row = await this.env.DB.prepare(
      `
      INSERT INTO event_changes (
        event_id, entity_type, entity_id, change_type, correlation_id, created_at
      )
      SELECT id, ?, ?, ?, ?, unixepoch()
        FROM events
       WHERE id = ? AND organisation_id = ?
      RETURNING sequence, event_id AS eventId, entity_type AS entityType,
                entity_id AS entityId, change_type AS changeType,
                correlation_id AS correlationId, created_at AS createdAt
    `,
    )
      .bind(
        input.entityType.trim(),
        input.entityId ?? null,
        input.changeType,
        input.correlationId ?? null,
        scope.eventId,
        scope.organisationId,
      )
      .first<ChangeRow>();

    if (!row) throw new EventChangeNotFoundError();
    return toSummary(row);
  }

  /**
   * Use after a transaction/batch that already inserted event_changes. The D1
   * lookup proves the row committed and belongs to the authorised tenant/event
   * before anything is broadcast.
   */
  async notifyCommittedChange(
    scope: EventScope,
    sequence: number,
  ): Promise<EventChangeSummary> {
    const row = await this.env.DB.prepare(
      `
      SELECT c.sequence, c.event_id AS eventId, c.entity_type AS entityType,
             c.entity_id AS entityId, c.change_type AS changeType,
             c.correlation_id AS correlationId, c.created_at AS createdAt
        FROM event_changes c
        JOIN events e ON e.id = c.event_id
       WHERE c.sequence = ? AND c.event_id = ? AND e.organisation_id = ?
    `,
    )
      .bind(safeCursor(sequence), scope.eventId, scope.organisationId)
      .first<ChangeRow>();

    if (!row) throw new EventChangeNotFoundError();
    const summary = toSummary(row);
    await this.broadcast(summary, scope);
    return summary;
  }

  /** Authoritative bounded polling fallback. */
  async getChangesSince(
    scope: EventScope,
    cursor: number,
    requestedLimit = EVENT_CHANGE_BATCH_LIMIT,
  ): Promise<EventChangePage> {
    const requestedCursor = safeCursor(cursor);
    const limit = safeLimit(requestedLimit);
    const event = await this.env.DB.prepare(
      `
      SELECT e.id,
             COALESCE((SELECT MAX(sequence) FROM event_changes WHERE event_id = e.id), 0) AS latestCursor
        FROM events e
       WHERE e.id = ? AND e.organisation_id = ?
    `,
    )
      .bind(scope.eventId, scope.organisationId)
      .first<{ id: string; latestCursor: number }>();
    if (!event) throw new EventChangeNotFoundError();

    // Prevent a malformed/future cursor from permanently skipping real changes.
    const boundedCursor = Math.min(requestedCursor, Number(event.latestCursor));
    const result = await this.env.DB.prepare(
      `
      SELECT sequence, event_id AS eventId, entity_type AS entityType,
             entity_id AS entityId, change_type AS changeType,
             correlation_id AS correlationId, created_at AS createdAt
        FROM event_changes
       WHERE event_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?
    `,
    )
      .bind(scope.eventId, boundedCursor, limit + 1)
      .all<ChangeRow>();

    const rows = result.results ?? [];
    const hasMore = rows.length > limit;
    const changes = rows.slice(0, limit).map(toSummary);
    return {
      changes,
      cursor: changes.at(-1)?.cursor ?? boundedCursor,
      hasMore,
      pollAfterMs: hasMore ? 0 : EVENT_CHANGE_POLL_INTERVAL_MS,
    };
  }

  async connect(scope: EventScope, request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", {
        status: 426,
        headers: { upgrade: "websocket" },
      });
    }
    const stub = this.channel(scope);
    return stub.fetch("https://event-channel.internal/connect", {
      headers: {
        upgrade: "websocket",
        "x-program-cue-organisation-id": scope.organisationId,
        "x-program-cue-event-id": scope.eventId,
      },
    });
  }

  private channel(scope: EventScope) {
    const namespace = (
      this.env as CloudflareEnvironment & {
        EVENT_CHANNEL?: DurableObjectNamespace;
      }
    ).EVENT_CHANNEL;
    if (!namespace) throw new EventRealtimeConfigurationError();
    return namespace.get(namespace.idFromName(channelName(scope)));
  }

  private async broadcast(summary: EventChangeSummary, scope: EventScope) {
    const response = await this.channel(scope).fetch(
      "https://event-channel.internal/publish",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-program-cue-organisation-id": scope.organisationId,
          "x-program-cue-event-id": scope.eventId,
        },
        body: JSON.stringify(summary),
      },
    );
    if (!response.ok)
      throw new Error(
        `Event channel rejected committed change (${response.status}).`,
      );
  }
}
