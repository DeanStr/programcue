import { z } from "zod";

import { uploadTargetSchema } from "./file-service.server";
import { isApplicantActor } from "./multipart-upload-access.server";
import type {
  MultipartActor,
  MultipartRow,
} from "./multipart-upload-contracts";
import { FileMultipartStateError } from "./multipart-upload-errors";

export const MULTIPART_EXPIRY_SECONDS = 24 * 60 * 60;
export const REQUEST_CLAIM_SECONDS = 60;
export const REVOKED_COMPLETION_REASON =
  "Multipart completion was revoked because its target or file policy is no longer eligible.";

export type TaskFileScope = "participant_document" | "session_deliverable";
export type TaskFileKind = "slides" | "video" | "supporting_document";
export type TaskEvidenceFilePolicy = {
  fileScope: TaskFileScope;
  fileKind?: TaskFileKind;
};

export const multipartInitiateSchema = z.object({
  target: uploadTargetSchema,
  filename: z.string().trim().min(1).max(180),
  contentType: z.string().trim().toLowerCase().min(1).max(160),
  sizeBytes: z.number().int().positive().max(1_073_741_824),
  idempotencyKey: z
    .string()
    .trim()
    .min(16)
    .max(160)
    .regex(/^[a-zA-Z0-9._:-]+$/),
});

export const multipartPartUrlSchema = z.object({
  versionId: z.string().min(1).max(160),
  partNumber: z.number().int().min(1).max(10_000),
});

export const multipartResumeSchema = multipartInitiateSchema;

export const multipartListPartsSchema = z.object({
  versionId: z.string().min(1).max(160),
});

export const multipartCompleteSchema = z.object({
  versionId: z.string().min(1).max(160),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().trim().min(1).max(200),
      }),
    )
    .min(1)
    .max(10_000),
});

export const multipartAbortSchema = z.object({
  versionId: z.string().min(1).max(160),
});

export function multipartAuditProvenance(actor: MultipartActor) {
  if (isApplicantActor(actor)) {
    return {
      actorKind: actor.personId ? ("person" as const) : ("system" as const),
      origin: "public_form" as const,
    };
  }
  return {
    actorKind: "person" as const,
    origin: ["owner", "administrator"].includes(actor.role)
      ? ("admin_ui" as const)
      : ("participant_ui" as const),
  };
}

export {
  FileMultipartConflictError,
  FileMultipartIncompleteError,
  FileMultipartStateError,
} from "./multipart-upload-errors";

export function expectedPartCount(
  row: Pick<MultipartRow, "sizeBytes" | "partSizeBytes">,
) {
  return Math.ceil(row.sizeBytes / row.partSizeBytes);
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function normalizedManifest(
  parts: z.infer<typeof multipartCompleteSchema>["parts"],
  expected: number,
) {
  const normalized = parts
    .map((part) => ({
      partNumber: part.partNumber,
      etag: part.etag.replace(/^"|"$/g, ""),
    }))
    .sort((left, right) => left.partNumber - right.partNumber);
  if (normalized.length !== expected)
    throw new FileMultipartStateError(
      `Completion requires exactly ${expected} uploaded parts.`,
    );
  normalized.forEach((part, index) => {
    if (part.partNumber !== index + 1)
      throw new FileMultipartStateError(
        "Multipart completion requires one contiguous entry for every part.",
      );
    if (!/^[\x21-\x7e]{1,200}$/.test(part.etag))
      throw new FileMultipartStateError(
        `Part ${part.partNumber} was not stored correctly. Start the upload again.`,
      );
  });
  return normalized;
}
