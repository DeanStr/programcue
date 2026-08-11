import { z } from "zod";

import {
  AiPermissionError,
  AiProposalNotFoundError,
  AiProposalStateError,
} from "./ai-assistant-errors";
import {
  AiDomainProposalExecutor,
  type DomainProposalMetadata,
} from "./ai-domain-proposal-executor.server";
import {
  assistantProposalMetadataSchema,
  loadReminderCohort,
  prepareReminderSendProposal,
} from "./ai-tools.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ApiTaskService } from "~/platform/api/api-task-service.server";
import { AiProviderError } from "./openai-responses-provider.server";

const PROPOSAL_LIFETIME_SECONDS = 24 * 60 * 60;
const PROPOSAL_EXECUTION_LEASE_SECONDS = 5 * 60;
const identifierSchema = z.string().uuid();
const proposalExecutionResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("communication"),
    proposalId: identifierSchema,
    communicationId: z.string().min(1),
    operationId: z.string().min(1),
    title: z.string().min(1),
    href: z.string().min(1),
    replayed: z.boolean(),
  }),
  z.object({
    kind: z.literal("domain"),
    proposalId: identifierSchema,
    toolName: z.string().min(1),
    entityId: z.string().min(1),
    operationId: z.string().min(1).nullable(),
    title: z.string().min(1),
    href: z.string().min(1),
    replayed: z.boolean(),
  }),
  z.object({
    kind: z.literal("task"),
    proposalId: identifierSchema,
    taskId: z.string().min(1),
    title: z.string().min(1),
    href: z.string().min(1),
    replayed: z.boolean(),
  }),
]);

type ParsedProposalExecutionResult = z.infer<
  typeof proposalExecutionResultSchema
>;
type AssistantProposalMetadata = z.infer<
  typeof assistantProposalMetadataSchema
>;
type ReminderProposalMetadata = Extract<
  AssistantProposalMetadata,
  { toolName: "propose_reminder_send" }
>;
type TaskProposalMetadata = Extract<
  AssistantProposalMetadata,
  { toolName: "propose_task" }
>;
type ClaimedProposalInput<TMetadata extends AssistantProposalMetadata> = {
  proposalId: string;
  metadata: TMetadata;
  correlationId: string;
  claimToken: string;
  operationId: string;
};
type ProposalExecutionResult =
  | (Extract<ParsedProposalExecutionResult, { kind: "communication" }> & {
      taskId?: never;
      toolName?: never;
      entityId?: never;
    })
  | (Extract<ParsedProposalExecutionResult, { kind: "domain" }> & {
      communicationId?: never;
      taskId?: never;
    })
  | (Extract<ParsedProposalExecutionResult, { kind: "task" }> & {
      communicationId?: never;
      operationId?: never;
      toolName?: never;
      entityId?: never;
    });

export type AiProposalApprovalResult = ProposalExecutionResult;

export type AiProposalLifecycleDependencies = {
  now?: () => Date;
  beforeProposalExecutionCommit?: (
    result: AiProposalApprovalResult,
  ) => void | Promise<void>;
};

function parseJson(value: string, context: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${context} contains invalid JSON.`, { cause: error });
  }
}

function safeErrorMetadata(error: unknown) {
  if (error instanceof AiProviderError) {
    return {
      errorType: error.name,
      status: error.status,
      providerRequestId: error.providerRequestId,
      message: error.message.slice(0, 500),
    };
  }
  return {
    errorType: error instanceof Error ? error.name : "UnknownError",
    message:
      error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500),
  };
}

export class AiProposalLifecycleService {
  private readonly now: () => Date;

  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: AiProposalLifecycleDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  private assertAdmin(viewer: Viewer) {
    if (viewer.role !== "owner" && viewer.role !== "administrator") {
      throw new AiPermissionError();
    }
  }

  private async audit(
    viewer: Viewer,
    input: {
      action: string;
      entityType: string;
      entityId?: string | null;
      correlationId: string;
      metadata: Record<string, unknown>;
    },
  ) {
    await this.env.DB.prepare(
      `INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, action,
        entity_type, entity_id, correlation_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    )
      .bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        input.action,
        input.entityType,
        input.entityId ?? null,
        input.correlationId,
        JSON.stringify(input.metadata),
      )
      .run();
  }

  private replayProposalExecution(raw: string, proposalId: string) {
    const parsed = proposalExecutionResultSchema.safeParse(
      parseJson(raw, `Assistant proposal execution ${proposalId}`),
    );
    if (!parsed.success || parsed.data.proposalId !== proposalId) {
      throw new Error(
        `Assistant proposal ${proposalId} has invalid durable execution metadata.`,
      );
    }
    return { ...parsed.data, replayed: true } satisfies ProposalExecutionResult;
  }

  private async claimProposalExecution(
    viewer: Viewer,
    input: {
      proposalId: string;
      toolName: string;
      model: string;
      correlationId: string;
    },
  ): Promise<
    | { kind: "claimed"; claimToken: string }
    | { kind: "completed"; result: ProposalExecutionResult }
  > {
    const now = Math.floor(this.now().getTime() / 1_000);
    const claimToken = crypto.randomUUID();
    const approvalAuditId = `assistant-approval:${input.proposalId}`;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO assistant_proposal_executions (
           proposal_id, organisation_id, event_id, actor_person_id, tool_name,
           status, claim_token, claim_expires_at, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM events
             WHERE id = ? AND organisation_id = ?
          )`,
      ).bind(
        input.proposalId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        input.toolName,
        claimToken,
        now + PROPOSAL_EXECUTION_LEASE_SECONDS,
        now,
        now,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, execution.organisation_id, execution.event_id,
                execution.actor_person_id, 'assistant.approval.recorded',
                'assistant_proposal', execution.proposal_id, ?, ?, ?
           FROM assistant_proposal_executions execution
          WHERE execution.proposal_id = ?
            AND execution.organisation_id = ? AND execution.event_id = ?
            AND execution.actor_person_id = ? AND execution.tool_name = ?`,
      ).bind(
        approvalAuditId,
        input.correlationId,
        JSON.stringify({
          proposalId: input.proposalId,
          toolName: input.toolName,
          approved: true,
          model: input.model,
        }),
        now,
        input.proposalId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        input.toolName,
      ),
    ]);
    const load = () =>
      this.env.DB.prepare(
        `SELECT organisation_id AS organisationId, event_id AS eventId,
                actor_person_id AS actorPersonId, tool_name AS toolName,
                status, claim_token AS claimToken,
                claim_expires_at AS claimExpiresAt, result_json AS resultJson
           FROM assistant_proposal_executions
          WHERE proposal_id = ?`,
      )
        .bind(input.proposalId)
        .first<{
          organisationId: string;
          eventId: string;
          actorPersonId: string;
          toolName: string;
          status: "processing" | "completed";
          claimToken: string | null;
          claimExpiresAt: number | null;
          resultJson: string | null;
        }>();
    let row = await load();
    if (
      !row ||
      row.organisationId !== viewer.organisationId ||
      row.eventId !== viewer.eventId ||
      row.actorPersonId !== viewer.personId ||
      row.toolName !== input.toolName
    ) {
      throw new AiProposalStateError(
        "This assistant proposal cannot be executed in the current event and actor scope.",
      );
    }
    if (row.status === "completed") {
      if (!row.resultJson)
        throw new Error(
          `Completed assistant proposal ${input.proposalId} has no result.`,
        );
      return {
        kind: "completed",
        result: this.replayProposalExecution(row.resultJson, input.proposalId),
      };
    }
    if (row.claimToken === claimToken) return { kind: "claimed", claimToken };
    if ((row.claimExpiresAt ?? 0) > now) {
      throw new AiProposalStateError(
        "This assistant proposal is already executing. Retry after the current attempt finishes.",
      );
    }
    const reclaimed = await this.env.DB.prepare(
      `UPDATE assistant_proposal_executions
          SET claim_token = ?, claim_expires_at = ?, updated_at = ?
        WHERE proposal_id = ? AND organisation_id = ? AND event_id = ?
          AND actor_person_id = ? AND tool_name = ? AND status = 'processing'
          AND claim_expires_at <= ?`,
    )
      .bind(
        claimToken,
        now + PROPOSAL_EXECUTION_LEASE_SECONDS,
        now,
        input.proposalId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        input.toolName,
        now,
      )
      .run();
    if ((reclaimed.meta.changes ?? 0) === 1)
      return { kind: "claimed", claimToken };
    row = await load();
    if (row?.status === "completed" && row.resultJson) {
      return {
        kind: "completed",
        result: this.replayProposalExecution(row.resultJson, input.proposalId),
      };
    }
    throw new AiProposalStateError(
      "This assistant proposal is already executing. Retry after the current attempt finishes.",
    );
  }

  private async completeProposalExecution(
    viewer: Viewer,
    input: {
      proposalId: string;
      toolName: string;
      model: string;
      correlationId: string;
      claimToken: string;
      entityType: string;
      entityId: string;
      result: ProposalExecutionResult;
      details: Record<string, unknown>;
    },
  ) {
    const now = Math.floor(this.now().getTime() / 1_000);
    const resultJson = JSON.stringify(input.result);
    await this.dependencies.beforeProposalExecutionCommit?.(input.result);
    try {
      const [completed, audited] = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE assistant_proposal_executions
              SET status = 'completed', result_json = ?, claim_token = NULL,
                  claim_expires_at = NULL, completed_at = ?, updated_at = ?
            WHERE proposal_id = ? AND organisation_id = ? AND event_id = ?
              AND actor_person_id = ? AND tool_name = ?
              AND status = 'processing' AND claim_token = ?`,
        ).bind(
          resultJson,
          now,
          now,
          input.proposalId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          input.toolName,
          input.claimToken,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           )
           SELECT ?, execution.organisation_id, execution.event_id,
                  execution.actor_person_id, 'assistant.action.executed',
                  ?, ?, ?, ?, ?
             FROM assistant_proposal_executions execution
            WHERE execution.proposal_id = ? AND execution.status = 'completed'
              AND execution.result_json = ?`,
        ).bind(
          `assistant-execution:${input.proposalId}`,
          input.entityType,
          input.entityId,
          input.correlationId,
          JSON.stringify({
            proposalId: input.proposalId,
            toolName: input.toolName,
            model: input.model,
            result: { ...input.result, ...input.details },
          }),
          now,
          input.proposalId,
          resultJson,
        ),
      ]);
      if (
        (completed.meta.changes ?? 0) === 1 &&
        (audited.meta.changes ?? 0) === 1
      ) {
        return input.result;
      }
    } catch (error) {
      const settled = await this.env.DB.prepare(
        `SELECT result_json AS resultJson
           FROM assistant_proposal_executions
          WHERE proposal_id = ? AND organisation_id = ? AND event_id = ?
            AND actor_person_id = ? AND tool_name = ? AND status = 'completed'`,
      )
        .bind(
          input.proposalId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          input.toolName,
        )
        .first<{ resultJson: string }>();
      if (settled) {
        return this.replayProposalExecution(
          settled.resultJson,
          input.proposalId,
        );
      }
      throw error;
    }
    const settled = await this.env.DB.prepare(
      `SELECT result_json AS resultJson
         FROM assistant_proposal_executions
        WHERE proposal_id = ? AND organisation_id = ? AND event_id = ?
          AND actor_person_id = ? AND tool_name = ? AND status = 'completed'`,
    )
      .bind(
        input.proposalId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        input.toolName,
      )
      .first<{ resultJson: string }>();
    if (settled)
      return this.replayProposalExecution(settled.resultJson, input.proposalId);
    throw new AiProposalStateError(
      "The assistant proposal execution lease was lost before its result could be committed. Retry the proposal.",
    );
  }

  private async releaseProposalExecution(
    viewer: Viewer,
    proposalId: string,
    claimToken: string,
  ) {
    await this.env.DB.prepare(
      `UPDATE assistant_proposal_executions
          SET claim_expires_at = 0, updated_at = ?
        WHERE proposal_id = ? AND organisation_id = ? AND event_id = ?
          AND actor_person_id = ? AND status = 'processing'
          AND claim_token = ?`,
    )
      .bind(
        Math.floor(this.now().getTime() / 1_000),
        proposalId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        claimToken,
      )
      .run();
  }

  async approveProposal(
    viewer: Viewer,
    rawProposalId: unknown,
    confirmed: boolean,
    correlationId: string = crypto.randomUUID(),
  ): Promise<AiProposalApprovalResult> {
    this.assertAdmin(viewer);
    if (!confirmed) {
      throw new AiProposalStateError(
        "Explicit confirmation is required before an assistant proposal can execute.",
      );
    }
    const proposalId = identifierSchema.parse(rawProposalId);
    const proposal = await this.env.DB.prepare(
      `SELECT a.metadata_json AS metadataJson, a.created_at AS createdAt
         FROM audit_events a
         JOIN events event ON event.id = a.event_id AND event.organisation_id = ?
        WHERE a.event_id = ? AND a.actor_person_id = ?
          AND a.action = 'assistant.proposal.previewed'
          AND a.entity_type = 'assistant_proposal' AND a.entity_id = ?
        ORDER BY a.created_at DESC, a.id DESC LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId, proposalId)
      .first<{ metadataJson: string; createdAt: number }>();
    if (!proposal) throw new AiProposalNotFoundError();
    const metadata = assistantProposalMetadataSchema.safeParse(
      parseJson(proposal.metadataJson, `Assistant proposal ${proposalId}`),
    );
    if (!metadata.success) {
      throw new Error(
        `Assistant proposal ${proposalId} contains invalid preview metadata.`,
      );
    }
    const completedExecution = await this.env.DB.prepare(
      `SELECT result_json AS resultJson
         FROM assistant_proposal_executions
        WHERE proposal_id = ? AND organisation_id = ? AND event_id = ?
          AND actor_person_id = ? AND tool_name = ? AND status = 'completed'`,
    )
      .bind(
        proposalId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        metadata.data.toolName,
      )
      .first<{ resultJson: string }>();
    if (completedExecution) {
      return this.replayProposalExecution(
        completedExecution.resultJson,
        proposalId,
      );
    }
    if (
      proposal.createdAt <
      Math.floor(this.now().getTime() / 1_000) - PROPOSAL_LIFETIME_SECONDS
    ) {
      throw new AiProposalStateError(
        "This assistant proposal expired. Generate a fresh preview against current event data.",
      );
    }
    const superseded = await this.env.DB.prepare(
      `SELECT 1 FROM audit_events superseded
        WHERE superseded.event_id = ? AND superseded.actor_person_id = ?
          AND superseded.action = 'assistant.proposal.superseded'
          AND superseded.entity_type = 'assistant_proposal'
          AND superseded.entity_id = ?
        LIMIT 1`,
    )
      .bind(viewer.eventId, viewer.personId, proposalId)
      .first();
    if (superseded) {
      throw new AiProposalStateError(
        "This reminder preview was replaced by an edited preview. Approve the latest version instead.",
      );
    }

    const execution = await this.claimProposalExecution(viewer, {
      proposalId,
      toolName: metadata.data.toolName,
      model: metadata.data.model,
      correlationId,
    });
    if (execution.kind === "completed") return execution.result;
    const claimToken = execution.claimToken;
    const operationId = `assistant:${proposalId}`;
    try {
      return await this.executeClaimedProposal(viewer, {
        proposalId,
        metadata: metadata.data,
        correlationId,
        claimToken,
        operationId,
      });
    } catch (error) {
      try {
        await this.releaseProposalExecution(viewer, proposalId, claimToken);
      } catch {
        // The finite lease remains recoverable if D1 is temporarily unavailable.
      }
      try {
        await this.audit(viewer, {
          action: "assistant.action.failed",
          entityType: "assistant_proposal",
          entityId: proposalId,
          correlationId,
          metadata: {
            proposalId,
            toolName: metadata.data.toolName,
            model: metadata.data.model,
            ...safeErrorMetadata(error),
          },
        });
      } catch {
        // Preserve the actionable domain error; claim recovery does not depend
        // on best-effort failure telemetry.
      }
      throw error;
    }
  }

  private async executeClaimedProposal(
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
    return await this.completeProposalExecution(viewer, {
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
    return await this.completeProposalExecution(viewer, {
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
    const { proposalId, metadata, correlationId, claimToken, operationId } =
      input;
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
    return await this.completeProposalExecution(viewer, {
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

  async reviseReminderProposal(
    viewer: Viewer,
    rawProposalId: unknown,
    rawSubject: unknown,
    rawBody: unknown,
    correlationId: string = crypto.randomUUID(),
  ) {
    this.assertAdmin(viewer);
    const proposalId = identifierSchema.parse(rawProposalId);
    const subject = z.string().trim().min(3).max(200).parse(rawSubject);
    const body = z.string().trim().min(10).max(100_000).parse(rawBody);
    const proposal = await this.env.DB.prepare(
      `SELECT proposal.metadata_json AS metadataJson,
              proposal.created_at AS createdAt
         FROM audit_events proposal
         JOIN events event
           ON event.id = proposal.event_id AND event.organisation_id = ?
        WHERE proposal.event_id = ? AND proposal.actor_person_id = ?
          AND proposal.action = 'assistant.proposal.previewed'
          AND proposal.entity_type = 'assistant_proposal'
          AND proposal.entity_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM audit_events terminal
             WHERE terminal.event_id = proposal.event_id
               AND terminal.actor_person_id = proposal.actor_person_id
               AND (
                 (terminal.action = 'assistant.proposal.superseded'
                   AND terminal.entity_type = 'assistant_proposal'
                   AND terminal.entity_id = proposal.entity_id)
                 OR
                 (terminal.action = 'assistant.action.executed'
                   AND json_extract(terminal.metadata_json, '$.proposalId') = proposal.entity_id)
               )
          )
        ORDER BY proposal.created_at DESC, proposal.id DESC LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId, proposalId)
      .first<{ metadataJson: string; createdAt: number }>();
    if (!proposal) throw new AiProposalNotFoundError();
    if (
      proposal.createdAt <
      Math.floor(this.now().getTime() / 1_000) - PROPOSAL_LIFETIME_SECONDS
    ) {
      throw new AiProposalStateError(
        "This assistant proposal expired. Generate a fresh preview against current event data.",
      );
    }
    const metadata = assistantProposalMetadataSchema.safeParse(
      parseJson(proposal.metadataJson, `Assistant proposal ${proposalId}`),
    );
    if (!metadata.success) {
      throw new Error(
        `Assistant proposal ${proposalId} contains invalid preview metadata.`,
      );
    }
    if (metadata.data.toolName !== "propose_reminder_send") {
      throw new AiProposalStateError(
        "Only reminder-send previews have editable communication content.",
      );
    }
    const revised = await prepareReminderSendProposal(this.env, viewer, {
      runId: correlationId,
      model: metadata.data.model,
      templateId: metadata.data.preview.reminder.template.templateId,
      arguments: {
        ...metadata.data.arguments,
        subject,
        body,
      },
    });
    await this.audit(viewer, {
      action: "assistant.proposal.superseded",
      entityType: "assistant_proposal",
      entityId: proposalId,
      correlationId,
      metadata: {
        proposalId,
        replacementProposalId: revised.preview.id,
        toolName: metadata.data.toolName,
        subjectChanged: subject !== metadata.data.arguments.subject,
        bodyChanged: body !== metadata.data.arguments.body,
      },
    });
    return revised.preview;
  }

  async listRecentProposals(viewer: Viewer) {
    this.assertAdmin(viewer);
    const rows = await this.env.DB.prepare(
      `SELECT proposal.entity_id AS id,
              proposal.metadata_json AS metadataJson,
              proposal.created_at AS createdAt,
              executed.entity_id AS resultEntityId,
              executed.metadata_json AS resultMetadataJson
         FROM audit_events proposal
         JOIN events event ON event.id = proposal.event_id AND event.organisation_id = ?
         LEFT JOIN audit_events executed
           ON executed.id = (
             SELECT latest.id FROM audit_events latest
              WHERE latest.event_id = proposal.event_id
                AND latest.actor_person_id = proposal.actor_person_id
                AND latest.action = 'assistant.action.executed'
                AND json_extract(latest.metadata_json, '$.proposalId') = proposal.entity_id
              ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
           )
        WHERE proposal.event_id = ? AND proposal.actor_person_id = ?
          AND proposal.action = 'assistant.proposal.previewed'
          AND proposal.entity_type = 'assistant_proposal'
          AND NOT EXISTS (
            SELECT 1 FROM audit_events superseded
             WHERE superseded.event_id = proposal.event_id
               AND superseded.actor_person_id = proposal.actor_person_id
               AND superseded.action = 'assistant.proposal.superseded'
               AND superseded.entity_type = 'assistant_proposal'
               AND superseded.entity_id = proposal.entity_id
          )
        ORDER BY proposal.created_at DESC, proposal.id DESC LIMIT 10`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId)
      .all<{
        id: string;
        metadataJson: string;
        createdAt: number;
        resultEntityId: string | null;
        resultMetadataJson: string | null;
      }>();
    return rows.results.map((row) => {
      const metadata = assistantProposalMetadataSchema.safeParse(
        parseJson(row.metadataJson, `Assistant proposal ${row.id}`),
      );
      if (!metadata.success) {
        throw new Error(
          `Assistant proposal ${row.id} contains invalid preview metadata.`,
        );
      }
      const execution = row.resultMetadataJson
        ? (parseJson(
            row.resultMetadataJson,
            `Assistant proposal execution ${row.id}`,
          ) as { result?: unknown })
        : null;
      const operationId =
        execution?.result && typeof execution.result === "object"
          ? Reflect.get(execution.result, "operationId")
          : null;
      const parsedExecution = proposalExecutionResultSchema.safeParse(
        execution?.result,
      );
      return {
        ...metadata.data.preview,
        createdAt: row.createdAt,
        expired:
          row.createdAt <
          Math.floor(this.now().getTime() / 1_000) - PROPOSAL_LIFETIME_SECONDS,
        executedTaskId:
          metadata.data.toolName === "propose_task" ? row.resultEntityId : null,
        executedCommunicationId:
          metadata.data.toolName === "propose_reminder_send"
            ? row.resultEntityId
            : null,
        executedOperationId:
          typeof operationId === "string" ? operationId : null,
        executedDomainEntityId:
          metadata.data.toolName !== "propose_task" &&
          metadata.data.toolName !== "propose_reminder_send"
            ? row.resultEntityId
            : null,
        executedHref:
          parsedExecution.success && parsedExecution.data.kind === "domain"
            ? parsedExecution.data.href
            : null,
      };
    });
  }
}
