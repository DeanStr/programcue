import { createContext, useContext, useEffect, useState } from "react";
import { useActionData, useNavigation } from "react-router";

import type { loader } from "~/routes/evaluation-admin.server";

type EvaluationAdminActionData = {
  ok?: boolean;
  committed?: boolean;
  error?: string;
  message?: string;
  undoOperationId?: string | null;
  undoExpiresAt?: number | null;
};

export function useEvaluationAdminState(
  loaderData: Awaited<ReturnType<typeof loader>>,
) {
  const actionData = useActionData() as EvaluationAdminActionData | undefined;
  const navigation = useNavigation();
  useEffect(() => {
    if (!loaderData.focusedRoundId) return;
    const target = document.getElementById(
      `evaluation-round-${loaderData.focusedRoundId}`,
    );
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  }, [loaderData.focusedRoundId]);
  const committedWarning = Boolean(
    actionData && "committed" in actionData && actionData.committed === true,
  );
  const assignmentUndo =
    actionData &&
    "undoOperationId" in actionData &&
    actionData.undoOperationId &&
    actionData.undoExpiresAt
      ? {
          operationId: actionData.undoOperationId,
          expiresAt: actionData.undoExpiresAt,
        }
      : null;
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [noReviewOverrideConfirmed, setNoReviewOverrideConfirmed] =
    useState(false);
  const [moderationSubmissionId, setModerationSubmissionId] = useState<
    string | null
  >(null);
  const [reopenAssignmentId, setReopenAssignmentId] = useState<string | null>(
    null,
  );
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkAssignPreview, setBulkAssignPreview] = useState(false);
  const [bulkAssignmentTarget, setBulkAssignmentTarget] = useState("");
  const [invitationRole, setInvitationRole] = useState<
    "evaluator" | "committee_chair"
  >("evaluator");
  const [bulkSubmissionIds, setBulkSubmissionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const selected = loaderData.submissions.find(
    (submission) => submission.id === decisionId,
  );
  const selectedHasCompletedReview = selected
    ? loaderData.assignments.some(
        (assignment) =>
          assignment.submissionId === selected.id &&
          (assignment.reviewStatus === "submitted" ||
            assignment.reviewStatus === "locked"),
      )
    : false;
  const activeRound = loaderData.plan?.rounds.find(
    (round) => round.status === "active",
  );
  const nextRound = activeRound
    ? loaderData.plan?.rounds.find(
        (round) =>
          round.status === "draft" &&
          round.roundNumber === activeRound.roundNumber + 1,
      )
    : null;
  const activeRoundAssignments = activeRound
    ? loaderData.assignments.filter(
        (assignment) => assignment.roundId === activeRound.id,
      )
    : [];
  const sessionReviewAssignments = activeRoundAssignments.filter(
    (assignment) => assignment.targetType === "session",
  );
  const unfinishedAssignmentCount = activeRoundAssignments.filter(
    (assignment) =>
      assignment.status === "assigned" ||
      assignment.status === "in_progress" ||
      assignment.status === "reopened",
  ).length;
  const advanceableSubmissions = loaderData.submissions.filter(
    (submission) =>
      ["assigned", "in_review", "decision_ready"].includes(submission.status) &&
      activeRoundAssignments.some(
        (assignment) =>
          assignment.submissionId === submission.id &&
          (assignment.reviewStatus === "submitted" ||
            assignment.reviewStatus === "locked"),
      ),
  );
  const assignmentTargets = [
    ...loaderData.teams
      .filter(
        (team) => team.status === "active" && team.eligibleMemberCount > 0,
      )
      .map((team) => ({
        value: `team:${team.id}`,
        label: `${team.name} (${team.eligibleMemberCount})`,
        kind: "Teams",
      })),
    ...loaderData.evaluators.map((evaluator) => ({
      value: `person:${evaluator.id}`,
      label: evaluator.name,
      kind: "Individuals",
    })),
  ];
  const bulkAssignableSubmissions = loaderData.submissions.filter(
    (submission) =>
      ["submitted", "assigned", "in_review"].includes(submission.status),
  );
  const bulkSelectedSubmissions = bulkAssignableSubmissions.filter(
    (submission) => bulkSubmissionIds.has(submission.id),
  );
  const bulkAssignmentTargetLabel = assignmentTargets.find(
    (target) => target.value === bulkAssignmentTarget,
  )?.label;
  const moderationSubmission = loaderData.submissions.find(
    (submission) => submission.id === moderationSubmissionId,
  );
  const currentModeration = activeRound
    ? loaderData.moderations.find(
        (moderation) =>
          moderation.roundId === activeRound.id &&
          moderation.submissionId === moderationSubmissionId,
      )
    : null;
  const reopenAssignment = loaderData.assignments.find(
    (assignment) => assignment.id === reopenAssignmentId,
  );
  return {
    loaderData,
    actionData,
    navigation,
    committedWarning,
    assignmentUndo,
    decisionId,
    setDecisionId,
    noReviewOverrideConfirmed,
    setNoReviewOverrideConfirmed,
    moderationSubmissionId,
    setModerationSubmissionId,
    reopenAssignmentId,
    setReopenAssignmentId,
    advanceOpen,
    setAdvanceOpen,
    bulkAssignOpen,
    setBulkAssignOpen,
    bulkAssignPreview,
    setBulkAssignPreview,
    bulkAssignmentTarget,
    setBulkAssignmentTarget,
    invitationRole,
    setInvitationRole,
    bulkSubmissionIds,
    setBulkSubmissionIds,
    selected,
    selectedHasCompletedReview,
    activeRound,
    nextRound,
    activeRoundAssignments,
    sessionReviewAssignments,
    unfinishedAssignmentCount,
    advanceableSubmissions,
    assignmentTargets,
    bulkAssignableSubmissions,
    bulkSelectedSubmissions,
    bulkAssignmentTargetLabel,
    moderationSubmission,
    currentModeration,
    reopenAssignment,
  };
}

export const EvaluationAdminModelContext = createContext<ReturnType<
  typeof useEvaluationAdminState
> | null>(null);

export function useEvaluationAdminModel() {
  const model = useContext(EvaluationAdminModelContext);
  if (!model)
    throw new Error("Evaluation administration model is unavailable.");
  return model;
}
