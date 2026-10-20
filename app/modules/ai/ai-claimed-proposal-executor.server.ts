import { CommunicationService } from "~/modules/communications/communication-service.server";
import { ApiError } from "~/platform/api/api.server";
import { ApiTaskService } from "~/platform/api/api-task-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { AiProposalStateError } from "./ai-assistant-errors";
import {
  AiDomainProposalExecutor,
  type DomainProposalMetadata,
} from "./ai-domain-proposal-executor.server";
import type {
  AiProposalApprovalResult,
  AssistantProposalMetadata,
  ClaimedProposalInput,
  ProposalCompletionInput,
  ProposalExecutionResult,
  ReminderProposalMetadata,
  TaskProposalMetadata,
} from "./ai-proposal-lifecycle.server";
import {
  AiReadinessChangedError,
  revalidateReadinessTask,
} from "./ai-readiness-task.server";

export class AiClaimedProposalExecutor {
  private readonly started = performance.now();
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly complete: (
      viewer: Viewer,
      input: ProposalCompletionInput,
    ) => Promise<AiProposalApprovalResult>,
    private readonly beforeMutation: () => Promise<void>,
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
      await this.beforeMutation();
      await communications.publishTemplate(viewer, reminder.template.id);
    }
    await this.beforeMutation();
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
    const executed = await new AiDomainProposalExecutor(
      this.env,
      this.beforeMutation,
    ).execute(viewer, { proposalId, metadata, operationId });
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

  private async supersedeStaleTaskProposal(
    viewer: Viewer,
    input: ClaimedProposalInput<TaskProposalMetadata>,
    reason: string,
  ) {
    await this.env.DB.prepare(`INSERT INTO audit_events (id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at)
      SELECT ?, 'agent', 'admin_ui', 1, execution.organisation_id, execution.event_id, execution.actor_person_id, 'program_cue_agent', 'assistant.proposal.superseded', 'assistant_proposal', execution.proposal_id, ?, ?, unixepoch()
      FROM assistant_proposal_executions execution WHERE execution.proposal_id = ? AND execution.organisation_id = ? AND execution.event_id = ? AND execution.actor_person_id = ? AND execution.status = 'processing' AND execution.claim_token = ? AND execution.claim_expires_at > unixepoch()
        AND NOT EXISTS (SELECT 1 FROM audit_events prior WHERE prior.organisation_id = execution.organisation_id AND prior.event_id = execution.event_id AND prior.entity_id = execution.proposal_id AND prior.action = 'assistant.proposal.superseded')`)
      .bind(
        crypto.randomUUID(),
        input.metadata.runId,
        JSON.stringify({
          proposalId: input.proposalId,
          runId: input.metadata.runId,
          decision: "stale",
          reason,
        }),
        input.proposalId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        input.claimToken,
      )
      .run();
  }

  private async executeClaimedTaskProposal(
    viewer: Viewer,
    input: ClaimedProposalInput<TaskProposalMetadata>,
  ): Promise<AiProposalApprovalResult> {
    const { proposalId, metadata, correlationId, claimToken } = input;
    let expectedEventCursor: number | undefined;
    if (metadata.readinessContext) {
      const alreadyCreated = await this.env.DB.prepare(
        `SELECT 1 FROM idempotency_records WHERE organisation_id = ? AND event_id = ? AND actor_id = ? AND scope = 'task.create' AND idempotency_key = ? AND status = 'completed' AND expires_at > unixepoch()`,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          `api_key:assistant:${viewer.personId}`,
          `assistant:${proposalId}`,
        )
        .first();
      if (!alreadyCreated) {
        try {
          expectedEventCursor = await revalidateReadinessTask(
            this.env,
            viewer,
            metadata.readinessContext,
          );
        } catch (error) {
          if (error instanceof AiReadinessChangedError)
            await this.supersedeStaleTaskProposal(viewer, input, error.message);
          throw error;
        }
      }
    }
    const { readinessBlockerKey: _readinessBlockerKey, ...taskArguments } =
      metadata.arguments;
    await this.beforeMutation();
    const result = await (async () => {
      try {
        return await new ApiTaskService(this.env).create(
          {
            keyId: `assistant:${viewer.personId}`,
            organisationId: viewer.organisationId,
            eventId: viewer.eventId,
            scopes: new Set(["tasks:write"]),
          },
          taskArguments,
          correlationId,
          `assistant:${proposalId}`,
          expectedEventCursor === undefined
            ? undefined
            : { eventCursor: expectedEventCursor },
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          if (
            metadata.readinessContext &&
            error.code === "TASK_REFERENCE_CONFLICT"
          )
            await this.supersedeStaleTaskProposal(viewer, input, error.message);
          throw new AiProposalStateError(error.message);
        }
        throw error;
      }
    })();
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
        executionDurationMs: Math.round(performance.now() - this.started),
      },
    });
  }
}
