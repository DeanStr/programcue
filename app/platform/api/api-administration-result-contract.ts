import { z } from "zod";

const identifier = z.string().min(1);
const revision = z.number().int().nonnegative();

export const formCommandResultSchema = z.object({
  formId: identifier,
  revision,
  draftVersionId: identifier,
  draftRevision: revision,
  publishedVersionId: identifier.nullable(),
  status: z.string().min(1),
});
export const resourceCommandResultSchema = z.object({
  pageId: identifier,
  revision,
  status: z.string().min(1),
  versionId: identifier,
  versionNumber: z.number().int().positive(),
});
export const decisionCommandResultSchema = z.object({
  decisionId: identifier,
  status: z.string().min(1),
  decision: z.string().min(1),
  submissionId: identifier,
  sessionId: identifier.nullable(),
  notificationOperationId: identifier.nullable(),
  notificationStatus: z.string().min(1).nullable(),
});
export const sessionLifecycleResultSchema = z.object({
  operationId: identifier,
  action: z.enum(["archive", "restore"]),
  changedCount: z.number().int().nonnegative(),
  undoExpiresAt: z.number().int().nullable(),
});
export const membershipCommandResultSchema = z.object({
  membershipId: identifier,
  scope: z.enum(["event", "organisation"]),
});
export const invitationCommandResultSchema =
  membershipCommandResultSchema.extend({
    status: z.literal("invited"),
  });
export const taskTemplateCommandResultSchema = z.object({
  templateId: identifier,
});
export const taskAssignmentCommandResultSchema = z.object({
  taskId: identifier,
});
export const integrationConnectionResultSchema = z.object({
  connectionId: identifier,
});
export const integrationMappingResultSchema = z.object({
  mappingId: identifier,
});
export const webhookStatusResultSchema = z.object({
  endpointId: identifier,
  status: z.enum(["active", "disabled"]),
});
export const webhookTestResultSchema = z.object({
  deliveryId: identifier,
  operationId: identifier,
  status: z.string().min(1),
  replayed: z.boolean(),
});
export const webhookSecretResultSchema = z.object({
  endpointId: identifier,
  secret: z.string().min(1),
  secretCiphertext: z.string().min(1),
});
export const storedWebhookSecretSchema = z.object({
  endpointId: identifier,
  secretFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  // Deployed records before the credential-rotation change use ciphertext fingerprints.
  secretFingerprintVersion: z.literal(2).optional(),
});
