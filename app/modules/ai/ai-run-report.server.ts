import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { AiPermissionError } from "./ai-assistant-errors";
import { proposalExecutionResultSchema } from "./ai-proposal-lifecycle.server";
import { assistantProposalMetadataSchema } from "./ai-tool-contracts.server";
import { aiAssistantResultSchema } from "./ai-types";

const providerSchema = z.enum(["OpenAI", "Workers AI", "Anthropic"]);
const nonemptyString = z.string().trim().min(1);
const tokenTotal = z.number().int().nonnegative().nullable();
const measurementsSchema = z
  .object({
    durationMs: z.number().nonnegative(),
    configuration: z.object({ demonstrationOnly: z.boolean() }).passthrough(),
    totals: z.object({
      callCount: z.number().int().nonnegative(),
      inputTokens: tokenTotal,
      outputTokens: tokenTotal,
      totalTokens: tokenTotal,
      estimatedCostUsd: z.number().nonnegative().nullable(),
      knownEstimatedCostUsd: z.number().nonnegative(),
      callsWithUnknownCost: z.number().int().nonnegative(),
    }),
  })
  .passthrough();
const payloadSchema = z.object({
  provider: providerSchema,
  model: nonemptyString,
  requestLabel: nonemptyString,
});
const resultSchema = z
  .object({
    provider: providerSchema,
    model: nonemptyString,
    answer: nonemptyString,
    evidence: aiAssistantResultSchema.shape.evidence,
    measurements: measurementsSchema,
  })
  .passthrough();
const storedRunSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    payload: payloadSchema,
    result: resultSchema,
  }),
  z.object({
    status: z.enum(["running", "failed", "cancelled"]),
    payload: payloadSchema,
    result: resultSchema.partial().nullable(),
  }),
]);
const executionSchema = proposalExecutionResultSchema.and(
  z.object({ executionDurationMs: z.number().nonnegative().optional() }),
);

export async function listAssistantRunReports(
  env: CloudflareEnvironment,
  viewer: Viewer,
) {
  if (viewer.role !== "owner" && viewer.role !== "administrator")
    throw new AiPermissionError();
  // Historical operation summaries and retention-redacted records are not reports.
  const runs = await env.DB.prepare(
    `SELECT job.id, job.status, job.payload_json AS payloadJson,
            job.result_json AS resultJson, job.started_at AS startedAt,
            job.completed_at AS completedAt, event.timezone AS timeZone
       FROM operation_jobs job
       JOIN events event ON event.id = job.event_id
        AND event.organisation_id = job.organisation_id
      WHERE job.organisation_id = ? AND job.event_id = ?
        AND job.requested_by_person_id = ? AND job.type = 'ai.assistant.run'
        AND json_extract(job.payload_json, '$.reportUnavailableReason') IS NOT 'predates_retained_reports'
        AND NOT (
          event.participant_retention_completed_at IS NOT NULL
          AND json_extract(job.payload_json, '$.redacted') IS 1
          AND json_extract(job.payload_json, '$.reason') IS 'event_retention_period_elapsed'
        )
      ORDER BY job.created_at DESC, job.id DESC LIMIT 10`,
  )
    .bind(viewer.organisationId, viewer.eventId, viewer.personId)
    .all<{
      id: string;
      status: string;
      payloadJson: string;
      resultJson: string | null;
      startedAt: number;
      completedAt: number | null;
      timeZone: string;
    }>();
  if (!runs.results.length) return [];
  const createdTasks = await env.DB.prepare(
    `SELECT preview.entity_id AS proposalId, task.id AS taskId
       FROM audit_events preview
       JOIN idempotency_records command
         ON command.organisation_id = preview.organisation_id
        AND command.event_id = preview.event_id
        AND command.actor_id = 'api_key:assistant:' || preview.actor_person_id
        AND command.scope = 'task.create'
        AND command.idempotency_key = 'assistant:' || preview.entity_id
        AND command.status = 'completed' AND command.entity_type = 'task_instance'
       JOIN task_instances task ON task.id = command.entity_id AND task.event_id = command.event_id
      WHERE preview.organisation_id = ? AND preview.event_id = ? AND preview.actor_person_id = ?
        AND preview.action = 'assistant.proposal.previewed'
        AND json_extract(preview.metadata_json, '$.toolName') = 'propose_task'
        AND json_extract(preview.metadata_json, '$.runId') IN (SELECT value FROM json_each(?))`,
  )
    .bind(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      JSON.stringify(runs.results.map((run) => run.id)),
    )
    .all<{ proposalId: string; taskId: string }>();
  const taskIds = new Map(
    createdTasks.results.map((task) => [task.proposalId, task.taskId]),
  );
  return Promise.all(
    runs.results.map(async (run) => {
      const stored = storedRunSchema.safeParse({
        status: run.status,
        payload: JSON.parse(run.payloadJson),
        result: run.resultJson === null ? null : JSON.parse(run.resultJson),
      });
      if (!stored.success)
        throw new Error(
          `Assistant run ${run.id} contains invalid stored report data.`,
          { cause: stored.error },
        );
      const { payload, result } = stored.data;
      const audits = await env.DB.prepare(
        `SELECT action, entity_id AS entityId, created_at AS createdAt, metadata_json AS metadataJson FROM audit_events WHERE organisation_id = ? AND event_id = ? AND actor_person_id = ? AND (correlation_id = ? OR entity_id IN (SELECT entity_id FROM audit_events WHERE organisation_id = ? AND event_id = ? AND actor_person_id = ? AND action = 'assistant.proposal.previewed' AND json_extract(metadata_json, '$.runId') = ?) OR json_extract(metadata_json, '$.proposalId') IN (SELECT entity_id FROM audit_events WHERE organisation_id = ? AND event_id = ? AND actor_person_id = ? AND action = 'assistant.proposal.previewed' AND json_extract(metadata_json, '$.runId') = ?)) ORDER BY created_at, id`,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          run.id,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          run.id,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          run.id,
        )
        .all<{
          action: string;
          entityId: string | null;
          createdAt: number;
          metadataJson: string;
        }>();
      const history = audits.results.map((audit) => ({
        action: audit.action,
        entityId: audit.entityId,
        createdAt: audit.createdAt,
        details: JSON.parse(audit.metadataJson),
      }));
      const proposals = history
        .filter((item) => item.action === "assistant.proposal.previewed")
        .map((item) => {
          const preview = assistantProposalMetadataSchema.safeParse(
            item.details,
          );
          if (!preview.success || item.entityId !== preview.data.preview.id)
            throw new Error(
              `Assistant run ${run.id} contains invalid stored proposal metadata.`,
            );
          const id = preview.data.preview.id;
          const approved = history.find(
            (entry) =>
              entry.action === "assistant.approval.recorded" &&
              entry.entityId === id,
          );
          const reviewed = history.find(
            (entry) =>
              entry.action === "assistant.proposal.superseded" &&
              entry.entityId === id,
          );
          const executed = history.find(
            (entry) =>
              entry.action === "assistant.action.executed" &&
              entry.details.proposalId === id,
          );
          const failure = [...history]
            .reverse()
            .find(
              (entry) =>
                entry.action === "assistant.action.failed" &&
                entry.details.proposalId === id,
            );
          const createdTaskId = taskIds.get(id);
          const execution = executed
            ? executionSchema.parse(executed.details.result)
            : null;
          const taskId =
            execution?.kind === "task" ? execution.taskId : createdTaskId;
          const expired =
            item.createdAt < Math.floor(Date.now() / 1000) - 86400;
          const outcome =
            executed || createdTaskId
              ? taskId
                ? "Task created"
                : "Action recorded"
              : reviewed
                ? reviewed.details.decision === "reject"
                  ? "Rejected"
                  : reviewed.details.decision === "stale"
                    ? "Needs a fresh preview"
                    : "Replaced"
                : expired
                  ? "Preview expired"
                  : failure
                    ? "Action failed"
                    : approved
                      ? "Approval recorded"
                      : "Awaiting approval";
          return {
            id,
            title: preview.data.preview.title,
            outcome,
            review:
              reviewed?.details.decision ??
              (reviewed
                ? "superseded"
                : approved
                  ? "approved"
                  : "awaiting review"),
            reviewWaitSeconds: approved
              ? Math.max(0, approved.createdAt - item.createdAt)
              : null,
            execution:
              executed || createdTaskId
                ? "completed"
                : failure
                  ? "failed"
                  : "not executed",
            settlement: executed
              ? "completed"
              : createdTaskId
                ? "pending"
                : null,
            taskId,
            executionDurationMs: execution?.executionDurationMs,
            failure:
              executed || createdTaskId || !failure
                ? undefined
                : z.string().parse(failure.details.message),
          };
        });
      const currentProposal = proposals.find(
        (proposal) => proposal.outcome !== "Replaced",
      );
      return {
        runId: run.id,
        requestLabel: payload.requestLabel,
        outcome:
          currentProposal?.outcome ??
          (run.status === "completed"
            ? "Answered"
            : run.status === "running"
              ? "Preparing response"
              : run.status === "cancelled"
                ? "Cancelled"
                : "Could not complete response"),
        // Only unfinished/unsuccessful runs may lack these fields.
        answer: result?.answer ?? null,
        evidence: result?.evidence ?? [],
        demonstrationOnly:
          result?.measurements?.configuration?.demonstrationOnly === true,
        proposals,
        status: run.status,
        provider: payload.provider,
        model: result?.model ?? payload.model,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        timeZone: run.timeZone,
        measurements: result?.measurements,
        result,
        history,
      };
    }),
  );
}

export type AssistantRunReport = Awaited<
  ReturnType<typeof listAssistantRunReports>
>[number];
