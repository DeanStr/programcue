import { z } from "zod";
import {
  EVALUATOR_EMAIL_ALIASES,
  type EvaluatorEmailAlias,
} from "~/platform/evaluation/evaluator-email-alias.server";

const id = z.string().min(1);
const workflowStatus = z.enum([
  "prospect",
  "invited",
  "confirmed",
  "declined",
  "withdrawn",
]);
export const evaluatorEmailRoutingResultSchema = z.object({
  enteredEmail: z.custom<EvaluatorEmailAlias>(
    (value) =>
      typeof value === "string" &&
      Object.hasOwn(EVALUATOR_EMAIL_ALIASES, value),
  ),
  routedEmail: z.string(),
  personId: id,
});
export const speakerInvitationResultSchema = z.object({
  commandId: id,
  accepted: z.boolean(),
  personId: id,
  email: z.string(),
  membershipId: id,
  invitationExpiresAt: z.number().int().nullable(),
});
export const speakerWorkflowResultSchema = z.object({
  personId: id,
  status: workflowStatus,
});
export const manualSpeakerResultSchema = z.object({
  personId: id,
  email: z.string(),
  createdIdentity: z.boolean(),
  createdRosterAssociation: z.boolean(),
  routing: evaluatorEmailRoutingResultSchema.nullable(),
});
export const existingSpeakerResultSchema = z.object({
  created: z.boolean(),
  eventId: id,
  personId: id,
  workflowStatus,
});
export const speakerRosterImportResultSchema = z.object({
  imported: z.number().int().nonnegative(),
  evaluatorEmailRoutings: z.array(evaluatorEmailRoutingResultSchema).optional(),
});
