import { IntegrationService } from "~/modules/integrations/integration-service.server";
import {
  hashJson,
  parseArguments,
  persistDomainProposal,
  validateTaskReferences,
} from "./ai-proposal-executor-foundation.server";
import { AiScheduleProposalWorkflows } from "./ai-schedule-proposal-workflows.server";
import {
  acceleventsRunProposalArgumentsSchema,
  assistantProposalMetadataSchema,
  taskProposalArgumentsSchema,
} from "./ai-tool-contracts.server";
import { type AiToolExecution } from "./ai-tool-execution";
import type { AiEvidence, AiProposalPreview } from "./ai-types";

export abstract class AiOperationsProposalWorkflows extends AiScheduleProposalWorkflows {
  protected async executeProposeAcceleventsRun(
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

  protected async executeProposeTask(
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
        id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action,
        entity_type, entity_id, correlation_id, metadata_json, created_at
      ) VALUES (?, 'agent', 'admin_ui', 1, ?, ?, ?, 'program_cue_agent', 'assistant.proposal.previewed',
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
