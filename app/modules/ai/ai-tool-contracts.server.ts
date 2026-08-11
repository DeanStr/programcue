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
import { apiTaskCreateSchema } from "~/platform/api/api-task-service.server";

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
};

const integerLimitParameters = {
  type: "object",
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Maximum records to inspect.",
    },
  },
  required: ["limit"],
  additionalProperties: false,
};

export const AI_TOOLS: AiToolDefinition[] = [
  {
    type: "function",
    name: "get_event_readiness",
    class: "read",
    description:
      "Read the authoritative event readiness score, workflow progress and exact blockers with links.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "find_incomplete_speakers",
    class: "read",
    description:
      "Find event speakers who have incomplete readiness tasks. Returns only authorised event records.",
    strict: true,
    parameters: integerLimitParameters,
  },
  {
    type: "function",
    name: "get_review_progress",
    class: "read",
    description:
      "Read evaluation round and assignment progress for the current event.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "inspect_schedule_conflicts",
    class: "read",
    description:
      "Inspect unresolved schedule conflicts recorded by Program Cue's deterministic conflict engine.",
    strict: true,
    parameters: integerLimitParameters,
  },
  {
    type: "function",
    name: "inspect_integration_failures",
    class: "read",
    description:
      "Inspect failed integration connections, runs and record-level errors in the current event.",
    strict: true,
    parameters: integerLimitParameters,
  },
  {
    type: "function",
    name: "search_submissions",
    class: "read",
    description:
      "Search current-event submissions by title, public reference or category.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 2,
          maxLength: 100,
          description: "Submission title, reference or category search text.",
        },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_reminder_templates",
    class: "read",
    description:
      "List published task-reminder templates that can supply the approved footer and action link for an exact reminder-send preview.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_evaluation_setup",
    class: "read",
    description:
      "Read allow-listed evaluation plan, round, rubric, evaluator, team and target fields needed to prepare rubric or reviewer-assignment previews. Private review answers and notes are excluded.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_schedule_workspace",
    class: "read",
    description:
      "Read the active draft schedule revision, rooms, sessions and placements needed for an exact placement or publication proposal.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_form_drafts",
    class: "read",
    description:
      "List current event form drafts with their exact form and draft revisions for form publication previews.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_accelevents_export_status",
    class: "read",
    description:
      "Read current-event Accelevents connection and recent run status without exposing credentials.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "draft_reminder",
    class: "draft",
    description:
      "Create an editable reminder preview for a deterministic cohort. This never queues or sends a communication.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        cohort: {
          type: "string",
          enum: [
            "incomplete_speakers",
            "overdue_speaker_tasks",
            "reviewers_with_open_assignments",
          ],
        },
        subject: { type: "string", minLength: 3, maxLength: 200 },
        body: { type: "string", minLength: 10, maxLength: 5_000 },
      },
      required: ["cohort", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_reminder_send",
    class: "write",
    description:
      "Create an immutable draft template and save an exact reminder audience/content preview. This never sends. A signed-in administrator must inspect the recipients and explicitly approve the saved preview before Program Cue can queue it.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        baseTemplateVersionId: {
          type: "string",
          format: "uuid",
          description:
            "Published task-reminder template version returned by list_reminder_templates. Its approved footer and optional action link are retained.",
        },
        audienceType: {
          type: "string",
          enum: [
            "incomplete_speakers",
            "due_speakers",
            "overdue_speakers",
            "event_administrators",
          ],
        },
        kind: {
          type: "string",
          enum: ["transactional", "optional"],
        },
        subject: { type: "string", minLength: 3, maxLength: 200 },
        body: { type: "string", minLength: 10, maxLength: 100000 },
      },
      required: [
        "baseTemplateVersionId",
        "audienceType",
        "kind",
        "subject",
        "body",
      ],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_form_draft",
    class: "write",
    description:
      "Prepare an exact preview for creating one default Call for Speakers form draft. This never publishes the form and requires human approval before saving the draft.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 3, maxLength: 160 },
        publicSlug: {
          type: "string",
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        },
        closeDate: {
          type: ["string", "null"],
          description: "YYYY-MM-DD or null.",
        },
        submissionLimit: {
          type: ["integer", "null"],
          minimum: 1,
        },
        minSpeakers: { type: "integer", minimum: 1, maximum: 20 },
        maxSpeakers: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 20,
        },
      },
      required: [
        "name",
        "publicSlug",
        "closeDate",
        "submissionLimit",
        "minSpeakers",
        "maxSpeakers",
      ],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_rubric_update",
    class: "write",
    description:
      "Prepare an exact preview for updating the rubric of one existing draft evaluation round. Use current round IDs/revisions and preserve domain weight invariants. Approval is required before the draft is saved.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        roundId: { type: "string", minLength: 1, maxLength: 200 },
        revision: { type: "integer", minimum: 1 },
        name: { type: "string", minLength: 1, maxLength: 120 },
        dueAt: {
          type: ["string", "null"],
          description: "RFC 3339 timestamp with an explicit offset, or null.",
        },
        criteria: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 80 },
              name: { type: "string", minLength: 1, maxLength: 120 },
              description: { type: "string", maxLength: 500 },
              inputType: {
                type: "string",
                enum: ["scale_5", "scale_10", "yes_no", "free_text"],
              },
              weightPercent: {
                type: "integer",
                minimum: 0,
                maximum: 100,
              },
              required: { type: "boolean" },
              position: { type: "integer", minimum: 0 },
            },
            required: [
              "id",
              "name",
              "description",
              "inputType",
              "weightPercent",
              "required",
              "position",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["roundId", "revision", "name", "dueAt", "criteria"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_reviewer_assignment",
    class: "write",
    description:
      "Prepare an exact reviewer-by-target assignment preview for one active evaluation round. Approval is required before EvaluationService creates assignments.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        roundId: { type: "string", minLength: 1, maxLength: 200 },
        targetType: {
          type: "string",
          enum: ["submission", "session"],
        },
        targetIds: {
          type: "array",
          minItems: 1,
          maxItems: 1000,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        evaluatorPersonIds: {
          type: "array",
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        teamId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
      },
      required: [
        "roundId",
        "targetType",
        "targetIds",
        "evaluatorPersonIds",
        "teamId",
      ],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_email_template_draft",
    class: "write",
    description:
      "Prepare an exact preview for saving one editable email template draft. This never publishes or sends the template; approval is required before the draft record is created.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 160 },
        category: {
          type: "string",
          enum: ["task_reminder", "schedule", "calendar", "ad_hoc"],
        },
        subject: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", minLength: 1, maxLength: 100000 },
        physicalAddress: { type: "string", minLength: 1, maxLength: 500 },
        buttonText: { type: ["string", "null"], minLength: 1, maxLength: 80 },
        buttonUrl: { type: ["string", "null"], format: "uri" },
      },
      required: [
        "name",
        "category",
        "subject",
        "body",
        "physicalAddress",
        "buttonText",
        "buttonUrl",
      ],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_schedule_placement",
    class: "write",
    description:
      "Prepare an exact preview for placing or moving one session in the active draft schedule. Approval calls the canonical schedule placement command, which revalidates conflicts and CAS revision state.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        scheduleVersionId: { type: "string", minLength: 1, maxLength: 200 },
        scheduleRevision: { type: "integer", minimum: 1 },
        sessionId: { type: "string", minLength: 1, maxLength: 200 },
        roomId: { type: "string", minLength: 1, maxLength: 200 },
        startsAt: { type: "integer", minimum: 1 },
        endsAt: { type: "integer", minimum: 1 },
      },
      required: [
        "scheduleVersionId",
        "scheduleRevision",
        "sessionId",
        "roomId",
        "startsAt",
        "endsAt",
      ],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_form_publication",
    class: "write",
    description:
      "Prepare an exact publication preview for one form draft using its current form and draft revisions. Approval invokes the normal CAS publication boundary.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        formId: { type: "string", minLength: 1, maxLength: 100 },
        formRevision: { type: "integer", minimum: 1 },
        draftRevision: { type: "integer", minimum: 1 },
      },
      required: ["formId", "formRevision", "draftRevision"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_schedule_publication",
    class: "write",
    description:
      "Prepare an exact publication preview for the active draft schedule. Approval revalidates blocking conflicts and the schedule revision before publication and calendar fan-out.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        scheduleVersionId: { type: "string", minLength: 1, maxLength: 200 },
        scheduleRevision: { type: "integer", minimum: 1 },
      },
      required: ["scheduleVersionId", "scheduleRevision"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_accelevents_run",
    class: "write",
    description:
      "Prepare an exact Accelevents export plan from the connected current-event integration. Approval reruns the diff and starts the canonical idempotent integration operation; dry runs never call Accelevents.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string", minLength: 1, maxLength: 200 },
        dryRun: { type: "boolean" },
      },
      required: ["connectionId", "dryRun"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_task",
    class: "write",
    description:
      "Prepare and save a preview for creating one task. Calling this tool never creates the task; a signed-in administrator must explicitly approve the saved preview in Program Cue.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 3, maxLength: 200 },
        description: { type: ["string", "null"], maxLength: 2_000 },
        targetType: {
          type: "string",
          enum: ["speaker", "session", "event"],
        },
        targetId: { type: "string", minLength: 1, maxLength: 200 },
        ownerPersonId: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: 200,
        },
        taskType: {
          type: "string",
          enum: [
            "checklist",
            "acknowledgement",
            "short_form",
            "file_upload",
            "link_visit",
            "administrator_only",
          ],
        },
        impact: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
        },
        dueAt: {
          type: ["string", "null"],
          description: "RFC 3339 timestamp with an explicit offset, or null.",
        },
        dependencyIds: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 200 },
          maxItems: 100,
        },
      },
      required: [
        "title",
        "description",
        "targetType",
        "targetId",
        "ownerPersonId",
        "taskType",
        "impact",
        "dueAt",
        "dependencyIds",
      ],
      additionalProperties: false,
    },
  },
];
