import { AiProposalStateError } from "./ai-assistant-errors";
import {
  AiDomainProposalExecutor,
  type DomainProposalMetadata,
} from "./ai-domain-proposal-executor.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ApiTaskService } from "~/platform/api/api-task-service.server";
import type {
  AiProposalApprovalResult,
  AssistantProposalMetadata,
  ClaimedProposalInput,
  ProposalCompletionInput,
  ProposalExecutionResult,
  ReminderProposalMetadata,
  TaskProposalMetadata,
} from "./ai-proposal-lifecycle.server";

export class AiClaimedProposalExecutor {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly complete: (
      viewer: Viewer,
      input: ProposalCompletionInput,
    ) => Promise<AiProposalApprovalResult>,
  ) {}

  async execute(
    viewer: Viewer,
    input: ClaimedProposalInput<AssistantProposalMetadata>,
  ): Promise<AiProposalApprovalResult> {
    switch (input.metadata.toolName) {
      case "propose_reminder_send":
        return this.executeClaimedReminderProposal(viewer, {
          ...input,
          metadata: input.metadata,
        });
      case "propose_task":
        return this.executeClaimedTaskProposal(viewer, {
          ...input,
          metadata: input.metadata,
        });
      default:
        return this.executeClaimedDomainProposal(viewer, {
          ...input,
          metadata: input.metadata,
        });
    }
  }

  private async executeClaimedReminderProposal(
    viewer: Viewer,
    input: ClaimedProposalInput<ReminderProposalMetadata>,
  ): Promise<AiProposalApprovalResult> {
    const { proposalId, metadata, correlationId, claimToken, operationId } =
      input;
    const reminder = metadata.preview.reminder;
    const communications = new CommunicationService(this.env);
    const recordedCommunication = await this.env.DB.prepare(
      `SELECT communication.id
         FROM communications communication
         JOIN events event
           ON event.id = communication.event_id
          AND event.organisation_id = ?
        WHERE communication.event_id = ?
          AND communication.idempotency_key = ?`,
    )
      .bind(viewer.organisationId, viewer.eventId, operationId)
      .first();
    if (!recordedCommunication) {
      const current = await communications.preview(viewer, {
        templateVersionId: reminder.template.id,
        audienceType: reminder.audienceType,
        manualRecipients: "",
        kind: reminder.kind,
      });
      if (
        current.template.id !== reminder.template.id ||
        current.template.templateId !== reminder.template.templateId ||
        current.template.name !== reminder.template.name ||
        current.template.category !== reminder.template.category ||
        current.template.versionNumber !== reminder.template.versionNumber ||
        current.template.subject !== reminder.template.subject ||
        JSON.stringify(current.template.content) !==
          JSON.stringify(reminder.template.content)
      ) {
        throw new AiProposalStateError(
          "The reminder template changed after preview. Prepare and inspect a fresh assistant preview.",
        );
      }
      if (
        !current.provider.configured ||
        !current.provider.sender ||
        !current.provider.queueConfigured
      ) {
        throw new AiProposalStateError(
          "The verified sender, email provider or OPERATIONS_QUEUE became unavailable after preview.",
        );
      }
      if (current.provider.sender !== reminder.provider.sender) {
        throw new AiProposalStateError(
          "The verified sender changed after preview. Prepare and inspect a fresh assistant preview.",
        );
      }
      if (
        current.confirmation.recipientFingerprint !==
        reminder.confirmation.recipientFingerprint
      ) {
        throw new AiProposalStateError(
          "The reminder audience changed after preview. Prepare and inspect a fresh assistant preview.",
        );
      }
      if (
        current.confirmation.deliverableFingerprint !==
          reminder.confirmation.deliverableFingerprint &&
        current.confirmation.suppressedCount <=
          reminder.confirmation.suppressedCount
      ) {
        throw new AiProposalStateError(
          "The deliverable reminder audience changed after preview. Prepare and inspect a fresh assistant preview.",
        );
      }
      if (!current.recipients.deliverable.length) {
        throw new AiProposalStateError(
          "The reminder audience no longer contains a deliverable recipient.",
        );
      }
      await communications.publishTemplate(viewer, reminder.template.id);
    }
    const result = await communications.confirm(viewer, {
      templateVersionId: reminder.template.id,
      audienceType: reminder.audienceType,
      manualRecipients: "",
      kind: reminder.kind,
      idempotencyKey: operationId,
      ...reminder.confirmation,
    });
    if (!result.operationId) {
      throw new Error(
        "The approved reminder did not create a communication operation.",
      );
    }
    const response: ProposalExecutionResult = {
      kind: "communication",
      proposalId,
      communicationId: result.communicationId,
      operationId: result.operationId,
      title: metadata.preview.title,
      href: `/admin/operations?operation=${encodeURIComponent(result.operationId)}`,
      replayed: false,
    };
    return await this.complete(viewer, {
      proposalId,
      toolName: metadata.toolName,
      model: metadata.model,
      correlationId,
      claimToken,
      entityType: "communication",
      entityId: result.communicationId,
      result: response,
      details: {
        status: result.status,
        downstreamDuplicate: result.duplicate,
      },
    });
  }

  private async executeClaimedDomainProposal(
    viewer: Viewer,
    input: ClaimedProposalInput<DomainProposalMetadata>,
  ): Promise<AiProposalApprovalResult> {
    const { proposalId, metadata, correlationId, claimToken, operationId } =
      input;
    const executed = await new AiDomainProposalExecutor(this.env).execute(
      viewer,
      { proposalId, metadata, operationId },
    );
    const response: ProposalExecutionResult = {
      kind: "domain",
      proposalId,
      toolName: metadata.toolName,
      entityId: executed.entityId,
      operationId: executed.operationId,
      title: executed.title,
      href: executed.href,
      replayed: false,
    };
    return await this.complete(viewer, {
      proposalId,
      toolName: metadata.toolName,
      model: metadata.model,
      correlationId,
      claimToken,
      entityType: executed.entityType,
      entityId: executed.entityId,
      result: response,
      details: executed.details,
    });
  }

  private async executeClaimedTaskProposal(
    viewer: Viewer,
    input: ClaimedProposalInput<TaskProposalMetadata>,
  ): Promise<AiProposalApprovalResult> {
    const { proposalId, metadata, correlationId, claimToken } = input;
    const result = await new ApiTaskService(this.env).create(
      {
        keyId: `assistant:${viewer.personId}`,
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        scopes: new Set(["tasks:write"]),
      },
      metadata.arguments,
      correlationId,
      `assistant:${proposalId}`,
    );
    const response: ProposalExecutionResult = {
      kind: "task",
      proposalId,
      taskId: result.task.id,
      title: result.task.title,
      href: `/admin/tasks?task=${encodeURIComponent(result.task.id)}`,
      replayed: false,
    };
    return await this.complete(viewer, {
      proposalId,
      toolName: metadata.toolName,
      model: metadata.model,
      correlationId,
      claimToken,
      entityType: "task_instance",
      entityId: result.task.id,
      result: response,
      details: {
        changeSequence: result.changeSequence,
      },
    });
  }
}
