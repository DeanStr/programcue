import {
  EVENT_CHANGE_MAX_POLL_INTERVAL_MS,
  EVENT_CHANGE_POLL_INTERVAL_MS,
  type EventChangePage,
  type EventChangeSummary,
  isEventChangeSummary,
} from "./realtime-types";

export type RealtimeInvalidationOptions = {
  liveUrl: string;
  pollUrl: string;
  initialCursor: number;
  onInvalidate(changes: EventChangeSummary[]): void;
  onError?(error: unknown): void;
  onStatusChange?(status: RealtimeTransportStatus): void;
};

export type RealtimeTransportStatus =
  | "connecting"
  | "live"
  | "polling"
  | "unavailable";

function boundedDelay(value: unknown) {
  const delay =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : EVENT_CHANGE_POLL_INTERVAL_MS;
  return Math.max(0, Math.min(EVENT_CHANGE_MAX_POLL_INTERVAL_MS, delay));
}

function websocketUrl(value: string) {
  const url = new URL(value, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Subscribes to invalidations only. Consumers must reload authoritative server
 * data in onInvalidate; this helper intentionally stores no application state.
 */
export function subscribeToEventChanges(options: RealtimeInvalidationOptions) {
  if (
    !Number.isSafeInteger(options.initialCursor) ||
    options.initialCursor < 0
  ) {
    throw new RangeError(
      "Realtime initial cursor must be a non-negative safe integer.",
    );
  }
  let cursor = options.initialCursor;
  let stopped = false;
  let polling = false;
  let pollHealthy = false;
  let socketOpen = false;
  let transportSettled = false;
  let socket: WebSocket | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const report = (error: unknown) => {
    if (!stopped) options.onError?.(error);
  };

  const reportStatus = () => {
    if (stopped) return;
    const status: RealtimeTransportStatus = socketOpen
      ? "live"
      : pollHealthy
        ? "polling"
        : transportSettled
          ? "unavailable"
          : "connecting";
    options.onStatusChange?.(status);
  };

  function schedulePoll(delay = EVENT_CHANGE_POLL_INTERVAL_MS) {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, boundedDelay(delay));
  }

  async function poll() {
    if (stopped || polling) return;
    polling = true;
    const requestedCursor = cursor;
    try {
      const url = new URL(options.pollUrl, window.location.href);
      url.searchParams.set("cursor", String(requestedCursor));
      const response = await fetch(url, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok)
        throw new Error(`Realtime cursor poll failed (${response.status}).`);
      const page = (await response.json()) as EventChangePage;
      if (
        !Number.isSafeInteger(page.cursor) ||
        page.cursor < 0 ||
        !Array.isArray(page.changes) ||
        typeof page.hasMore !== "boolean" ||
        typeof page.pollAfterMs !== "number" ||
        !Number.isFinite(page.pollAfterMs) ||
        !page.changes.every(isEventChangeSummary)
      ) {
        throw new Error("Realtime cursor poll returned an invalid response.");
      }
      const changes = page.changes.filter((change) => change.cursor > cursor);
      // D1 is authoritative and may legitimately return a lower bounded cursor
      // after a restore/reset. Do not let a stale in-flight poll roll back a
      // cursor which has advanced through the WebSocket in the meantime.
      const acceptedAuthoritativeRollback =
        cursor === requestedCursor && page.cursor < requestedCursor;
      cursor =
        cursor === requestedCursor
          ? page.cursor
          : Math.max(cursor, page.cursor);
      pollHealthy = true;
      transportSettled = true;
      reportStatus();
      if (!stopped && (changes.length > 0 || acceptedAuthoritativeRollback)) {
        // An empty list signals that the authoritative dataset itself changed
        // across a restore/reset and consumers must reload their full snapshot.
        options.onInvalidate(changes);
      }
      schedulePoll(page.hasMore ? 0 : page.pollAfterMs);
    } catch (error) {
      pollHealthy = false;
      transportSettled = true;
      reportStatus();
      report(error);
      schedulePoll(EVENT_CHANGE_POLL_INTERVAL_MS);
    } finally {
      polling = false;
    }
  }

  function connect() {
    if (stopped) return;
    try {
      socket = new WebSocket(websocketUrl(options.liveUrl));
      socket.addEventListener("open", () => {
        socketOpen = true;
        transportSettled = true;
        reportStatus();
      });
      socket.addEventListener("message", (event) => {
        if (stopped) return;
        try {
          const message = JSON.parse(String(event.data)) as unknown;
          if (isEventChangeSummary(message)) {
            if (message.cursor > cursor) {
              cursor = message.cursor;
              options.onInvalidate([message]);
            }
          } else if (
            message &&
            typeof message === "object" &&
            (message as { type?: string }).type === "ready"
          ) {
            // A channel cursor ahead of ours means we may have missed signals.
            // Read D1 rather than trusting the channel as application state.
            const readyCursor = Number(
              (message as { cursor?: unknown }).cursor,
            );
            if (!Number.isSafeInteger(readyCursor) || readyCursor < 0) {
              throw new Error(
                "Realtime WebSocket returned an invalid ready message.",
              );
            }
            if (readyCursor > cursor) void poll();
          } else {
            throw new Error(
              "Realtime WebSocket returned an unsupported message.",
            );
          }
        } catch (error) {
          socketOpen = false;
          socket?.close(1002, "Invalid realtime message");
          reportStatus();
          report(error);
        }
      });
      socket.addEventListener("close", () => {
        socket = null;
        socketOpen = false;
        transportSettled = true;
        reportStatus();
        if (!stopped)
          reconnectTimer = setTimeout(connect, EVENT_CHANGE_POLL_INTERVAL_MS);
      });
      socket.addEventListener("error", () => {
        socketOpen = false;
        transportSettled = true;
        reportStatus();
        report(
          new Error(
            "Realtime WebSocket connection failed; cursor polling remains active.",
          ),
        );
      });
    } catch (error) {
      socketOpen = false;
      transportSettled = true;
      reportStatus();
      report(error);
      reconnectTimer = setTimeout(connect, EVENT_CHANGE_POLL_INTERVAL_MS);
    }
  }

  reportStatus();
  connect();
  void poll();

  return () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close(1000, "Subscription stopped");
  };
}
