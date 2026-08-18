export class WebhookEndpointNotFoundError extends Error {
  constructor() {
    super("Webhook endpoint not found.");
    this.name = "WebhookEndpointNotFoundError";
  }
}

export class WebhookEndpointCredentialsErasedError extends Error {
  constructor() {
    super(
      "This webhook endpoint's signing secret was erased during participant retention. Rotate the secret or create a new endpoint before enabling it.",
    );
    this.name = "WebhookEndpointCredentialsErasedError";
  }
}

export function webhookSecretWasErased(ciphertext: string) {
  return ciphertext.startsWith("retained-");
}

/**
 * `operationId` stays on the error so callers can link to the exact record; it
 * is not spelled out in the message, because a bare identifier is not something
 * the reader can use — the link is.
 */
export class WebhookQueueUnavailableError extends Error {
  constructor(readonly operationId: string) {
    super(
      "The webhook test was saved but could not be sent. Retry it from the Operation Centre.",
    );
    this.name = "WebhookQueueUnavailableError";
  }
}

export class WebhookQueueConfigurationError extends Error {
  constructor() {
    super("Outbound webhook delivery requires the OPERATIONS_QUEUE binding.");
    this.name = "WebhookQueueConfigurationError";
  }
}

export class WebhookEventIdempotencyConflictError extends Error {
  constructor(readonly operationId: string) {
    super(
      "An earlier webhook delivery with this reference sent different content. Open the operation in the Operation Centre before retrying.",
    );
    this.name = "WebhookEventIdempotencyConflictError";
  }
}
