export class CalendarStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarStateError";
  }
}

export class CalendarQueueUnavailableError extends Error {
  constructor(
    readonly operationId: string,
    cause?: unknown,
  ) {
    super(
      `Calendar intent was saved, but operation ${operationId} could not be queued. Retry it from the Operation Centre.${cause ? ` ${cause instanceof Error ? cause.message : String(cause)}` : ""}`,
    );
    this.name = "CalendarQueueUnavailableError";
  }
}
