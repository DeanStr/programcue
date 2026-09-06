import { z } from "zod";

export const AI_ASSISTANT_PROMPT_MAX_LENGTH = 4_000;

const evidenceSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  href: z.string(),
  source: z.literal("Program Cue D1"),
});
export type AiEvidence = z.infer<typeof evidenceSchema>;
const proposalBaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  consequence: z.string(),
  changes: z.array(
    z.object({
      field: z.string(),
      before: z.string().nullable(),
      after: z.string(),
    }),
  ),
  affectedRecords: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        detail: z.string(),
        href: z.string(),
      }),
    )
    .optional(),
  approvalRequired: z.literal(true),
});
const taskProposalSchema = proposalBaseSchema.extend({
  toolName: z.literal("propose_task"),
});
const recipientSchema = z.object({
  personId: z.string().nullable(),
  address: z.string(),
  name: z.string(),
  sourceId: z.string().nullable(),
});
const reminderProposalSchema = proposalBaseSchema.extend({
  toolName: z.literal("propose_reminder_send"),
  reminder: z.object({
    template: z.object({
      id: z.string(),
      templateId: z.string(),
      name: z.string(),
      category: z.literal("task_reminder"),
      versionNumber: z.number().int(),
      versionStatus: z.literal("draft"),
      subject: z.string(),
      content: z.object({
        body: z.string(),
        physicalAddress: z.string(),
        buttonText: z.string().optional(),
        buttonUrl: z.string().optional(),
      }),
    }),
    audienceType: z.enum([
      "incomplete_speakers",
      "due_speakers",
      "overdue_speakers",
      "event_administrators",
    ]),
    kind: z.enum(["transactional", "optional"]),
    recipients: z.object({
      selected: z.number().int().nonnegative(),
      deliverable: z.array(recipientSchema),
      suppressed: z.array(recipientSchema),
      invalid: z.array(
        z.object({ address: z.string(), name: z.string(), reason: z.string() }),
      ),
    }),
    confirmation: z.object({
      recipientFingerprint: z.string(),
      deliverableFingerprint: z.string(),
      suppressedCount: z.number().int().nonnegative(),
    }),
    rendered: z.object({ subject: z.string(), text: z.string() }),
    provider: z.object({
      configured: z.literal(true),
      sender: z.string(),
      queueConfigured: z.literal(true),
    }),
  }),
});
const domainProposalSchema = proposalBaseSchema.extend({
  toolName: z.enum([
    "propose_form_draft",
    "propose_rubric_update",
    "propose_reviewer_assignment",
    "propose_email_template_draft",
    "propose_schedule_placement",
    "propose_form_publication",
    "propose_schedule_publication",
    "propose_accelevents_run",
  ]),
});
const proposalSchema = z.discriminatedUnion("toolName", [
  taskProposalSchema,
  reminderProposalSchema,
  domainProposalSchema,
]);
export type AiTaskProposalPreview = z.infer<typeof taskProposalSchema>;
export type AiReminderProposalPreview = z.infer<typeof reminderProposalSchema>;
export type AiDomainProposalPreview = z.infer<typeof domainProposalSchema>;
export type AiProposalPreview = z.infer<typeof proposalSchema>;
const attributionSchema = z.object({
  provider: z.enum(["OpenAI", "Workers AI", "Anthropic"]),
  model: z.string(),
  responseId: z.string(),
  generatedAt: z.string(),
  advisory: z.literal(true),
});
export type AiAttribution = z.infer<typeof attributionSchema>;

export type AiReadinessAdvisory = {
  generatedAt: string;
  percentage: number;
  status: "ready" | "on_track" | "at_risk" | "needs_attention";
  criticalConditionCount: number;
  warningConditionCount: number;
  summary: string;
  priorities: Array<{
    blockerKey: string;
    label: string;
    count: number;
    severity: "danger" | "warning";
    detail: string;
    href: string;
    action: string;
    rationale: string;
  }>;
  uncertainties: string[];
};

export const aiAssistantResultSchema = z.object({
  runId: z.string().min(1),
  operationId: z.string().min(1),
  answer: z.string(),
  attribution: attributionSchema,
  evidence: z.array(evidenceSchema),
  proposals: z.array(proposalSchema),
});
export type AiAssistantResult = z.infer<typeof aiAssistantResultSchema>;

export type ContextualAiResult = {
  operationId: string;
  kind:
    | "review_aid"
    | "readiness_summary"
    | "schedule_conflict_explanation"
    | "reminder_draft"
    | "session_copy";
  title: string;
  content: string;
  attribution: AiAttribution;
  evidence: AiEvidence[];
  advisory: true;
  readiness?: AiReadinessAdvisory;
  draft?: {
    subject: string;
    body: string;
  };
};
