import {
  type SaveTemplateInput,
  saveTemplateSchema,
} from "~/modules/communications/communication-schema";
import {
  findUnresolvedTemplateContent,
  renderMergeTemplate,
  representativeMergeValues,
  unresolvedTemplateTokenMessage,
} from "~/modules/communications/merge-template";
import {
  AiProposalExecutorFoundation,
  parseArguments,
  persistDomainProposal,
  prepareReminderSendProposal,
} from "./ai-proposal-executor-foundation.server";
import {
  emailTemplateDraftProposalArgumentsSchema,
  reminderSendProposalArgumentsSchema,
} from "./ai-tool-contracts.server";
import type { AiToolExecution } from "./ai-tool-execution";
import { AiToolValidationError } from "./ai-tool-execution";
import type { AiEvidence, AiProposalPreview } from "./ai-types";

export abstract class AiCommunicationProposalWorkflows extends AiProposalExecutorFoundation {
  protected async executeProposeReminderSend(
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

  protected async executeProposeEmailTemplateDraft(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_email_template_draft";

    const args = parseArguments(
      name,
      encodedArguments,
      emailTemplateDraftProposalArgumentsSchema,
    );
    const unresolved = findUnresolvedTemplateContent({
      subject: args.subject,
      body: args.body,
      physicalAddress: args.physicalAddress,
      buttonText: args.buttonText ?? undefined,
      buttonUrl: args.buttonUrl ?? undefined,
    });
    if (unresolved) {
      throw new AiToolValidationError(
        unresolvedTemplateTokenMessage(unresolved),
      );
    }
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
}
