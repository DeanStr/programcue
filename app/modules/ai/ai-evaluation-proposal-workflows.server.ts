import {
  assignmentBatchSchema,
  draftRoundUpdateSchema,
} from "~/modules/evaluations/evaluation-schema";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { AiFormProposalWorkflows } from "./ai-form-proposal-workflows.server";
import {
  parseArguments,
  persistDomainProposal,
} from "./ai-proposal-executor-foundation.server";
import {
  AiToolValidationError,
  type AiToolExecution,
} from "./ai-tool-execution";
import type { AiEvidence, AiProposalPreview } from "./ai-types";

export abstract class AiEvaluationProposalWorkflows extends AiFormProposalWorkflows {
  protected async executeProposeRubricUpdate(
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

  protected async executeProposeReviewerAssignment(
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
}
