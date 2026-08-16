export const EVENT_CHANGE_BATCH_LIMIT = 100;
export const EVENT_CHANGE_POLL_INTERVAL_MS = 10_000;
export const EVENT_CHANGE_MAX_POLL_INTERVAL_MS = 30_000;

export type EventChangeType =
  | "created"
  | "updated"
  | "deleted"
  | "published"
  | "progress";

export type EventChangeSummary = {
  type: "event-change";
  eventId: string;
  cursor: number;
  entityType: string;
  entityId: string | null;
  changeType: EventChangeType;
  correlationId: string | null;
  committedAt: number;
};

export type EventChannelReady = {
  type: "ready";
  eventId: string;
  cursor: number;
  maxPollingIntervalMs: typeof EVENT_CHANGE_MAX_POLL_INTERVAL_MS;
};

export type EventChannelMessage = EventChangeSummary | EventChannelReady;

export type EventChangePage = {
  changes: EventChangeSummary[];
  cursor: number;
  hasMore: boolean;
  pollAfterMs: number;
};

export function isEventChangeSummary(
  value: unknown,
): value is EventChangeSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EventChangeSummary>;
  return (
    candidate.type === "event-change" &&
    typeof candidate.eventId === "string" &&
    Number.isSafeInteger(candidate.cursor) &&
    Number(candidate.cursor) >= 0 &&
    typeof candidate.entityType === "string" &&
    ["created", "updated", "deleted", "published", "progress"].includes(
      String(candidate.changeType),
    ) &&
    Number.isSafeInteger(candidate.committedAt)
  );
}
