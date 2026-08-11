export class WebhookEndpointNotFoundError extends Error {
  constructor() {
    super("Webhook endpoint not found.");
    this.name = "WebhookEndpointNotFoundError";
  }
}

export class WebhookQueueUnavailableError extends Error {
  constructor(readonly operationId: string) {
    super(
      `Webhook test ${operationId} was saved but could not be queued. Retry it from the Operation Centre.`,
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
      `Webhook operation ${operationId} already uses this idempotency key for different event content.`,
    );
    this.name = "WebhookEventIdempotencyConflictError";
  }
}
