export class CalendarStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarStateError";
  }
}

/**
 * The cause is kept for logs rather than appended to the message: it is an
 * infrastructure diagnostic, and the reader's next step is the same either way.
 */
export class CalendarQueueUnavailableError extends Error {
  constructor(
    readonly operationId: string,
    cause?: unknown,
  ) {
    super(
      "The calendar invitation was saved but could not be sent. Retry it from the Operation Centre.",
      cause ? { cause } : undefined,
    );
    this.name = "CalendarQueueUnavailableError";
  }
}
