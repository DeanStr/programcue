import { z } from "zod";

import {
  AiToolPermissionError,
  AiToolValidationError,
  type AiToolExecution,
} from "./ai-tool-execution";
import type { AiEvidence, AiProposalPreview } from "./ai-types";
import {
  acceleventsRunProposalArgumentsSchema,
  adminRoles,
  assistantProposalMetadataSchema,
  emailTemplateDraftProposalArgumentsSchema,
  formDraftProposalArgumentsSchema,
  formPublicationProposalArgumentsSchema,
  reminderSendProposalArgumentsSchema,
  taskProposalArgumentsSchema,
} from "./ai-tool-contracts.server";
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

export class AiProposalToolExecutor {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly viewer: Viewer,
    private readonly runId: string,
    private readonly model: string,
  ) {}

  execute(name: string, encodedArguments: string): Promise<AiToolExecution> {
    if (!adminRoles.has(this.viewer.role)) throw new AiToolPermissionError();
    switch (name) {
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
      default:
        throw new AiToolPermissionError(`Tool ${name} is not a proposal tool.`);
    }
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
