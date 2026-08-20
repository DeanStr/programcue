import { z } from "zod";
import { contentZipQueueMessageSchema } from "./content-schema";

export const MAX_ZIP_BYTES = 100 * 1024 * 1024;

export const zipManifestEntrySchema = z.object({
  assetId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160),
  objectEtag: z.string().min(1).max(300),
  sizeBytes: z.number().int().nonnegative().max(MAX_ZIP_BYTES),
  filename: z.string().min(1).max(500),
  sessionName: z.string().min(1).max(300),
  speakerName: z.string().min(1).max(300),
  createdAt: z.number().int().positive(),
});

export const zipManifestSchema = z.array(zipManifestEntrySchema).min(1).max(20);

export function parseZipQueuePayload(
  payloadJson: string,
  operation: { id: string; eventId: string; organisationId: string },
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error("The ZIP export has invalid durable payload JSON.");
  }
  const message = contentZipQueueMessageSchema.parse(parsed);
  if (
    message.operationId !== operation.id ||
    message.eventId !== operation.eventId ||
    message.organisationId !== operation.organisationId
  ) {
    throw new Error(
      "The ZIP export payload does not match its durable operation identity.",
    );
  }
  return message;
}
