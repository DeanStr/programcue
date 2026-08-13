import { z } from "zod";

import type { AiProposalPreview } from "./ai-types";
import type { OpenAiFunctionTool } from "./openai-responses-provider.server";
import { saveTemplateSchema } from "~/modules/communications/communication-schema";
import {
  assignmentBatchSchema,
  draftRoundUpdateSchema,
} from "~/modules/evaluations/evaluation-schema";
import {
  schedulePlacementSchema,
  schedulePublishSchema,
} from "~/modules/schedule/schedule-schema";
import { saveFormSchema } from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";

export const adminRoles = new Set<Viewer["role"]>(["owner", "administrator"]);

export const emptyArgumentsSchema = z.object({}).strict();
export const boundedLimitSchema = z
  .object({ limit: z.number().int().min(1).max(50) })
  .strict();
export const submissionSearchSchema = z
  .object({
    query: z.string().trim().min(2).max(100),
    limit: z.number().int().min(1).max(30),
  })
  .strict();
export const reminderCohortSchema = z.enum([
  "incomplete_speakers",
  "overdue_speaker_tasks",
  "reviewers_with_open_assignments",
]);
export const reminderDraftArgumentsSchema = z
  .object({
    cohort: reminderCohortSchema,
    subject: z.string().trim().min(3).max(200),
    body: z.string().trim().min(10).max(5_000),
  })
  .strict();

export const taskProposalArgumentsSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(2_000).nullable(),
    targetType: z.enum(["speaker", "session", "event"]),
    targetId: z.string().trim().min(1).max(200),
    ownerPersonId: z.string().trim().min(1).max(200).nullable(),
    taskType: z.enum([
      "checklist",
      "acknowledgement",
      "short_form",
      "file_upload",
      "link_visit",
      "administrator_only",
    ]),
    impact: z.enum(["critical", "high", "medium", "low"]),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    dependencyIds: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "dependencyIds must contain unique task IDs",
      ),
  })
  .strict();

export const reminderSendAudienceSchema = z.enum([
  "incomplete_speakers",
  "due_speakers",
  "overdue_speakers",
  "event_administrators",
]);

export const reminderSendProposalArgumentsSchema = z
  .object({
    baseTemplateVersionId: z.uuid(),
    audienceType: reminderSendAudienceSchema,
    kind: z.enum(["transactional", "optional"]),
    subject: z.string().trim().min(3).max(200),
    body: z.string().trim().min(10).max(100_000),
  })
  .strict();

export const formDraftProposalArgumentsSchema = z
  .object({
    name: z.string().trim().min(3).max(160),
    publicSlug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    closeDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    submissionLimit: z.number().int().positive().nullable(),
    minSpeakers: z.number().int().min(1).max(20),
    maxSpeakers: z.number().int().min(1).max(20).nullable(),
  })
  .strict();

export const emailTemplateDraftProposalArgumentsSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    category: z.enum(["task_reminder", "schedule", "calendar", "ad_hoc"]),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(100_000),
    physicalAddress: z.string().trim().min(1).max(500),
    buttonText: z.string().trim().min(1).max(80).nullable(),
    buttonUrl: z.url().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.buttonText) !== Boolean(value.buttonUrl)) {
      context.addIssue({
        code: "custom",
        path: [value.buttonText ? "buttonUrl" : "buttonText"],
        message: "Button text and URL must be supplied together.",
      });
    }
    if (value.buttonUrl && new URL(value.buttonUrl).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["buttonUrl"],
        message: "Button URL must use HTTPS.",
      });
    }
  });

export const formPublicationProposalArgumentsSchema = z
  .object({
    formId: z.string().trim().min(1).max(100),
    formRevision: z.number().int().positive(),
    draftRevision: z.number().int().positive(),
  })
  .strict();

export const acceleventsRunProposalArgumentsSchema = z
  .object({
    connectionId: z.string().trim().min(1).max(200),
    dryRun: z.boolean(),
  })
  .strict();

const proposalChangeSchema = z
  .object({
    field: z.string(),
    before: z.string().nullable(),
    after: z.string(),
  })
  .strict();

const affectedRecordSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    detail: z.string(),
    href: z.string(),
  })
  .strict();

function domainPreviewSchema<const TToolName extends string>(
  toolName: TToolName,
) {
  return z
    .object({
      id: z.string().uuid(),
      toolName: z.literal(toolName),
      title: z.string(),
      summary: z.string(),
      consequence: z.string(),
      changes: z.array(proposalChangeSchema),
      affectedRecords: z.array(affectedRecordSchema).optional(),
      approvalRequired: z.literal(true),
    })
    .strict();
}

const taskProposalMetadataSchema = z
  .object({
    version: z.literal(1),
    toolName: z.literal("propose_task"),
    runId: z.string().uuid(),
    model: z.string().min(1).max(100),
    arguments: taskProposalArgumentsSchema,
    preview: z
      .object({
        id: z.string().uuid(),
        toolName: z.literal("propose_task"),
        title: z.string(),
        summary: z.string(),
        consequence: z.string(),
        changes: z.array(proposalChangeSchema),
        approvalRequired: z.literal(true),
      })
      .strict(),
  })
  .strict();

const communicationRecipientSchema = z
  .object({
    personId: z.string().nullable(),
    address: z.email(),
    name: z.string(),
    sourceId: z.string().nullable(),
  })
  .strict();

const reminderProposalMetadataSchema = z
  .object({
    version: z.literal(1),
    toolName: z.literal("propose_reminder_send"),
    runId: z.string().uuid(),
    model: z.string().min(1).max(100),
    arguments: reminderSendProposalArgumentsSchema,
    preview: z
      .object({
        id: z.string().uuid(),
        toolName: z.literal("propose_reminder_send"),
        title: z.string(),
        summary: z.string(),
        consequence: z.string(),
        changes: z.array(proposalChangeSchema),
        approvalRequired: z.literal(true),
        reminder: z
          .object({
            template: z
              .object({
                id: z.uuid(),
                templateId: z.uuid(),
                name: z.string(),
                category: z.literal("task_reminder"),
                versionNumber: z.number().int().positive(),
                versionStatus: z.literal("draft"),
                subject: z.string(),
                content: z
                  .object({
                    body: z.string(),
                    physicalAddress: z.string(),
                    buttonText: z.string().optional(),
                    buttonUrl: z.url().optional(),
                  })
                  .strict(),
              })
              .strict(),
            audienceType: reminderSendAudienceSchema,
            kind: z.enum(["transactional", "optional"]),
            recipients: z
              .object({
                selected: z.number().int().nonnegative(),
                deliverable: z.array(communicationRecipientSchema),
                invalid: z.array(
                  z.object({ address: z.string(), name: z.string() }).strict(),
                ),
                suppressed: z.array(communicationRecipientSchema),
              })
              .strict(),
            confirmation: z
              .object({
                recipientFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
                deliverableFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
                suppressedCount: z.number().int().nonnegative(),
              })
              .strict(),
            rendered: z
              .object({ subject: z.string(), text: z.string() })
              .strict(),
            provider: z
              .object({
                configured: z.literal(true),
                sender: z.string().min(1),
                queueConfigured: z.literal(true),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const formPublicationSnapshotSchema = z
  .object({
    formId: z.string(),
    name: z.string(),
    publicSlug: z.string(),
    status: z.string(),
    formRevision: z.number().int().positive(),
    draftRevision: z.number().int().positive(),
    draftVersionId: z.string(),
    fieldCount: z.number().int().nonnegative(),
    schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const schedulePublicationSnapshotSchema = z
  .object({
    scheduleVersionId: z.string(),
    versionNumber: z.number().int().positive(),
    scheduleRevision: z.number().int().positive(),
    entryCount: z.number().int().nonnegative(),
    unresolvedBlockingConflicts: z.number().int().nonnegative(),
    entriesHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const acceleventsRunSnapshotSchema = z
  .object({
    connectionId: z.string(),
    connectionStatus: z.string(),
    dryRun: z.boolean(),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        create: z.number().int().nonnegative(),
        update: z.number().int().nonnegative(),
        noop: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
      })
      .strict(),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const assignmentProposalSnapshotSchema = z
  .object({
    input: assignmentBatchSchema,
    resolvedEvaluatorPersonIds: z.array(z.string()).min(1).max(100),
  })
  .strict();

const schedulePlacementProposalSnapshotSchema = z
  .object({
    input: schedulePlacementSchema,
    warningConflicts: z.array(
      z
        .object({
          type: z.string(),
          severity: z.literal("warning"),
          message: z.string(),
          conflictingEntryId: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

function domainMetadataSchema<
  const TToolName extends string,
  TArguments extends z.ZodType,
  TSnapshot extends z.ZodType,
>(toolName: TToolName, argumentsSchema: TArguments, snapshotSchema: TSnapshot) {
  return z
    .object({
      version: z.literal(1),
      toolName: z.literal(toolName),
      runId: z.string().uuid(),
      model: z.string().min(1).max(100),
      arguments: argumentsSchema,
      snapshot: snapshotSchema,
      preview: domainPreviewSchema(toolName),
    })
    .strict();
}

const formDraftProposalMetadataSchema = domainMetadataSchema(
  "propose_form_draft",
  formDraftProposalArgumentsSchema,
  saveFormSchema,
);
const rubricProposalMetadataSchema = domainMetadataSchema(
  "propose_rubric_update",
  draftRoundUpdateSchema,
  draftRoundUpdateSchema,
);
const assignmentProposalMetadataSchema = domainMetadataSchema(
  "propose_reviewer_assignment",
  assignmentBatchSchema,
  assignmentProposalSnapshotSchema,
);
const emailTemplateDraftProposalMetadataSchema = domainMetadataSchema(
  "propose_email_template_draft",
  emailTemplateDraftProposalArgumentsSchema,
  saveTemplateSchema,
);
const schedulePlacementProposalMetadataSchema = domainMetadataSchema(
  "propose_schedule_placement",
  schedulePlacementSchema,
  schedulePlacementProposalSnapshotSchema,
);
const formPublicationProposalMetadataSchema = domainMetadataSchema(
  "propose_form_publication",
  formPublicationProposalArgumentsSchema,
  formPublicationSnapshotSchema,
);
const schedulePublicationProposalMetadataSchema = domainMetadataSchema(
  "propose_schedule_publication",
  schedulePublishSchema,
  schedulePublicationSnapshotSchema,
);
const acceleventsRunProposalMetadataSchema = domainMetadataSchema(
  "propose_accelevents_run",
  acceleventsRunProposalArgumentsSchema,
  acceleventsRunSnapshotSchema,
);

export const assistantProposalMetadataSchema = z.discriminatedUnion(
  "toolName",
  [
    taskProposalMetadataSchema,
    reminderProposalMetadataSchema,
    formDraftProposalMetadataSchema,
    rubricProposalMetadataSchema,
    assignmentProposalMetadataSchema,
    emailTemplateDraftProposalMetadataSchema,
    schedulePlacementProposalMetadataSchema,
    formPublicationProposalMetadataSchema,
    schedulePublicationProposalMetadataSchema,
    acceleventsRunProposalMetadataSchema,
  ],
);

export type AiToolName =
  | "get_event_readiness"
  | "find_incomplete_speakers"
  | "get_review_progress"
  | "inspect_schedule_conflicts"
  | "inspect_integration_failures"
  | "search_submissions"
  | "list_reminder_templates"
  | "get_evaluation_setup"
  | "get_schedule_workspace"
  | "list_form_drafts"
  | "get_accelevents_export_status"
  | "draft_reminder"
  | "propose_task"
  | "propose_reminder_send"
  | "propose_form_draft"
  | "propose_rubric_update"
  | "propose_reviewer_assignment"
  | "propose_email_template_draft"
  | "propose_schedule_placement"
  | "propose_form_publication"
  | "propose_schedule_publication"
  | "propose_accelevents_run";

type AiToolDefinition = OpenAiFunctionTool & {
  name: AiToolName;
  class: "read" | "draft" | "write";
  argumentsSchema: z.ZodType;
};

function providerParameters(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema, {
    io: "input",
  });
  return requireAllProviderObjectProperties(parameters) as Record<
    string,
    unknown
  >;
}

/**
 * Strict function tools require every declared object property to be present,
 * including fields whose application schema supplies a default. Keep the Zod
 * schema as the execution source of truth, while tightening its provider view
 * recursively for the Responses API contract.
 */
function requireAllProviderObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(requireAllProviderObjectProperties);
  }
  if (!value || typeof value !== "object") return value;

  const result = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "default")
      .map(([key, child]) => [
        key,
        requireAllProviderObjectProperties(child),
      ]),
  ) as Record<string, unknown>;
  if (
    result.properties &&
    typeof result.properties === "object" &&
    !Array.isArray(result.properties)
  ) {
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  return result;
}

function defineAiTool(
  name: AiToolName,
  classification: AiToolDefinition["class"],
  description: string,
  argumentsSchema: z.ZodType,
): AiToolDefinition {
  return {
    type: "function",
    name,
    class: classification,
    description,
    strict: true,
    parameters: providerParameters(argumentsSchema),
    argumentsSchema,
  };
}

export const AI_TOOLS: AiToolDefinition[] = [
  defineAiTool(
    "get_event_readiness",
    "read",
    "Read the authoritative event readiness score, workflow progress and exact blockers with links.",
    emptyArgumentsSchema,
  ),
  defineAiTool(
    "find_incomplete_speakers",
    "read",
    "Find event speakers who have incomplete readiness tasks. Returns only authorised event records.",
    boundedLimitSchema,
  ),
  defineAiTool(
    "get_review_progress",
    "read",
    "Read evaluation round and assignment progress for the current event.",
    emptyArgumentsSchema,
  ),
  defineAiTool(
    "inspect_schedule_conflicts",
    "read",
    "Inspect unresolved schedule conflicts recorded by Program Cue's deterministic conflict engine.",
    boundedLimitSchema,
  ),
  defineAiTool(
    "inspect_integration_failures",
    "read",
    "Inspect failed integration connections, runs and record-level errors in the current event.",
    boundedLimitSchema,
  ),
  defineAiTool(
    "search_submissions",
    "read",
    "Search current-event submissions by title, public reference or category.",
    submissionSearchSchema,
  ),
  defineAiTool(
    "list_reminder_templates",
    "read",
    "List published task-reminder templates that can supply the approved footer and action link for an exact reminder-send preview.",
    emptyArgumentsSchema,
  ),
  defineAiTool(
    "get_evaluation_setup",
    "read",
    "Read allow-listed evaluation plan, round, rubric, evaluator, team and target fields needed to prepare rubric or reviewer-assignment previews. Private review answers and notes are excluded.",
    emptyArgumentsSchema,
  ),
  defineAiTool(
    "get_schedule_workspace",
    "read",
    "Read the active draft schedule revision, rooms, sessions and placements needed for an exact placement or publication proposal.",
    emptyArgumentsSchema,
  ),
  defineAiTool(
    "list_form_drafts",
    "read",
    "List current event form drafts with their exact form and draft revisions for form publication previews.",
    emptyArgumentsSchema,
  ),
  defineAiTool(
    "get_accelevents_export_status",
    "read",
    "Read current-event Accelevents connection and recent run status without exposing credentials.",
    emptyArgumentsSchema,
  ),
  defineAiTool(
    "draft_reminder",
    "draft",
    "Create an editable reminder preview for a deterministic cohort. This never queues or sends a communication.",
    reminderDraftArgumentsSchema,
  ),
  defineAiTool(
    "propose_reminder_send",
    "write",
    "Create an immutable draft template and save an exact reminder audience/content preview. This never sends. A signed-in administrator must inspect the recipients and explicitly approve the saved preview before Program Cue can queue it.",
    reminderSendProposalArgumentsSchema,
  ),
  defineAiTool(
    "propose_form_draft",
    "write",
    "Prepare an exact preview for creating one default Call for Speakers form draft. This never publishes the form and requires human approval before saving the draft.",
    formDraftProposalArgumentsSchema,
  ),
  defineAiTool(
    "propose_rubric_update",
    "write",
    "Prepare an exact preview for updating one existing draft or active evaluation round with no assignments. Use current round, criterion and revision identifiers and preserve domain weight invariants. Approval is required before the round is saved.",
    draftRoundUpdateSchema,
  ),
  defineAiTool(
    "propose_reviewer_assignment",
    "write",
    "Prepare an exact reviewer-by-target assignment preview for one active evaluation round. Approval is required before EvaluationService creates assignments.",
    assignmentBatchSchema,
  ),
  defineAiTool(
    "propose_email_template_draft",
    "write",
    "Prepare an exact preview for saving one editable email template draft. This never publishes or sends the template; approval is required before the draft record is created.",
    emailTemplateDraftProposalArgumentsSchema,
  ),
  defineAiTool(
    "propose_schedule_placement",
    "write",
    "Prepare an exact preview for placing or moving one session in the active draft schedule. Approval calls the canonical schedule placement command, which revalidates conflicts and CAS revision state.",
    schedulePlacementSchema,
  ),
  defineAiTool(
    "propose_form_publication",
    "write",
    "Prepare an exact publication preview for one form draft using its current form and draft revisions. Approval invokes the normal CAS publication boundary.",
    formPublicationProposalArgumentsSchema,
  ),
  defineAiTool(
    "propose_schedule_publication",
    "write",
    "Prepare an exact publication preview for the active draft schedule. Approval revalidates blocking conflicts and the schedule revision before publication and calendar fan-out.",
    schedulePublishSchema,
  ),
  defineAiTool(
    "propose_accelevents_run",
    "write",
    "Prepare an exact Accelevents export plan from the connected current-event integration. Approval reruns the diff and starts the canonical idempotent integration operation; dry runs never call Accelevents.",
    acceleventsRunProposalArgumentsSchema,
  ),
  defineAiTool(
    "propose_task",
    "write",
    "Prepare and save a preview for creating one task. Calling this tool never creates the task; a signed-in administrator must explicitly approve the saved preview in Program Cue.",
    taskProposalArgumentsSchema,
  ),
];
