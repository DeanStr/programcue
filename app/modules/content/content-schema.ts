import { z } from "zod";

export const contentStatusSchema = z.enum([
  "draft",
  "in_review",
  "approved",
  "changes_requested",
]);

export type ContentStatus = z.infer<typeof contentStatusSchema>;

export const contentStatusChangeSchema = z.object({
  scheduleVersionId: z.string().min(1).max(160),
  sessionId: z.string().min(1).max(160),
  scheduleRevision: z.coerce.number().int().positive(),
  contentRevision: z.coerce.number().int().positive(),
  status: contentStatusSchema,
  confirmed: z.union([z.literal("true"), z.literal(true)]),
});

export const contentRestoreSchema = z.object({
  scheduleVersionId: z.string().min(1).max(160),
  sessionId: z.string().min(1).max(160),
  revisionId: z.string().min(1).max(160),
  scheduleRevision: z.coerce.number().int().positive(),
  contentRevision: z.coerce.number().int().positive(),
  confirmed: z.union([z.literal("true"), z.literal(true)]),
});

export const contentZipPreviewSchema = z.object({
  assetIds: z.array(z.string().min(1).max(160)).min(1).max(20),
  groupBy: z.enum(["session", "speaker"]),
});

export const contentZipConfirmSchema = z.object({
  manifest: z.string().min(2).max(40_000),
  groupBy: z.enum(["session", "speaker"]),
  confirmed: z.union([z.literal("true"), z.literal(true)]),
});

export const contentZipQueueMessageSchema = z.object({
  type: z.literal("content.zip.export"),
  operationId: z.string().min(1).max(160),
  organisationId: z.string().min(1).max(160),
  eventId: z.string().min(1).max(160),
  idempotencyKey: z.string().min(1).max(200),
  manifest: z.string().min(2).max(40_000),
  groupBy: z.enum(["session", "speaker"]),
});

export type ContentZipQueueMessage = z.infer<
  typeof contentZipQueueMessageSchema
>;
