import { z } from "zod";

import {
  decisionBaseSchema,
  requireAcceptedSessionTrack,
} from "~/modules/evaluations/evaluation-schema";
import {
  administratorInvitationSchema,
  administratorRevocationSchema,
} from "~/modules/events/event-schema";
import { scannerCallbackPayloadSchema } from "~/modules/files/scanner-callback.server";
import {
  configureIntegrationConnectionSchema,
  integrationMappingInputSchema,
} from "~/modules/integrations/integration-service.server";
import { resourceInputSchema } from "~/modules/resources/resource-service-shared";
import { scheduleSessionContentSchema } from "~/modules/schedule/schedule-schema";
import {
  formFieldSchema,
  formSchemaSchema,
  routingSchema,
  saveFormSchema,
} from "~/modules/submissions/submission-schema";
import {
  participantEvidenceSchema,
  taskTemplateInputSchema,
} from "~/modules/tasks/task-schema";
import {
  outboundWebhookEventTypeSchema,
  outboundWebhookEventTypes,
} from "~/platform/operations/webhook-schema";
import { webhookEndpointSchema } from "~/platform/operations/webhook-service.server";

const apiFormFieldSchema = formFieldSchema
  .safeExtend({
    required: z.boolean(),
    reviewVisibility: z.enum(["reviewers", "administrators_only"]),
    blindReviewVisibility: z.enum(["content", "identity"]).optional(),
    condition: z
      .object({
        fieldId: z.string(),
        equals: z.string().max(120),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
const apiFormSchema = formSchemaSchema
  .safeExtend({ fields: z.array(apiFormFieldSchema).min(1).max(50) })
  .strict();
const apiFormRoutingSchema = routingSchema
  .safeExtend({
    categories: z.record(z.string(), z.string().trim().min(1).max(100)),
  })
  .strict();
export const apiFormSaveSchema = saveFormSchema
  .safeExtend({
    schema: apiFormSchema,
    routing: apiFormRoutingSchema,
  })
  .strict();

export const apiFormPublishSchema = z
  .object({
    formRevision: z.number().int().positive(),
    draftRevision: z.number().int().positive(),
  })
  .strict();

export const apiPersonInvitationSchema = administratorInvitationSchema.strict();
export const apiMembershipRevocationSchema = administratorRevocationSchema
  .extend({ confirmed: z.literal(true) })
  .strict();

export const apiSessionEditSchema = scheduleSessionContentSchema.strict();
export const apiSessionLifecycleSchema = z
  .object({ confirmed: z.literal(true) })
  .strict();

export const apiDecisionSchema = decisionBaseSchema
  .omit({ release: true })
  .extend({ confirmed: z.literal(true) })
  .strict()
  .superRefine(requireAcceptedSessionTrack);

export const apiTaskTemplateSchema = taskTemplateInputSchema.strict();
export const apiTaskAssignmentSchema = z
  .object({
    templateId: z.string().trim().min(1).max(200),
    targetId: z.string().trim().min(1).max(200),
  })
  .strict();
export const apiParticipantTaskCompletionSchema =
  participantEvidenceSchema.strict();

export const apiResourceSaveSchema = resourceInputSchema.strict();
export const apiResourcePublishSchema = z
  .object({ revision: z.number().int().positive() })
  .strict();

export const apiIntegrationConnectionSchema =
  configureIntegrationConnectionSchema.strict();
export const apiIntegrationDisconnectSchema = z
  .object({ confirmed: z.literal(true) })
  .strict();
export const apiIntegrationMappingSchema = integrationMappingInputSchema;
export const apiIntegrationMappingDeleteSchema = z
  .object({
    entityType: z.enum(["speaker", "track", "session", "session_speaker"]),
    entityId: z.string().trim().min(1).max(300),
    confirmed: z.literal(true),
  })
  .strict();

export const apiWebhookEndpointSchema = webhookEndpointSchema;
export const apiWebhookStatusSchema = z
  .object({ status: z.enum(["active", "disabled"]) })
  .strict();
export const apiWebhookTestSchema = z
  .object({ confirmed: z.literal(true) })
  .strict();
export const apiWebhookRotateSecretSchema = z
  .object({ confirmed: z.literal(true) })
  .strict();

export const apiAdministrationFamilySchema = z.enum([
  "forms",
  "people",
  "memberships",
  "sessions",
  "decisions",
  "task-templates",
  "task-assignments",
  "resources",
  "integration-connections",
  "integration-mappings",
  "webhook-endpoints",
]);

export const apiAdministrationCommandSchema = z.enum([
  "save",
  "publish",
  "invite",
  "revoke",
  "edit",
  "archive",
  "restore",
  "draft",
  "release",
  "assign",
  "connect",
  "disconnect",
  "delete",
  "status",
  "test",
  "rotate-secret",
]);

/** Schemas below are the generated OpenAPI component source of truth. */
export const apiGeneratedSchemas = {
  AdministrationFormSaveRequest: apiFormSaveSchema,
  AdministrationFormPublishRequest: apiFormPublishSchema,
  AdministrationPersonInvitationRequest: apiPersonInvitationSchema,
  AdministrationMembershipRevocationRequest: apiMembershipRevocationSchema,
  AdministrationSessionEditRequest: apiSessionEditSchema,
  AdministrationSessionLifecycleRequest: apiSessionLifecycleSchema,
  AdministrationDecisionRequest: apiDecisionSchema,
  AdministrationTaskTemplateRequest: apiTaskTemplateSchema,
  AdministrationTaskAssignmentRequest: apiTaskAssignmentSchema,
  ParticipantTaskCompletionRequest: apiParticipantTaskCompletionSchema,
  AdministrationResourceSaveRequest: apiResourceSaveSchema,
  AdministrationResourcePublishRequest: apiResourcePublishSchema,
  AdministrationIntegrationConnectionRequest: apiIntegrationConnectionSchema,
  AdministrationIntegrationDisconnectRequest: apiIntegrationDisconnectSchema,
  AdministrationIntegrationMappingRequest: apiIntegrationMappingSchema,
  AdministrationIntegrationMappingDeleteRequest:
    apiIntegrationMappingDeleteSchema,
  AdministrationWebhookEndpointRequest: apiWebhookEndpointSchema,
  AdministrationWebhookStatusRequest: apiWebhookStatusSchema,
  AdministrationWebhookTestRequest: apiWebhookTestSchema,
  AdministrationWebhookRotateSecretRequest: apiWebhookRotateSecretSchema,
  AdministrationFamily: apiAdministrationFamilySchema,
  AdministrationCommand: apiAdministrationCommandSchema,
  OutboundWebhookEventType: outboundWebhookEventTypeSchema,
  FileScannerCallbackRequest: scannerCallbackPayloadSchema,
} satisfies Record<string, z.ZodType>;

export { outboundWebhookEventTypes };
