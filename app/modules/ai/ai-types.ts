export const AI_ASSISTANT_PROMPT_MAX_LENGTH = 4_000;

export type AiEvidence = {
  id: string;
  label: string;
  detail: string;
  href: string;
  source: "Program Cue D1";
};

type AiProposalChange = {
  field: string;
  before: string | null;
  after: string;
};

type AiProposalBase = {
  id: string;
  title: string;
  summary: string;
  consequence: string;
  changes: AiProposalChange[];
  affectedRecords?: Array<{
    id: string;
    label: string;
    detail: string;
    href: string;
  }>;
  approvalRequired: true;
};

export type AiTaskProposalPreview = AiProposalBase & {
  toolName: "propose_task";
};

export type AiReminderProposalPreview = AiProposalBase & {
  toolName: "propose_reminder_send";
  reminder: {
    template: {
      id: string;
      templateId: string;
      name: string;
      category: "task_reminder";
      versionNumber: number;
      versionStatus: "draft";
      subject: string;
      content: {
        body: string;
        physicalAddress: string;
        buttonText?: string;
        buttonUrl?: string;
      };
    };
    audienceType:
      | "incomplete_speakers"
      | "due_speakers"
      | "overdue_speakers"
      | "event_administrators";
    kind: "transactional" | "optional";
    recipients: {
      selected: number;
      deliverable: Array<{
        personId: string | null;
        address: string;
        name: string;
        sourceId: string | null;
      }>;
      invalid: Array<{ address: string; name: string; reason: string }>;
      suppressed: Array<{
        personId: string | null;
        address: string;
        name: string;
        sourceId: string | null;
      }>;
    };
    confirmation: {
      recipientFingerprint: string;
      deliverableFingerprint: string;
      suppressedCount: number;
    };
    rendered: { subject: string; text: string };
    provider: {
      configured: true;
      sender: string;
      queueConfigured: true;
    };
  };
};

export type AiDomainProposalPreview = AiProposalBase & {
  toolName:
    | "propose_form_draft"
    | "propose_rubric_update"
    | "propose_reviewer_assignment"
    | "propose_email_template_draft"
    | "propose_schedule_placement"
    | "propose_form_publication"
    | "propose_schedule_publication"
    | "propose_accelevents_run";
};

export type AiProposalPreview =
  | AiTaskProposalPreview
  | AiReminderProposalPreview
  | AiDomainProposalPreview;

export type AiAttribution = {
  provider: "OpenAI" | "Workers AI" | "Anthropic";
  model: string;
  responseId: string;
  generatedAt: string;
  advisory: true;
};

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

export type AiAssistantResult = {
  runId: string;
  operationId: string;
  answer: string;
  attribution: AiAttribution;
  evidence: AiEvidence[];
  proposals: AiProposalPreview[];
};

export type ContextualAiResult = {
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
