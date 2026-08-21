import type { ScheduleConflict } from "./schedule-rules";

export class ScheduleRevisionConflictError extends Error {
  constructor(
    message = "The schedule changed after this page loaded. Refresh before applying another change.",
  ) {
    super(message);
    this.name = "ScheduleRevisionConflictError";
  }
}

export class ScheduleUndoUnavailableError extends Error {
  constructor(
    message = "This schedule change can no longer be undone. Refresh to see the authoritative schedule.",
  ) {
    super(message);
    this.name = "ScheduleUndoUnavailableError";
  }
}

export class ScheduleNotFoundError extends Error {
  constructor(message = "Draft schedule not found.") {
    super(message);
    this.name = "ScheduleNotFoundError";
  }
}

export class SchedulePublicationBlockedError extends Error {
  constructor(
    readonly conflicts: ReadonlyArray<ScheduleConflict>,
    message?: string,
  ) {
    super(
      message ??
        `Resolve ${conflicts.length} blocking schedule conflict${conflicts.length === 1 ? "" : "s"} before publishing.`,
    );
    this.name = "SchedulePublicationBlockedError";
  }
}

export class SchedulePlacementBlockedError extends Error {
  constructor(readonly conflicts: ReadonlyArray<ScheduleConflict>) {
    super(
      `Resolve ${conflicts.length} blocking schedule conflict${conflicts.length === 1 ? "" : "s"} before placing this session.`,
    );
    this.name = "SchedulePlacementBlockedError";
  }
}

export class ScheduleConfigurationError extends Error {
  constructor(
    message = "This event is missing its required schedule policy configuration.",
  ) {
    super(message);
    this.name = "ScheduleConfigurationError";
  }
}

export class ScheduleReviewLinkLimitError extends Error {
  constructor(
    message = "This event already has 10 active draft review links. Revoke one before creating another.",
  ) {
    super(message);
    this.name = "ScheduleReviewLinkLimitError";
  }
}

export class ScheduleReviewLinkNotFoundError extends Error {
  constructor(message = "That draft review link was not found.") {
    super(message);
    this.name = "ScheduleReviewLinkNotFoundError";
  }
}

export class ScheduleReviewLinkExpiredError extends Error {
  constructor(message = "That draft review link has already expired.") {
    super(message);
    this.name = "ScheduleReviewLinkExpiredError";
  }
}

export class ScheduleIdempotencyConflictError extends Error {
  constructor(
    readonly code: "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    message: string,
  ) {
    super(message);
    this.name = "ScheduleIdempotencyConflictError";
  }
}
