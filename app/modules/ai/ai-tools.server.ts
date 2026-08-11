import { z } from "zod";

import type { AiEvidence, AiProposalPreview } from "./ai-types";
import type { OpenAiFunctionTool } from "./openai-responses-provider.server";
import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import {
  assertMergeAudienceCompatible,
  type CommunicationPreview,
} from "~/modules/communications/communication-service-shared";
import {
  renderMergeTemplate,
  representativeMergeValues,
} from "~/modules/communications/merge-template";
import {
  saveTemplateSchema,
  type SaveTemplateInput,
} from "~/modules/communications/communication-schema";
import {
  assignmentBatchSchema,
  draftRoundUpdateSchema,
} from "~/modules/evaluations/evaluation-schema";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { IntegrationService } from "~/modules/integrations/integration-service.server";
import { ReadinessService } from "~/modules/readiness/readiness-service.server";
import {
  schedulePlacementSchema,
  schedulePublishSchema,
} from "~/modules/schedule/schedule-schema";
import {
  detectScheduleConflicts,
  type ScheduledItem,
} from "~/modules/schedule/schedule-rules";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import {
  saveFormSchema,
  type SaveFormInput,
} from "~/modules/submissions/submission-schema";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { apiTaskCreateSchema } from "~/platform/api/api-task-service.server";

const adminRoles = new Set<Viewer["role"]>(["owner", "administrator"]);

const emptyArgumentsSchema = z.object({}).strict();
const boundedLimitSchema = z
  .object({ limit: z.number().int().min(1).max(50) })
  .strict();
const submissionSearchSchema = z
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
const reminderDraftArgumentsSchema = z
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

type AiToolName =
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

const AI_TOOLS: AiToolDefinition[] = [
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

export class AiToolPermissionError extends Error {
  constructor(
    message = "This assistant tool is not authorised for your role.",
  ) {
    super(message);
    this.name = "AiToolPermissionError";
  }
}

export class AiToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiToolValidationError";
  }
}

export type AiToolExecution = {
  output: unknown;
  evidence: AiEvidence[];
  proposals: AiProposalPreview[];
  auditSummary: Record<string, unknown>;
};

function parseJson(value: string, context: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${context} contains invalid JSON.`, { cause: error });
  }
}

async function hashJson(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function persistDomainProposal(
  env: CloudflareEnvironment,
  viewer: Viewer,
  rawMetadata: unknown,
) {
  const metadata = assistantProposalMetadataSchema.parse(rawMetadata);
  if (
    metadata.toolName === "propose_task" ||
    metadata.toolName === "propose_reminder_send"
  ) {
    throw new Error(
      `Domain proposal persistence does not accept ${metadata.toolName}.`,
    );
  }
  await env.DB.prepare(
    `INSERT INTO audit_events (
      id, organisation_id, event_id, actor_person_id, action,
      entity_type, entity_id, correlation_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'assistant.proposal.previewed',
              'assistant_proposal', ?, ?, ?, unixepoch())`,
  )
    .bind(
      crypto.randomUUID(),
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      metadata.preview.id,
      metadata.runId,
      JSON.stringify(metadata),
    )
    .run();
  return metadata.preview as AiProposalPreview;
}

function parseArguments<T>(name: string, value: string, schema: z.ZodType<T>) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new AiToolValidationError(
      `The selected AI provider returned invalid JSON arguments for ${name}.`,
    );
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new AiToolValidationError(
      `The selected AI provider returned invalid arguments for ${name}: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return parsed.data;
}

function likePattern(value: string) {
  return `%${value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}

function distinctEvidence(evidence: AiEvidence[]) {
  return [...new Map(evidence.map((item) => [item.id, item])).values()];
}

async function requireTargetLabel(
  env: CloudflareEnvironment,
  viewer: Viewer,
  targetType: "speaker" | "session" | "event",
  targetId: string,
) {
  if (targetType === "event") {
    const event = await env.DB.prepare(
      "SELECT name FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(targetId, viewer.organisationId)
      .first<{ name: string }>();
    if (!event || targetId !== viewer.eventId) {
      throw new AiToolValidationError(
        "The proposed task target is not the authorised event.",
      );
    }
    return event.name;
  }
  if (targetType === "session") {
    const session = await env.DB.prepare(
      `SELECT s.title FROM sessions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
       WHERE s.id = ? AND s.event_id = ?`,
    )
      .bind(viewer.organisationId, targetId, viewer.eventId)
      .first<{ title: string }>();
    if (!session)
      throw new AiToolValidationError(
        "The proposed session task target is not available in this event.",
      );
    return session.title;
  }
  const speaker = await env.DB.prepare(
    `SELECT p.display_name AS name
       FROM people p
       JOIN events event ON event.id = ? AND event.organisation_id = ?
      WHERE p.id = ? AND (
        EXISTS (SELECT 1 FROM memberships m
                 WHERE m.person_id = p.id AND m.event_id = event.id
                   AND m.role = 'speaker' AND m.accepted_at IS NOT NULL
                   AND m.revoked_at IS NULL)
        OR EXISTS (SELECT 1 FROM session_speakers ss
                    WHERE ss.person_id = p.id AND ss.event_id = event.id)
      )`,
  )
    .bind(viewer.eventId, viewer.organisationId, targetId)
    .first<{ name: string }>();
  if (!speaker)
    throw new AiToolValidationError(
      "The proposed speaker task target is not available in this event.",
    );
  return speaker.name;
}

async function validateTaskReferences(
  env: CloudflareEnvironment,
  viewer: Viewer,
  input: z.infer<typeof taskProposalArgumentsSchema>,
) {
  apiTaskCreateSchema.parse(input);
  const targetLabel = await requireTargetLabel(
    env,
    viewer,
    input.targetType,
    input.targetId,
  );
  if (input.ownerPersonId) {
    const owner = await env.DB.prepare(
      `SELECT p.display_name AS name FROM people p
        JOIN events event ON event.id = ? AND event.organisation_id = ?
        WHERE p.id = ? AND (
          EXISTS (SELECT 1 FROM memberships m
                   WHERE m.person_id = p.id AND m.event_id = event.id
                     AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL)
          OR EXISTS (SELECT 1 FROM session_speakers ss
                      WHERE ss.person_id = p.id AND ss.event_id = event.id)
        )`,
    )
      .bind(viewer.eventId, viewer.organisationId, input.ownerPersonId)
      .first<{ name: string }>();
    if (!owner)
      throw new AiToolValidationError(
        "The proposed task owner is not available in this event.",
      );
  }
  if (input.dependencyIds.length) {
    const dependencies = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM task_instances task
        JOIN events event ON event.id = task.event_id AND event.organisation_id = ?
       WHERE task.event_id = ?
         AND task.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        JSON.stringify(input.dependencyIds),
      )
      .first<{ count: number }>();
    if (Number(dependencies?.count ?? 0) !== input.dependencyIds.length) {
      throw new AiToolValidationError(
        "One or more proposed task dependencies are not available in this event.",
      );
    }
  }
  return targetLabel;
}

function assertReminderDeliveryReady(preview: CommunicationPreview) {
  if (preview.template.category !== "task_reminder") {
    throw new AiToolValidationError(
      "The selected base template is not a task-reminder template.",
    );
  }
  if (preview.template.versionStatus !== "published") {
    throw new AiToolValidationError(
      "The selected base reminder template is not published. Publish it in Communications before preparing a send.",
    );
  }
  if (!preview.provider.configured || !preview.provider.sender) {
    throw new AiToolValidationError(
      "A verified sender and configured email provider are required before preparing an assistant reminder send.",
    );
  }
  if (!preview.provider.queueConfigured) {
    throw new AiToolValidationError(
      "The OPERATIONS_QUEUE binding is required before preparing an assistant reminder send.",
    );
  }
  if (!preview.recipients.deliverable.length) {
    throw new AiToolValidationError(
      "The selected reminder audience has no deliverable recipients.",
    );
  }
}

export async function prepareReminderSendProposal(
  env: CloudflareEnvironment,
  viewer: Viewer,
  input: {
    runId: string;
    model: string;
    arguments: z.infer<typeof reminderSendProposalArgumentsSchema>;
    templateId?: string;
  },
) {
  if (!adminRoles.has(viewer.role)) throw new AiToolPermissionError();
  const args = reminderSendProposalArgumentsSchema.parse(input.arguments);
  const communications = new CommunicationService(env);
  const deliveryInput = {
    templateVersionId: args.baseTemplateVersionId,
    audienceType: args.audienceType,
    manualRecipients: "",
    kind: args.kind,
  } as const;
  const basePreview = await communications.preview(viewer, deliveryInput);
  assertReminderDeliveryReady(basePreview);

  const content = { ...basePreview.template.content, body: args.body };
  const candidateTemplate = {
    category: "task_reminder" as const,
    subject: args.subject,
    content,
  };
  assertMergeAudienceCompatible(candidateTemplate, args.audienceType);
  // Reject unknown merge variables before a durable draft version is created.
  renderMergeTemplate(args.subject, representativeMergeValues);
  renderMergeTemplate(args.body, representativeMergeValues);

  const saved = await communications.saveTemplate(viewer, {
    ...(input.templateId ? { templateId: input.templateId } : {}),
    name: `Assistant reminder · ${args.subject.slice(0, 120)}`,
    category: "task_reminder",
    subject: args.subject,
    content,
  });
  const previewInput = {
    ...deliveryInput,
    templateVersionId: saved.versionId,
  };
  const exactPreview = await communications.preview(viewer, previewInput);
  if (
    !exactPreview.provider.configured ||
    !exactPreview.provider.sender ||
    !exactPreview.provider.queueConfigured
  ) {
    throw new AiToolValidationError(
      "The configured reminder delivery boundary became unavailable while preparing the preview.",
    );
  }
  if (!exactPreview.recipients.deliverable.length) {
    throw new AiToolValidationError(
      "The selected reminder audience no longer has deliverable recipients.",
    );
  }

  const proposalId = crypto.randomUUID();
  const reminder = {
    template: {
      id: exactPreview.template.id,
      templateId: exactPreview.template.templateId,
      name: exactPreview.template.name,
      category: "task_reminder" as const,
      versionNumber: exactPreview.template.versionNumber,
      versionStatus: "draft" as const,
      subject: exactPreview.template.subject,
      content: exactPreview.template.content,
    },
    audienceType: args.audienceType,
    kind: args.kind,
    recipients: exactPreview.recipients,
    confirmation: exactPreview.confirmation,
    rendered: {
      subject: exactPreview.rendered.subject,
      text: exactPreview.rendered.text,
    },
    provider: {
      configured: true as const,
      sender: exactPreview.provider.sender,
      queueConfigured: true as const,
    },
  };
  const preview: AiProposalPreview = {
    id: proposalId,
    toolName: "propose_reminder_send",
    title: args.subject,
    summary: `Queue one ${args.kind} reminder to ${reminder.recipients.deliverable.length} deliverable ${args.audienceType.replaceAll("_", " ")} recipient${reminder.recipients.deliverable.length === 1 ? "" : "s"}.`,
    consequence:
      "Approval publishes this immutable assistant-created template version, records the exact communication and queues delivery through the normal provider operation. Sending cannot be undone. Newly suppressed recipients are skipped; any other audience change requires a fresh preview.",
    changes: [
      { field: "Subject", before: null, after: args.subject },
      {
        field: "Audience",
        before: null,
        after: `${reminder.recipients.deliverable.length} deliverable · ${reminder.recipients.suppressed.length} suppressed · ${reminder.recipients.invalid.length} invalid`,
      },
      {
        field: "Sender",
        before: null,
        after: reminder.provider.sender,
      },
      {
        field: "Delivery",
        before: null,
        after: "Queued background communication operation",
      },
    ],
    approvalRequired: true,
    reminder,
  };
  const metadata = assistantProposalMetadataSchema.parse({
    version: 1,
    toolName: "propose_reminder_send",
    runId: input.runId,
    model: input.model,
    arguments: args,
    preview,
  });
  await env.DB.prepare(
    `INSERT INTO audit_events (
      id, organisation_id, event_id, actor_person_id, action,
      entity_type, entity_id, correlation_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'assistant.proposal.previewed',
              'assistant_proposal', ?, ?, ?, unixepoch())`,
  )
    .bind(
      crypto.randomUUID(),
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      proposalId,
      input.runId,
      JSON.stringify(metadata),
    )
    .run();
  const evidence: AiEvidence[] = [
    {
      id: `communication-template-version:${saved.versionId}`,
      label: exactPreview.template.name,
      detail: `Draft reminder template version ${saved.versionNumber}`,
      href: `/admin/communications?template=${encodeURIComponent(saved.templateId)}`,
      source: "Program Cue D1",
    },
    {
      id: `reminder-audience:${args.audienceType}`,
      label: args.audienceType.replaceAll("_", " "),
      detail: `${exactPreview.recipients.deliverable.length} deliverable · ${exactPreview.recipients.suppressed.length} suppressed · ${exactPreview.recipients.invalid.length} invalid`,
      href: "/admin/communications",
      source: "Program Cue D1",
    },
  ];
  return { preview, metadata, evidence };
}

type ReminderCohort = z.infer<typeof reminderCohortSchema>;

export async function loadReminderCohort(
  env: CloudflareEnvironment,
  viewer: Viewer,
  cohort: ReminderCohort,
) {
  if (!adminRoles.has(viewer.role)) throw new AiToolPermissionError();
  const definitions: Record<
    ReminderCohort,
    { from: string; where: string; reason: string; href: string }
  > = {
    incomplete_speakers: {
      from: `people p JOIN task_instances ti
               ON ti.target_id = p.id AND ti.event_id = ?
              AND ti.target_type = 'speaker'`,
      where: "ti.status NOT IN ('completed','waived')",
      reason: "incomplete speaker tasks",
      href: "/admin/tasks?target=speaker&state=open",
    },
    overdue_speaker_tasks: {
      from: `people p JOIN task_instances ti
               ON ti.target_id = p.id AND ti.event_id = ?
              AND ti.target_type = 'speaker'`,
      where:
        "ti.status = 'overdue' OR (ti.status NOT IN ('completed','waived') AND ti.due_at IS NOT NULL AND ti.due_at < unixepoch())",
      reason: "overdue speaker tasks",
      href: "/admin/tasks?target=speaker&state=overdue",
    },
    reviewers_with_open_assignments: {
      from: `people p JOIN evaluator_assignments a
               ON a.evaluator_person_id = p.id AND a.event_id = ?`,
      where: "a.status IN ('assigned','in_progress','reopened')",
      reason: "open review assignments",
      href: "/admin/review?filter=open",
    },
  };
  const definition = definitions[cohort];
  const base = `FROM ${definition.from}
    JOIN events e ON e.id = ? AND e.organisation_id = ?
   WHERE ${definition.where}`;
  const [count, sample] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(DISTINCT p.id) AS count ${base}`)
      .bind(viewer.eventId, viewer.eventId, viewer.organisationId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT p.id, p.display_name AS name, COUNT(*) AS affected ${base}
       GROUP BY p.id, p.display_name ORDER BY affected DESC, p.display_name LIMIT 10`,
    )
      .bind(viewer.eventId, viewer.eventId, viewer.organisationId)
      .all<{ id: string; name: string; affected: number }>(),
  ]);
  return {
    cohort,
    count: Number(count?.count ?? 0),
    reason: definition.reason,
    sample: sample.results,
    href: definition.href,
  };
}

export function availableAiTools(viewer: Viewer): OpenAiFunctionTool[] {
  if (!adminRoles.has(viewer.role)) return [];
  return AI_TOOLS.map(({ class: _class, ...tool }) => tool);
}

export class AiToolExecutor {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly viewer: Viewer,
    private readonly runId: string,
    private readonly model: string,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async execute(
    name: string,
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    if (!adminRoles.has(this.viewer.role)) throw new AiToolPermissionError();
    const definition = AI_TOOLS.find((tool) => tool.name === name);
    if (!definition) {
      throw new AiToolPermissionError(
        `The selected AI provider requested the non-allow-listed tool ${name}.`,
      );
    }
    await this.airtable.assertReadable(this.viewer);
    switch (name) {
      case "get_event_readiness":
        return this.executeGetEventReadiness(encodedArguments);
      case "find_incomplete_speakers":
        return this.executeFindIncompleteSpeakers(encodedArguments);
      case "get_review_progress":
        return this.executeGetReviewProgress(encodedArguments);
      case "inspect_schedule_conflicts":
        return this.executeInspectScheduleConflicts(encodedArguments);
      case "inspect_integration_failures":
        return this.executeInspectIntegrationFailures(encodedArguments);
      case "search_submissions":
        return this.executeSearchSubmissions(encodedArguments);
      case "list_reminder_templates":
        return this.executeListReminderTemplates(encodedArguments);
      case "get_evaluation_setup":
        return this.executeGetEvaluationSetup(encodedArguments);
      case "get_schedule_workspace":
        return this.executeGetScheduleWorkspace(encodedArguments);
      case "list_form_drafts":
        return this.executeListFormDrafts(encodedArguments);
      case "get_accelevents_export_status":
        return this.executeGetAcceleventsExportStatus(encodedArguments);
      case "draft_reminder":
        return this.executeDraftReminder(encodedArguments);
      case "propose_reminder_send":
        return this.executeProposeReminderSend(encodedArguments);
      case "propose_form_draft":
        return this.executeProposeFormDraft(encodedArguments);
      case "propose_rubric_update":
        return this.executeProposeRubricUpdate(encodedArguments);
      case "propose_reviewer_assignment":
        return this.executeProposeReviewerAssignment(encodedArguments);
      case "propose_email_template_draft":
        return this.executeProposeEmailTemplateDraft(encodedArguments);
      case "propose_schedule_placement":
        return this.executeProposeSchedulePlacement(encodedArguments);
      case "propose_form_publication":
        return this.executeProposeFormPublication(encodedArguments);
      case "propose_schedule_publication":
        return this.executeProposeSchedulePublication(encodedArguments);
      case "propose_accelevents_run":
        return this.executeProposeAcceleventsRun(encodedArguments);
      case "propose_task":
        return this.executeProposeTask(encodedArguments);
    }
    throw new AiToolPermissionError(`Tool ${name} is not allow-listed.`);
  }

  private async executeGetEventReadiness(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "get_event_readiness";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const snapshot = await new ReadinessService(this.env).getCommandCentre(
      this.viewer,
    );
    const evidence: AiEvidence[] = [
      {
        id: "event-readiness",
        label: "Event readiness",
        detail: `${snapshot.readiness.percentage}% · ${snapshot.readiness.status.replaceAll("_", " ")}`,
        href: "/admin/command",
        source: "Program Cue D1",
      },
      ...snapshot.blockers.map((blocker) => ({
        id: `readiness-blocker:${blocker.key}`,
        label: blocker.label,
        detail: `${blocker.count} affected · ${blocker.detail}`,
        href: blocker.href,
        source: "Program Cue D1" as const,
      })),
    ];
    return {
      output: {
        source: "authoritative_command_centre_snapshot",
        generatedAt: new Date(snapshot.generatedAt * 1_000).toISOString(),
        readiness: snapshot.readiness,
        workflows: snapshot.workflows,
        blockers: snapshot.blockers,
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        readiness: snapshot.readiness.percentage,
        blockerCount: snapshot.blockers.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeFindIncompleteSpeakers(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "find_incomplete_speakers";

    const args = parseArguments(name, encodedArguments, boundedLimitSchema);
    const rows = await this.env.DB.prepare(
      `WITH event_speakers(person_id) AS (
         SELECT person_id FROM session_speakers WHERE event_id = ?
         UNION
         SELECT person_id FROM memberships
          WHERE event_id = ? AND role = 'speaker'
            AND accepted_at IS NOT NULL AND revoked_at IS NULL
       )
       SELECT p.id, p.display_name AS name,
              COUNT(ti.id) AS taskCount,
              COALESCE(SUM(CASE WHEN ti.status NOT IN ('completed','waived') THEN 1 ELSE 0 END), 0) AS incompleteCount,
              COALESCE(SUM(CASE WHEN ti.status = 'overdue' OR
                (ti.status NOT IN ('completed','waived') AND ti.due_at IS NOT NULL AND ti.due_at < unixepoch())
                THEN 1 ELSE 0 END), 0) AS overdueCount
         FROM event_speakers es
         JOIN people p ON p.id = es.person_id
         JOIN events e ON e.id = ? AND e.organisation_id = ?
         LEFT JOIN task_instances ti ON ti.event_id = e.id
           AND ti.target_type = 'speaker' AND ti.target_id = p.id
        GROUP BY p.id, p.display_name
       HAVING incompleteCount > 0
        ORDER BY overdueCount DESC, incompleteCount DESC, p.display_name
        LIMIT ?`,
    )
      .bind(
        this.viewer.eventId,
        this.viewer.eventId,
        this.viewer.eventId,
        this.viewer.organisationId,
        args.limit,
      )
      .all<{
        id: string;
        name: string;
        taskCount: number;
        incompleteCount: number;
        overdueCount: number;
      }>();
    const evidence = rows.results.map((speaker) => ({
      id: `speaker:${speaker.id}`,
      label: speaker.name,
      detail: `${speaker.incompleteCount} incomplete task${speaker.incompleteCount === 1 ? "" : "s"}`,
      href: `/admin/speakers?person=${encodeURIComponent(speaker.id)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: { source: "event_speaker_tasks", speakers: rows.results },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeGetReviewProgress(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "get_review_progress";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const rows = await this.env.DB.prepare(
      `SELECT r.id, r.name, r.round_number AS roundNumber, r.status,
              COUNT(a.id) AS totalAssignments,
              COALESCE(SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END), 0) AS submittedAssignments,
              COALESCE(SUM(CASE WHEN a.status IN ('assigned','in_progress','reopened') THEN 1 ELSE 0 END), 0) AS openAssignments,
              COALESCE(SUM(CASE WHEN a.status = 'recused' THEN 1 ELSE 0 END), 0) AS recusals
         FROM evaluation_rounds r
         JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
         LEFT JOIN evaluator_assignments a ON a.round_id = r.id AND a.event_id = r.event_id
        WHERE r.event_id = ?
        GROUP BY r.id, r.name, r.round_number, r.status
        ORDER BY r.round_number`,
    )
      .bind(this.viewer.organisationId, this.viewer.eventId)
      .all<{
        id: string;
        name: string;
        roundNumber: number;
        status: string;
        totalAssignments: number;
        submittedAssignments: number;
        openAssignments: number;
        recusals: number;
      }>();
    const evidence = rows.results.map((round) => ({
      id: `evaluation-round:${round.id}`,
      label: round.name,
      detail: `${round.submittedAssignments}/${round.totalAssignments} assignments submitted`,
      href: `/admin/review?round=${encodeURIComponent(round.id)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: { source: "evaluation_assignments", rounds: rows.results },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeInspectScheduleConflicts(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "inspect_schedule_conflicts";

    const args = parseArguments(name, encodedArguments, boundedLimitSchema);
    const rows = await this.env.DB.prepare(
      `SELECT c.id, c.conflict_type AS conflictType, c.severity,
              c.details_json AS detailsJson,
              primary_session.title AS primarySession,
              conflicting_session.title AS conflictingSession
         FROM schedule_conflicts c
         JOIN schedule_versions v ON v.id = c.schedule_version_id AND v.event_id = c.event_id
         JOIN events event ON event.id = c.event_id AND event.organisation_id = ?
         LEFT JOIN schedule_entries primary_entry ON primary_entry.id = c.primary_entry_id
         LEFT JOIN sessions primary_session ON primary_session.id = primary_entry.session_id
         LEFT JOIN schedule_entries conflicting_entry ON conflicting_entry.id = c.conflicting_entry_id
         LEFT JOIN sessions conflicting_session ON conflicting_session.id = conflicting_entry.session_id
        WHERE c.event_id = ? AND c.resolved_at IS NULL
        ORDER BY CASE c.severity WHEN 'blocking' THEN 0 ELSE 1 END, c.created_at DESC
        LIMIT ?`,
    )
      .bind(this.viewer.organisationId, this.viewer.eventId, args.limit)
      .all<{
        id: string;
        conflictType: string;
        severity: string;
        detailsJson: string;
        primarySession: string | null;
        conflictingSession: string | null;
      }>();
    const conflicts = rows.results.map(({ detailsJson, ...row }) => ({
      ...row,
      details: parseJson(detailsJson, `Schedule conflict ${row.id}`),
    }));
    const evidence = conflicts.map((conflict) => ({
      id: `schedule-conflict:${conflict.id}`,
      label: `${conflict.severity} ${conflict.conflictType.replaceAll("_", " ")} conflict`,
      detail:
        [conflict.primarySession, conflict.conflictingSession]
          .filter(Boolean)
          .join(" / ") || "Recorded schedule conflict",
      href: `/admin/schedule?conflict=${encodeURIComponent(conflict.id)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: {
        source: "deterministic_schedule_conflict_engine",
        conflicts,
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: conflicts.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeInspectIntegrationFailures(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "inspect_integration_failures";

    const args = parseArguments(name, encodedArguments, boundedLimitSchema);
    const rows = await this.env.DB.prepare(
      `SELECT c.id AS connectionId, c.provider,
              c.status AS connectionStatus, r.id AS runId, r.status AS runStatus,
              item.entity_type AS entityType, item.entity_id AS entityId,
              item.error_code AS errorCode, item.error_message AS errorMessage
         FROM integration_connections c
         JOIN events event ON event.id = c.event_id AND event.organisation_id = ?
         LEFT JOIN integration_runs r ON r.connection_id = c.id
           AND r.id = (SELECT latest.id FROM integration_runs latest
                        WHERE latest.connection_id = c.id
                        ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
         LEFT JOIN integration_run_items item ON item.run_id = r.id AND item.status = 'failed'
        WHERE c.event_id = ? AND (
          c.status IN ('needs_attention','failed')
          OR r.status IN ('partially_failed','failed')
        )
        ORDER BY c.updated_at DESC, item.updated_at DESC
        LIMIT ?`,
    )
      .bind(this.viewer.organisationId, this.viewer.eventId, args.limit)
      .all<{
        connectionId: string;
        provider: string;
        connectionStatus: string;
        runId: string | null;
        runStatus: string | null;
        entityType: string | null;
        entityId: string | null;
        errorCode: string | null;
        errorMessage: string | null;
      }>();
    const evidence = distinctEvidence(
      rows.results.map((failure) => ({
        id: `integration:${failure.connectionId}`,
        label: `${failure.provider} integration`,
        detail:
          failure.errorMessage?.slice(0, 300) ??
          failure.runStatus ??
          failure.connectionStatus,
        href: `/admin/integrations?connection=${encodeURIComponent(failure.connectionId)}`,
        source: "Program Cue D1" as const,
      })),
    );
    return {
      output: { source: "integration_run_history", failures: rows.results },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeSearchSubmissions(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "search_submissions";

    const args = parseArguments(name, encodedArguments, submissionSearchSchema);
    const pattern = likePattern(args.query);
    const rows = await this.env.DB.prepare(
      `SELECT s.id, s.public_reference AS reference, s.title, s.category,
              s.format, s.status
         FROM submissions s
         JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        WHERE s.event_id = ? AND (
          s.title LIKE ? ESCAPE '\\'
          OR s.public_reference LIKE ? ESCAPE '\\'
          OR COALESCE(s.category, '') LIKE ? ESCAPE '\\'
        )
        ORDER BY s.updated_at DESC, s.id
        LIMIT ?`,
    )
      .bind(
        this.viewer.organisationId,
        this.viewer.eventId,
        pattern,
        pattern,
        pattern,
        args.limit,
      )
      .all<{
        id: string;
        reference: string;
        title: string;
        category: string | null;
        format: string | null;
        status: string;
      }>();
    const evidence = rows.results.map((submission) => ({
      id: `submission:${submission.id}`,
      label: submission.title,
      detail: `${submission.reference} · ${submission.status}`,
      href: `/admin/submissions/${encodeURIComponent(submission.id)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: { source: "event_submissions", submissions: rows.results },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeListReminderTemplates(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "list_reminder_templates";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const rows = await this.env.DB.prepare(
      `SELECT version.id, version.template_id AS templateId, version.name,
              version.version_number AS versionNumber,
              version.subject_template AS subject
         FROM communication_template_versions version
         JOIN communication_templates template
           ON template.id = version.template_id
          AND template.event_id = version.event_id
         JOIN events event
           ON event.id = version.event_id AND event.organisation_id = ?
        WHERE version.event_id = ? AND version.category = 'task_reminder'
          AND version.channel = 'email' AND version.status = 'published'
          AND template.status = 'active'
        ORDER BY template.updated_at DESC, version.version_number DESC
        LIMIT 20`,
    )
      .bind(this.viewer.organisationId, this.viewer.eventId)
      .all<{
        id: string;
        templateId: string;
        name: string;
        versionNumber: number;
        subject: string;
      }>();
    const evidence = rows.results.map((template) => ({
      id: `communication-template-version:${template.id}`,
      label: template.name,
      detail: `Published task reminder v${template.versionNumber} · ${template.subject}`,
      href: `/admin/communications?template=${encodeURIComponent(template.templateId)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: {
        source: "published_communication_templates",
        templates: rows.results,
        nextStep: rows.results.length
          ? "Use one returned version ID as baseTemplateVersionId when preparing a reminder-send preview."
          : "Create and publish a task-reminder template in Communications before preparing a send.",
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeGetEvaluationSetup(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "get_evaluation_setup";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const workspace = await new EvaluationService(this.env).getAdminWorkspace(
      this.viewer,
    );
    const plan = workspace.plan
      ? {
          id: workspace.plan.id,
          name: workspace.plan.name,
          status: workspace.plan.status,
          revision: workspace.plan.revision,
          decisionRole: workspace.plan.decisionRole,
          rounds: workspace.plan.rounds.map((round) => ({
            id: round.id,
            name: round.name,
            roundNumber: round.roundNumber,
            status: round.status,
            revision: round.revision,
            criteria: round.criteria.map((criterion) => ({
              id: criterion.id,
              name: criterion.name,
              description: criterion.description,
              inputType: criterion.inputType,
              weightPercent: criterion.weightPercent,
              required: criterion.required,
              position: criterion.position,
            })),
          })),
        }
      : null;
    const targets = {
      submissions: workspace.submissions.slice(0, 100).map((submission) => ({
        id: submission.id,
        reference: submission.reference,
        title: submission.title,
        status: submission.status,
      })),
      sessions: workspace.sessions.slice(0, 100).map((session) => ({
        id: session.id,
        reference: session.reference,
        title: session.title,
        status: session.status,
      })),
    };
    const evidence: AiEvidence[] = plan
      ? plan.rounds.map((round) => ({
          id: `evaluation-round:${round.id}`,
          label: round.name,
          detail: `${round.status} · revision ${round.revision} · ${round.criteria.length} criteria`,
          href: `/admin/review?round=${encodeURIComponent(round.id)}`,
          source: "Program Cue D1" as const,
        }))
      : [];
    return {
      output: {
        source: "allow_listed_evaluation_setup",
        plan,
        evaluators: workspace.evaluators.map((evaluator) => ({
          id: evaluator.id,
          name: evaluator.name,
          role: evaluator.role,
        })),
        teams: workspace.teams.map((team) => ({
          id: team.id,
          name: team.name,
          status: team.status,
          members: team.members
            .filter((member) => member.authorised)
            .map((member) => ({
              personId: member.personId,
              name: member.name,
              role: member.role,
            })),
        })),
        targets,
        truncated: {
          submissions:
            workspace.submissions.length > targets.submissions.length,
          sessions: workspace.sessions.length > targets.sessions.length,
        },
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        roundCount: plan?.rounds.length ?? 0,
        evaluatorCount: workspace.evaluators.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeGetScheduleWorkspace(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "get_schedule_workspace";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const workspace = await new ScheduleService(this.env).getWorkspace(
      this.viewer,
    );
    const sessions = workspace.sessions.slice(0, 200).map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      durationMinutes: session.durationMinutes,
      trackId: session.trackId,
      speakerIds: session.speakerIds,
      requiredResources: session.requiredResources,
    }));
    const entries = workspace.entries.slice(0, 300).map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      roomId: entry.roomId,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      revision: entry.revision,
    }));
    const evidence: AiEvidence[] = workspace.version
      ? [
          {
            id: `schedule-version:${workspace.version.id}`,
            label: `${workspace.version.status} schedule v${workspace.version.versionNumber}`,
            detail: `Revision ${workspace.version.revision} · ${workspace.entries.length} entries`,
            href: "/admin/schedule",
            source: "Program Cue D1",
          },
        ]
      : [];
    return {
      output: {
        source: "authoritative_schedule_workspace",
        event: {
          id: workspace.event.id,
          startsAt: workspace.event.startsAt,
          endsAt: workspace.event.endsAt,
          timezone: workspace.event.timezone,
        },
        version: workspace.version,
        rooms: workspace.rooms.map((room) => ({
          id: room.id,
          name: room.name,
          capacity: room.capacity,
          resources: room.resources,
        })),
        sessions,
        entries,
        conflictCount: workspace.conflicts.length,
        truncated: {
          sessions: workspace.sessions.length > sessions.length,
          entries: workspace.entries.length > entries.length,
        },
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        sessionCount: workspace.sessions.length,
        entryCount: workspace.entries.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeListFormDrafts(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "list_form_drafts";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const rows = await this.env.DB.prepare(
      `SELECT form.id, form.name, form.status,
              form.public_slug AS publicSlug, form.revision AS formRevision,
              draft.id AS draftVersionId,
              draft.version_number AS draftVersionNumber,
              draft.revision AS draftRevision,
              json_array_length(json_extract(draft.schema_json, '$.fields')) AS fieldCount
         FROM form_definitions form
         JOIN events event
           ON event.id = form.event_id AND event.organisation_id = ?
         JOIN form_versions draft
           ON draft.form_id = form.id AND draft.event_id = form.event_id
          AND draft.status = 'draft'
        WHERE form.event_id = ? AND form.status <> 'archived'
        ORDER BY form.updated_at DESC, form.id
        LIMIT 50`,
    )
      .bind(this.viewer.organisationId, this.viewer.eventId)
      .all<{
        id: string;
        name: string;
        status: string;
        publicSlug: string;
        formRevision: number;
        draftVersionId: string;
        draftVersionNumber: number;
        draftRevision: number;
        fieldCount: number;
      }>();
    const evidence = rows.results.map((form) => ({
      id: `form:${form.id}`,
      label: form.name,
      detail: `Draft v${form.draftVersionNumber} · form revision ${form.formRevision} · draft revision ${form.draftRevision}`,
      href: "/admin/submissions/form",
      source: "Program Cue D1" as const,
    }));
    return {
      output: { source: "event_form_drafts", forms: rows.results },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeGetAcceleventsExportStatus(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "get_accelevents_export_status";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const workspace = await new IntegrationService(this.env).getWorkspace(
      this.viewer,
    );
    const evidence = workspace.connections.map((connection) => ({
      id: `integration:${connection.id}`,
      label: "Accelevents connection",
      detail: `${connection.status} · ${connection.direction}`,
      href: `/admin/integrations?connection=${encodeURIComponent(connection.id)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: {
        source: "accelevents_integration_workspace",
        connections: workspace.connections.map((connection) => ({
          id: connection.id,
          provider: connection.provider,
          status: connection.status,
          direction: connection.direction,
          hasCredentials: connection.hasCredentials,
          configuration: connection.configuration,
        })),
        recentRuns: workspace.runs.slice(0, 10).map((run) => ({
          id: run.id,
          connectionId: run.connectionId,
          operationId: run.operationId,
          status: run.status,
          dryRun: run.dryRun,
          summary: run.summary,
        })),
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        connectionCount: workspace.connections.length,
        runCount: workspace.runs.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeDraftReminder(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "draft_reminder";

    const args = parseArguments(
      name,
      encodedArguments,
      reminderDraftArgumentsSchema,
    );
    const cohort = await loadReminderCohort(this.env, this.viewer, args.cohort);
    const evidence: AiEvidence[] = [
      {
        id: `reminder-cohort:${args.cohort}`,
        label: args.cohort.replaceAll("_", " "),
        detail: `${cohort.count} recipient${cohort.count === 1 ? "" : "s"} with ${cohort.reason}`,
        href: cohort.href,
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "deterministic_recipient_cohort",
        draftOnly: true,
        sent: false,
        cohort,
        draft: { subject: args.subject, body: args.body },
        nextStep:
          "Open Communications, review exact recipients and content, then use its normal confirmation flow if sending is intended.",
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        recipientCount: cohort.count,
        sent: false,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeProposeReminderSend(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_reminder_send";

    const args = parseArguments(
      name,
      encodedArguments,
      reminderSendProposalArgumentsSchema,
    );
    const result = await prepareReminderSendProposal(this.env, this.viewer, {
      runId: this.runId,
      model: this.model,
      arguments: args,
    });
    return {
      output: {
        source: "validated_communication_preview",
        proposalId: result.preview.id,
        executed: false,
        approvalRequired: true,
        templateVersionId: result.preview.reminder.template.id,
        audience: {
          type: result.preview.reminder.audienceType,
          selected: result.preview.reminder.recipients.selected,
          deliverable: result.preview.reminder.recipients.deliverable.length,
          suppressed: result.preview.reminder.recipients.suppressed.length,
          invalid: result.preview.reminder.recipients.invalid.length,
        },
        subject: result.preview.reminder.template.subject,
        nextStep:
          "The signed-in administrator must inspect the saved exact preview and explicitly approve it in Program Cue. No communication has been sent or queued.",
      },
      evidence: result.evidence,
      proposals: [result.preview],
      auditSummary: {
        arguments: args,
        proposalId: result.preview.id,
        executed: false,
        recipientCount: result.preview.reminder.recipients.deliverable.length,
        suppressedCount: result.preview.reminder.recipients.suppressed.length,
        evidenceIds: result.evidence.map((item) => item.id),
      },
    };
  }

  private async executeProposeFormDraft(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_form_draft";

    const args = parseArguments(
      name,
      encodedArguments,
      formDraftProposalArgumentsSchema,
    );
    const submissions = new SubmissionService(this.env);
    const [defaults, existingForms] = await Promise.all([
      submissions.getDefaultFormInput(this.viewer),
      submissions.listAdminForms(this.viewer),
    ]);
    if (existingForms.some((form) => form.publicSlug === args.publicSlug)) {
      throw new AiToolValidationError(
        "A form with this public slug already exists in the current event.",
      );
    }
    const snapshot: SaveFormInput = saveFormSchema.parse({
      ...defaults,
      ...args,
    });
    const proposalId = crypto.randomUUID();
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_form_draft",
      title: snapshot.name,
      summary: `Create one editable ${snapshot.kind.replaceAll("_", " ")} form draft with ${snapshot.schema.fields.length} default fields.`,
      consequence:
        "Approval saves one D1-backed form draft through the normal submission service. It does not publish the form or accept applications.",
      changes: [
        { field: "Form", before: null, after: snapshot.name },
        { field: "Public slug", before: null, after: snapshot.publicSlug },
        {
          field: "Close date",
          before: null,
          after: snapshot.closeDate ?? "No close date",
        },
        {
          field: "Speaker limits",
          before: null,
          after: `${snapshot.minSpeakers}–${snapshot.maxSpeakers ?? "unlimited"}`,
        },
        {
          field: "Access",
          before: null,
          after: snapshot.accessMode.replaceAll("_", " "),
        },
      ],
      affectedRecords: snapshot.schema.fields.map((field) => ({
        id: `form-field:${field.id}`,
        label: field.label,
        detail: `${field.type.replaceAll("_", " ")}${field.required ? " · required" : " · optional"}`,
        href: "/admin/submissions/form",
      })),
      approvalRequired: true,
    };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_form_draft",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `event:${this.viewer.eventId}`,
        label: "Current event form configuration",
        detail: `Default ${snapshot.accessMode.replaceAll("_", " ")} access · ${snapshot.schema.fields.length} fields`,
        href: "/admin/submissions/form",
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_form_draft_preview",
        proposalId,
        executed: false,
        published: false,
        fieldCount: snapshot.schema.fields.length,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        fieldCount: snapshot.schema.fields.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeProposeRubricUpdate(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_rubric_update";

    const args = parseArguments(name, encodedArguments, draftRoundUpdateSchema);
    const workspace = await new EvaluationService(this.env).getAdminWorkspace(
      this.viewer,
    );
    const round = workspace.plan?.rounds.find(
      (candidate) => candidate.id === args.roundId,
    );
    if (!round || round.status !== "draft") {
      throw new AiToolValidationError(
        "The proposed rubric target is not a draft evaluation round in this event.",
      );
    }
    if (round.revision !== args.revision) {
      throw new AiToolValidationError(
        "The evaluation round revision changed. Inspect the current setup and prepare a fresh rubric preview.",
      );
    }
    if (
      workspace.assignments.some(
        (assignment) => assignment.roundId === round.id,
      )
    ) {
      throw new AiToolValidationError(
        "A rubric cannot be replaced after the round has assignments.",
      );
    }
    const proposalId = crypto.randomUUID();
    const scoredWeight = args.criteria
      .filter((criterion) => criterion.inputType.startsWith("scale_"))
      .reduce((total, criterion) => total + criterion.weightPercent, 0);
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_rubric_update",
      title: `${args.name} rubric`,
      summary: `Replace the editable rubric for draft round ${round.name} with ${args.criteria.length} validated criteria.`,
      consequence:
        "Approval updates only this unassigned draft round through EvaluationService CAS validation. It does not activate the round, assign reviewers, score submissions or submit reviews.",
      changes: [
        { field: "Round name", before: round.name, after: args.name },
        {
          field: "Criteria",
          before: `${round.criteria.length}`,
          after: `${args.criteria.length}`,
        },
        {
          field: "Scored weight",
          before: `${round.criteria.filter((criterion) => criterion.inputType.startsWith("scale_")).reduce((total, criterion) => total + criterion.weightPercent, 0)}%`,
          after: `${scoredWeight}%`,
        },
        {
          field: "Due date",
          before: "Current draft setting",
          after: args.dueAt ?? "No due date",
        },
      ],
      affectedRecords: args.criteria.map((criterion) => ({
        id: `criterion:${criterion.id}`,
        label: criterion.name,
        detail: `${criterion.inputType.replaceAll("_", " ")} · ${criterion.weightPercent}% · ${criterion.required ? "required" : "optional"}`,
        href: `/admin/review?round=${encodeURIComponent(round.id)}`,
      })),
      approvalRequired: true,
    };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_rubric_update",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot: args,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `evaluation-round:${round.id}`,
        label: round.name,
        detail: `Draft revision ${round.revision} · ${round.criteria.length} current criteria`,
        href: `/admin/review?round=${encodeURIComponent(round.id)}`,
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_rubric_preview",
        proposalId,
        executed: false,
        criterionCount: args.criteria.length,
        scoredWeight,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        criterionCount: args.criteria.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeProposeReviewerAssignment(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_reviewer_assignment";

    const args = parseArguments(name, encodedArguments, assignmentBatchSchema);
    const workspace = await new EvaluationService(this.env).getAdminWorkspace(
      this.viewer,
    );
    const round = workspace.plan?.rounds.find(
      (candidate) => candidate.id === args.roundId,
    );
    if (!round || round.status !== "active") {
      throw new AiToolValidationError(
        "Reviewer assignments require an active round in the current event.",
      );
    }
    const targets =
      args.targetType === "submission"
        ? workspace.submissions.filter((target) =>
            args.targetIds.includes(target.id),
          )
        : workspace.sessions.filter((target) =>
            args.targetIds.includes(target.id),
          );
    if (targets.length !== args.targetIds.length) {
      throw new AiToolValidationError(
        "One or more proposed evaluation targets are not available in this event.",
      );
    }
    let evaluators: Array<{ id: string; name: string }>;
    if (args.teamId) {
      const team = workspace.teams.find(
        (candidate) =>
          candidate.id === args.teamId && candidate.status === "active",
      );
      if (!team) {
        throw new AiToolValidationError(
          "The proposed evaluation team is not active in this event.",
        );
      }
      evaluators = team.members
        .filter((member) => member.authorised)
        .map((member) => ({ id: member.personId, name: member.name }));
    } else {
      evaluators = workspace.evaluators
        .filter((evaluator) => args.evaluatorPersonIds.includes(evaluator.id))
        .map((evaluator) => ({ id: evaluator.id, name: evaluator.name }));
    }
    const requestedEvaluatorIds = args.teamId
      ? evaluators.map((evaluator) => evaluator.id)
      : args.evaluatorPersonIds;
    if (
      evaluators.length === 0 ||
      new Set(evaluators.map((evaluator) => evaluator.id)).size !==
        new Set(requestedEvaluatorIds).size
    ) {
      throw new AiToolValidationError(
        "One or more proposed evaluators are not authorised for this event.",
      );
    }
    const requestedCount = targets.length * evaluators.length;
    const existingPairs = new Set(
      workspace.assignments
        .filter((assignment) => assignment.roundId === round.id)
        .map(
          (assignment) =>
            `${assignment.targetType}:${assignment.submissionId ?? assignment.sessionId}:${assignment.evaluatorPersonId}`,
        ),
    );
    const newCount = targets.reduce(
      (total, target) =>
        total +
        evaluators.filter(
          (evaluator) =>
            !existingPairs.has(
              `${args.targetType}:${target.id}:${evaluator.id}`,
            ),
        ).length,
      0,
    );
    const proposalId = crypto.randomUUID();
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_reviewer_assignment",
      title: `Assign ${evaluators.length} reviewer${evaluators.length === 1 ? "" : "s"} in ${round.name}`,
      summary: `Request ${requestedCount} reviewer-target pair${requestedCount === 1 ? "" : "s"}; ${newCount} are currently new and ${requestedCount - newCount} already exist.`,
      consequence:
        "Approval calls the canonical evaluation assignment service as the signed-in administrator. The service revalidates the active round, targets, memberships and team composition and offers its normal five-minute undo for newly created assignments.",
      changes: [
        {
          field: "Targets",
          before: null,
          after: `${targets.length} ${args.targetType}${targets.length === 1 ? "" : "s"}`,
        },
        {
          field: "Evaluators",
          before: null,
          after: `${evaluators.length}`,
        },
        {
          field: "New assignment pairs",
          before: null,
          after: `${newCount}`,
        },
      ],
      affectedRecords: [
        ...targets.map((target) => ({
          id: `${args.targetType}:${target.id}`,
          label: target.title,
          detail: `${args.targetType} target`,
          href: "/admin/review",
        })),
        ...evaluators.map((evaluator) => ({
          id: `evaluator:${evaluator.id}`,
          label: evaluator.name,
          detail: "Authorised evaluator",
          href: "/admin/review",
        })),
      ],
      approvalRequired: true,
    };
    const snapshot = {
      input: args,
      resolvedEvaluatorPersonIds: evaluators
        .map((evaluator) => evaluator.id)
        .sort(),
    };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_reviewer_assignment",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `evaluation-round:${round.id}`,
        label: round.name,
        detail: `Active round · ${targets.length} targets · ${evaluators.length} evaluators`,
        href: `/admin/review?round=${encodeURIComponent(round.id)}`,
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_assignment_preview",
        proposalId,
        executed: false,
        requestedAssignmentCount: requestedCount,
        currentlyNewAssignmentCount: newCount,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        requestedAssignmentCount: requestedCount,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeProposeEmailTemplateDraft(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_email_template_draft";

    const args = parseArguments(
      name,
      encodedArguments,
      emailTemplateDraftProposalArgumentsSchema,
    );
    renderMergeTemplate(args.subject, representativeMergeValues);
    renderMergeTemplate(args.body, representativeMergeValues);
    const snapshot: SaveTemplateInput = saveTemplateSchema.parse({
      name: args.name,
      category: args.category,
      subject: args.subject,
      content: {
        body: args.body,
        physicalAddress: args.physicalAddress,
        ...(args.buttonText && args.buttonUrl
          ? { buttonText: args.buttonText, buttonUrl: args.buttonUrl }
          : {}),
      },
    });
    const proposalId = crypto.randomUUID();
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_email_template_draft",
      title: snapshot.name,
      summary: `Create one editable ${snapshot.category.replaceAll("_", " ")} email template draft with the exact subject, body, footer and action shown below.`,
      consequence:
        "Approval saves a draft template through CommunicationService. It does not publish, queue, schedule, test-send or send any email.",
      changes: [
        { field: "Template", before: null, after: snapshot.name },
        { field: "Category", before: null, after: snapshot.category },
        { field: "Subject", before: null, after: snapshot.subject },
        {
          field: "Body",
          before: null,
          after: snapshot.content.body,
        },
        {
          field: "Footer",
          before: null,
          after: snapshot.content.physicalAddress,
        },
        {
          field: "Action",
          before: null,
          after: snapshot.content.buttonText
            ? `${snapshot.content.buttonText} · ${snapshot.content.buttonUrl}`
            : "No action button",
        },
      ],
      approvalRequired: true,
    };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_email_template_draft",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `event:${this.viewer.eventId}:communications`,
        label: "Current event Communications workspace",
        detail: "Template draft target",
        href: "/admin/communications",
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_email_template_draft_preview",
        proposalId,
        executed: false,
        published: false,
        sent: false,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeProposeSchedulePlacement(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_schedule_placement";

    const args = parseArguments(
      name,
      encodedArguments,
      schedulePlacementSchema,
    );
    const workspace = await new ScheduleService(this.env).getWorkspace(
      this.viewer,
    );
    if (
      !workspace.version ||
      workspace.version.id !== args.scheduleVersionId ||
      workspace.version.status !== "draft" ||
      workspace.version.revision !== args.scheduleRevision
    ) {
      throw new AiToolValidationError(
        "The proposed placement does not target the current draft schedule revision.",
      );
    }
    const session = workspace.sessions.find(
      (candidate) => candidate.id === args.sessionId,
    );
    const room = workspace.rooms.find(
      (candidate) => candidate.id === args.roomId,
    );
    if (!session || !room) {
      throw new AiToolValidationError(
        "The proposed session or room is not available in this event.",
      );
    }
    const currentEntry = workspace.entries.find(
      (entry) => entry.sessionId === session.id,
    );
    const sessionById = new Map(
      workspace.sessions.map((candidate) => [candidate.id, candidate]),
    );
    const existing: ScheduledItem[] = workspace.entries.map((entry) => {
      const scheduledSession = sessionById.get(entry.sessionId);
      if (!scheduledSession) {
        throw new Error(
          `Schedule entry ${entry.id} references an unavailable session.`,
        );
      }
      return {
        entryId: entry.id,
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        trackId: scheduledSession.trackId,
        trackExclusive: scheduledSession.trackExclusive,
        speakerIds: scheduledSession.speakerIds,
        requiredResources: scheduledSession.requiredResources,
        expectedAttendance: scheduledSession.expectedAttendance,
        title: scheduledSession.title,
      };
    });
    const conflicts = detectScheduleConflicts({
      candidate: {
        sessionId: session.id,
        roomId: room.id,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        trackId: session.trackId,
        trackExclusive: session.trackExclusive,
        speakerIds: session.speakerIds,
        requiredResources: session.requiredResources,
        expectedAttendance: session.expectedAttendance,
      },
      existing,
      rooms: workspace.rooms,
      eventStartsAt: workspace.event.startsAt,
      eventEndsAt: workspace.event.endsAt,
      eventTimezone: workspace.event.timezone,
      policies: workspace.policies,
      excludeEntryId: currentEntry?.id,
    });
    const blocking = conflicts.filter(
      (conflict) => conflict.severity === "blocking",
    );
    if (blocking.length) {
      throw new AiToolValidationError(
        `The proposed schedule placement is blocked: ${blocking.map((conflict) => conflict.message).join(" ")}`,
      );
    }
    const warnings = conflicts.filter(
      (conflict): conflict is typeof conflict & { severity: "warning" } =>
        conflict.severity === "warning",
    );
    const proposalId = crypto.randomUUID();
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_schedule_placement",
      title: `Place ${session.title}`,
      summary: `${currentEntry ? "Move" : "Place"} one session in ${room.name} from ${new Date(args.startsAt * 1_000).toISOString()} to ${new Date(args.endsAt * 1_000).toISOString()}.`,
      consequence:
        "Approval calls ScheduleService.place against the exact draft revision. The service re-runs every deterministic conflict rule, CASes the schedule/session records and returns its normal 30-second undo. This does not publish the schedule.",
      changes: [
        {
          field: "Room",
          before: currentEntry
            ? (workspace.rooms.find(
                (candidate) => candidate.id === currentEntry.roomId,
              )?.name ?? currentEntry.roomId)
            : null,
          after: room.name,
        },
        {
          field: "Starts",
          before: currentEntry
            ? new Date(currentEntry.startsAt * 1_000).toISOString()
            : null,
          after: new Date(args.startsAt * 1_000).toISOString(),
        },
        {
          field: "Ends",
          before: currentEntry
            ? new Date(currentEntry.endsAt * 1_000).toISOString()
            : null,
          after: new Date(args.endsAt * 1_000).toISOString(),
        },
        {
          field: "Warnings",
          before: null,
          after: warnings.length
            ? warnings.map((warning) => warning.message).join(" · ")
            : "No deterministic warnings",
        },
      ],
      affectedRecords: [
        {
          id: `session:${session.id}`,
          label: session.title,
          detail: `${session.durationMinutes} minutes · ${session.status}`,
          href: `/admin/schedule?session=${encodeURIComponent(session.id)}`,
        },
        {
          id: `room:${room.id}`,
          label: room.name,
          detail: `Capacity ${room.capacity}`,
          href: "/admin/schedule",
        },
      ],
      approvalRequired: true,
    };
    const snapshot = { input: args, warningConflicts: warnings };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_schedule_placement",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `schedule-version:${workspace.version.id}`,
        label: `Draft schedule v${workspace.version.versionNumber}`,
        detail: `Revision ${workspace.version.revision} · ${warnings.length} placement warnings`,
        href: `/admin/schedule?session=${encodeURIComponent(session.id)}`,
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "deterministic_schedule_placement_preview",
        proposalId,
        executed: false,
        warningCount: warnings.length,
        blockingCount: 0,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        warningCount: warnings.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeProposeFormPublication(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_form_publication";

    const args = parseArguments(
      name,
      encodedArguments,
      formPublicationProposalArgumentsSchema,
    );
    const workspace = await new SubmissionService(this.env).getAdminWorkspace(
      this.viewer,
      args.formId,
    );
    if (!workspace) {
      throw new AiToolValidationError(
        "The proposed form publication target was not found in this event.",
      );
    }
    if (
      workspace.revision !== args.formRevision ||
      workspace.draftVersion.revision !== args.draftRevision
    ) {
      throw new AiToolValidationError(
        "The form or its draft changed. Inspect current revisions and prepare a fresh publication preview.",
      );
    }
    const schemaHash = await hashJson({
      schema: workspace.draftVersion.schema,
      routing: workspace.draftVersion.routing,
      settings: workspace.draftVersion.settings,
    });
    const snapshot = {
      formId: workspace.id,
      name: workspace.name,
      publicSlug: workspace.publicSlug,
      status: workspace.status,
      formRevision: workspace.revision,
      draftRevision: workspace.draftVersion.revision,
      draftVersionId: workspace.draftVersion.id,
      fieldCount: workspace.draftVersion.schema.fields.length,
      schemaHash,
    };
    const proposalId = crypto.randomUUID();
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_form_publication",
      title: `Publish ${workspace.name}`,
      summary: `Publish draft version ${workspace.draftVersion.versionNumber} with ${snapshot.fieldCount} fields at /apply/${workspace.publicSlug}.`,
      consequence:
        "Approval makes this form draft publicly available through the normal form publication CAS boundary. Applicants may immediately see it; publication is consequential and is not treated as undoable.",
      changes: [
        {
          field: "Form status",
          before: workspace.status,
          after: "published",
        },
        {
          field: "Published version",
          before: workspace.publishedVersion
            ? `${workspace.publishedVersion.versionNumber}`
            : null,
          after: `${workspace.draftVersion.versionNumber}`,
        },
        {
          field: "Public path",
          before: workspace.publishedVersion
            ? `/apply/${workspace.publicSlug}`
            : null,
          after: `/apply/${workspace.publicSlug}`,
        },
      ],
      affectedRecords: workspace.draftVersion.schema.fields.map((field) => ({
        id: `form-field:${field.id}`,
        label: field.label,
        detail: `${field.type.replaceAll("_", " ")}${field.required ? " · required" : ""}`,
        href: "/admin/submissions/form",
      })),
      approvalRequired: true,
    };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_form_publication",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `form:${workspace.id}`,
        label: workspace.name,
        detail: `Draft version ${workspace.draftVersion.versionNumber} · revision ${workspace.draftVersion.revision}`,
        href: "/admin/submissions/form",
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_form_publication_preview",
        proposalId,
        executed: false,
        formRevision: workspace.revision,
        draftRevision: workspace.draftVersion.revision,
        fieldCount: snapshot.fieldCount,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        schemaHash,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeProposeSchedulePublication(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_schedule_publication";

    const args = parseArguments(name, encodedArguments, schedulePublishSchema);
    const workspace = await new ScheduleService(this.env).getWorkspace(
      this.viewer,
    );
    if (
      !workspace.version ||
      workspace.version.id !== args.scheduleVersionId ||
      workspace.version.status !== "draft" ||
      workspace.version.revision !== args.scheduleRevision
    ) {
      throw new AiToolValidationError(
        "The proposed publication does not target the current draft schedule revision.",
      );
    }
    const blockingConflicts = workspace.conflicts.filter(
      (conflict) => conflict.severity === "blocking",
    );
    if (blockingConflicts.length) {
      throw new AiToolValidationError(
        `The draft schedule has ${blockingConflicts.length} blocking conflict${blockingConflicts.length === 1 ? "" : "s"}. Resolve them before preparing a publication preview.`,
      );
    }
    const entriesHash = await hashJson(
      workspace.entries.map((entry) => ({
        id: entry.id,
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        revision: entry.revision,
      })),
    );
    const snapshot = {
      scheduleVersionId: workspace.version.id,
      versionNumber: workspace.version.versionNumber,
      scheduleRevision: workspace.version.revision,
      entryCount: workspace.entries.length,
      unresolvedBlockingConflicts: 0,
      entriesHash,
    };
    const proposalId = crypto.randomUUID();
    const sessionById = new Map(
      workspace.sessions.map((session) => [session.id, session]),
    );
    const roomById = new Map(workspace.rooms.map((room) => [room.id, room]));
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_schedule_publication",
      title: `Publish schedule v${workspace.version.versionNumber}`,
      summary: `Publish ${workspace.entries.length} scheduled session${workspace.entries.length === 1 ? "" : "s"} with no recorded blocking conflicts.`,
      consequence:
        "Approval re-runs all publication-boundary conflict rules and CAS revision validation, publishes the schedule, exposes public programme data and queues calendar fan-out. Published changes are not presented as undoable.",
      changes: [
        {
          field: "Schedule status",
          before: "draft",
          after: "published",
        },
        {
          field: "Published sessions",
          before: null,
          after: `${workspace.entries.length}`,
        },
        {
          field: "Blocking conflicts",
          before: "0",
          after: "Revalidated at approval",
        },
        {
          field: "Calendar fan-out",
          before: null,
          after: "Queued background operation",
        },
      ],
      affectedRecords: workspace.entries.map((entry) => ({
        id: `schedule-entry:${entry.id}`,
        label: sessionById.get(entry.sessionId)?.title ?? entry.sessionId,
        detail: `${new Date(entry.startsAt * 1_000).toISOString()} · ${roomById.get(entry.roomId)?.name ?? entry.roomId}`,
        href: `/admin/schedule?session=${encodeURIComponent(entry.sessionId)}`,
      })),
      approvalRequired: true,
    };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_schedule_publication",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `schedule-version:${workspace.version.id}`,
        label: `Draft schedule v${workspace.version.versionNumber}`,
        detail: `Revision ${workspace.version.revision} · ${workspace.entries.length} entries · no blocking conflicts`,
        href: "/admin/schedule",
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_schedule_publication_preview",
        proposalId,
        executed: false,
        entryCount: workspace.entries.length,
        blockingConflictCount: 0,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        entriesHash,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeProposeAcceleventsRun(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_accelevents_run";

    const args = parseArguments(
      name,
      encodedArguments,
      acceleventsRunProposalArgumentsSchema,
    );
    const plan = await new IntegrationService(this.env).preview(
      this.viewer,
      args.connectionId,
    );
    const planHash = await hashJson(plan.items);
    const snapshot = {
      connectionId: plan.connection.id,
      connectionStatus: plan.connection.status,
      dryRun: args.dryRun,
      summary: plan.summary,
      planHash,
      previewFingerprint: plan.previewFingerprint,
    };
    const proposalId = crypto.randomUUID();
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_accelevents_run",
      title: `${args.dryRun ? "Dry-run" : "Run"} Accelevents export`,
      summary: `${plan.summary.create} create, ${plan.summary.update} update and ${plan.summary.noop} unchanged item${plan.summary.total === 1 ? "" : "s"} in the exact current export plan.`,
      consequence: args.dryRun
        ? "Approval records a completed dry-run operation and exact item diffs. It does not call Accelevents or change external records."
        : "Approval re-runs and compares the exact export plan, durably records an idempotent integration operation and queues provider work. External effects cannot be undone; failures remain visible per record.",
      changes: [
        { field: "Creates", before: null, after: `${plan.summary.create}` },
        { field: "Updates", before: null, after: `${plan.summary.update}` },
        { field: "Unchanged", before: null, after: `${plan.summary.noop}` },
        {
          field: "Provider calls",
          before: null,
          after: args.dryRun ? "None — dry run" : "Queued after approval",
        },
      ],
      affectedRecords: plan.items.map((item) => ({
        id: `${item.entityType}:${item.entityId}`,
        label: item.label,
        detail: `${item.action}${item.externalId ? ` · external ${item.externalId}` : ""}`,
        href:
          item.entityType === "session"
            ? `/admin/schedule?session=${encodeURIComponent(item.entityId)}`
            : `/admin/speakers?person=${encodeURIComponent(item.entityId)}`,
      })),
      approvalRequired: true,
    };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_accelevents_run",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `integration:${plan.connection.id}`,
        label: "Accelevents export connection",
        detail: `${plan.connection.status} · ${plan.summary.total} planned records`,
        href: `/admin/integrations?connection=${encodeURIComponent(plan.connection.id)}`,
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_accelevents_export_preview",
        proposalId,
        executed: false,
        dryRun: args.dryRun,
        summary: plan.summary,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        planHash,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeProposeTask(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_task";

    const args = parseArguments(
      name,
      encodedArguments,
      taskProposalArgumentsSchema,
    );
    const targetLabel = await validateTaskReferences(
      this.env,
      this.viewer,
      args,
    );
    const proposalId = crypto.randomUUID();
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_task",
      title: args.title,
      summary: `Create one ${args.impact} ${args.taskType.replaceAll("_", " ")} task for ${targetLabel}.`,
      consequence:
        "Approval creates one durable task in this event. It does not send a message, publish data or create additional tasks.",
      changes: [
        { field: "Task", before: null, after: args.title },
        {
          field: "Target",
          before: null,
          after: `${args.targetType}: ${targetLabel}`,
        },
        { field: "Impact", before: null, after: args.impact },
        {
          field: "Due date",
          before: null,
          after: args.dueAt ?? "No due date",
        },
      ],
      approvalRequired: true,
    };
    const metadata = assistantProposalMetadataSchema.parse({
      version: 1,
      toolName: "propose_task",
      runId: this.runId,
      model: this.model,
      arguments: args,
      preview,
    });
    await this.env.DB.prepare(
      `INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, action,
        entity_type, entity_id, correlation_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'assistant.proposal.previewed',
                'assistant_proposal', ?, ?, ?, unixepoch())`,
    )
      .bind(
        crypto.randomUUID(),
        this.viewer.organisationId,
        this.viewer.eventId,
        this.viewer.personId,
        proposalId,
        this.runId,
        JSON.stringify(metadata),
      )
      .run();
    const evidence: AiEvidence[] = [
      {
        id: `${args.targetType}:${args.targetId}`,
        label: targetLabel,
        detail: `Proposed task target · ${args.targetType}`,
        href:
          args.targetType === "event"
            ? "/admin/command"
            : args.targetType === "session"
              ? `/admin/schedule?session=${encodeURIComponent(args.targetId)}`
              : `/admin/speakers?person=${encodeURIComponent(args.targetId)}`,
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_task_preview",
        preview,
        executed: false,
        approvalRequired: true,
      },
      evidence,
      proposals: [preview],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }
}
