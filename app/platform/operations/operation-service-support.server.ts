import type { Viewer } from "~/platform/auth/authorize.server";

/**
 * `operationId` stays on the error so callers can link to the exact record; it
 * is not spelled out in the message, because a bare identifier is not something
 * the reader can use — the link is.
 */
export class OperationQueueUnavailableError extends Error {
  constructor(readonly operationId: string) {
    super(
      "This work was saved but could not be started. Retry it from the Operation Centre.",
    );
    this.name = "OperationQueueUnavailableError";
  }
}

export class OperationNotFoundError extends Error {
  constructor() {
    super("Operation not found.");
    this.name = "OperationNotFoundError";
  }
}

export class OperationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationStateError";
  }
}

export function parseRetryQueueMessage(
  payloadJson: string,
  operation: { id: string; type: string },
  viewer: Pick<Viewer, "eventId" | "organisationId">,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new OperationStateError(
      "The saved operation payload is invalid and cannot be retried.",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).type !== operation.type ||
    (parsed as Record<string, unknown>).operationId !== operation.id ||
    (parsed as Record<string, unknown>).eventId !== viewer.eventId ||
    (parsed as Record<string, unknown>).organisationId !== viewer.organisationId
  ) {
    throw new OperationStateError(
      "The saved operation payload does not match the operation tenant identity and cannot be retried.",
    );
  }
  return parsed as Record<string, unknown>;
}
