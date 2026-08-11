import { z } from "zod";

export const outboundWebhookEventTypes = [
  "submission.created",
  "submission.submitted",
  "submission.withdrawn",
  "review.submitted",
  "review.reopened",
  "round.advanced",
  "decision.recorded",
  "decision.released",
  "speaker.updated",
  "task.created",
  "task.updated",
  "session.created",
  "session.updated",
  "schedule.published",
  "communication.completed",
] as const;

export const outboundWebhookEventTypeSchema = z.enum(
  outboundWebhookEventTypes,
);

export const webhookDeliveryMessageSchema = z
  .object({
    type: z.literal("webhook.deliver"),
    operationId: z.string().min(1).max(200),
    deliveryId: z.string().min(1).max(200),
    eventId: z.string().min(1).max(200),
    organisationId: z.string().min(1).max(200),
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();

export type WebhookDeliveryMessage = z.infer<
  typeof webhookDeliveryMessageSchema
>;
