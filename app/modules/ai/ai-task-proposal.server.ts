import type { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { validateTaskReferences } from "./ai-proposal-executor-foundation.server";
import {
  type ReadinessTaskContext,
  readinessTaskContextSchema,
  revalidateReadinessTask,
} from "./ai-readiness-task.server";
import {
  assistantProposalMetadataSchema,
  taskProposalArgumentsSchema,
} from "./ai-tool-contracts.server";
import { AiToolValidationError } from "./ai-tool-execution";
import type { AiTaskProposalPreview } from "./ai-types";

export async function prepareTaskProposal(
  env: CloudflareEnvironment,
  viewer: Viewer,
  input: {
    runId: string;
    model: string;
    arguments: z.infer<typeof taskProposalArgumentsSchema>;
    readinessContext?: ReadinessTaskContext;
  },
) {
  const args = taskProposalArgumentsSchema.parse(input.arguments);
  let context = input.readinessContext;
  if (!context && args.readinessBlockerKey) {
    const observed = await env.DB.prepare(
      `SELECT metadata_json AS metadataJson FROM audit_events WHERE organisation_id = ? AND event_id = ? AND actor_person_id = ? AND entity_id = ? AND action = 'assistant.tool.completed' AND json_extract(metadata_json, '$.toolName') = 'get_event_readiness' ORDER BY CAST(json_extract(metadata_json, '$.toolSequence') AS INTEGER) DESC, created_at DESC, id DESC LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId, input.runId)
      .first<{ metadataJson: string }>();
    if (observed) {
      const snapshot = JSON.parse(observed.metadataJson).snapshot;
      context = snapshot?.recommendedAction
        ? readinessTaskContextSchema.parse(snapshot.recommendedAction)
        : undefined;
      if (!context)
        throw new AiToolValidationError(
          "No evidenced readiness action is available. Answer without proposing a task.",
        );
    }
  }
  if (args.readinessBlockerKey && !context)
    throw new AiToolValidationError(
      "Read current event readiness before proposing readiness work.",
    );
  if (context) {
    if (args.readinessBlockerKey !== context.blockerKey || !context.sufficient)
      throw new AiToolValidationError(
        "The task must reference the inspected readiness blocker and sufficient supporting evidence.",
      );
    if (context.records.every((record) => record.covered))
      throw new AiToolValidationError(
        "This blocker already has recorded work. Link and resolve the existing tasks instead of creating another task.",
      );
    if (args.targetType !== "event" || args.targetId !== viewer.eventId)
      throw new AiToolValidationError(
        "Readiness coordination tasks must target the current event. Copy the readiness taskTarget fields exactly.",
      );
    if (args.taskType !== "administrator_only")
      throw new AiToolValidationError(
        "Readiness coordination tasks require administrator-only access.",
      );
    if (
      !context.eligibleOwners.some(
        (owner) => owner.personId === args.ownerPersonId,
      )
    )
      throw new AiToolValidationError(
        "Readiness coordination requires an eligible named organiser. Copy an eligibleOwners personId as ownerPersonId.",
      );
    await revalidateReadinessTask(env, viewer, context);
    if (!args.description?.trim())
      throw new AiToolValidationError(
        "Explain the distinct coordination action and its evidence before proposing a readiness task.",
      );
  }
  const { targetLabel, ownerLabel } = await validateTaskReferences(
    env,
    viewer,
    args,
  );
  const preview: AiTaskProposalPreview = {
    id: crypto.randomUUID(),
    toolName: "propose_task",
    title: args.title,
    summary: `Create one ${args.impact} ${args.taskType.replaceAll("_", " ")} task for ${targetLabel}.`,
    consequence: context
      ? "Approval creates one durable task. It does not resolve the blocker, send a message or publish data. Readiness evidence is checked again before creation."
      : "Approval creates one durable task in this event. It does not send a message, publish data or create additional tasks.",
    changes: [
      { field: "Task", before: null, after: args.title },
      {
        field: "Description",
        before: null,
        after: args.description ?? "No description",
      },
      {
        field: "Target",
        before: null,
        after: `${args.targetType}: ${targetLabel}`,
      },
      {
        field: "Owner",
        before: null,
        after: ownerLabel ?? "Unassigned",
      },
      { field: "Impact", before: null, after: args.impact },
      { field: "Due date", before: null, after: args.dueAt ?? "No due date" },
    ],
    affectedRecords: context?.records
      .filter((record) => !record.covered)
      .map(({ id, label, detail, href }) => ({
        id,
        label,
        detail,
        href,
      })),
    task: args,
    eligibleOwners: context?.eligibleOwners,
    approvalRequired: true,
  };
  const metadata = assistantProposalMetadataSchema.parse({
    version: 1,
    toolName: "propose_task",
    runId: input.runId,
    model: input.model,
    arguments: args,
    readinessContext: context,
    preview,
  });
  if (metadata.toolName !== "propose_task")
    throw new Error("Invalid task proposal metadata.");
  return { metadata, targetLabel };
}

export function taskProposalStatement(
  env: CloudflareEnvironment,
  viewer: Viewer,
  metadata: Awaited<ReturnType<typeof prepareTaskProposal>>["metadata"],
) {
  return env.DB.prepare(
    `INSERT INTO audit_events (id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at) VALUES (?, 'agent', 'admin_ui', 1, ?, ?, ?, 'program_cue_agent', 'assistant.proposal.previewed', 'assistant_proposal', ?, ?, ?, unixepoch())`,
  ).bind(
    crypto.randomUUID(),
    viewer.organisationId,
    viewer.eventId,
    viewer.personId,
    metadata.preview.id,
    metadata.runId,
    JSON.stringify(metadata),
  );
}
