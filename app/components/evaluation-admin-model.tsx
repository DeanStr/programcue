import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useContext,
  useEffect,
  useState,
} from "react";
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

type EvaluationAdminLoaderData = Awaited<ReturnType<typeof loader>>;
type EvaluationNavigation = ReturnType<typeof useNavigation>;
type EvaluationSubmission = EvaluationAdminLoaderData["submissions"][number];
type EvaluationAssignment = EvaluationAdminLoaderData["assignments"][number];
type EvaluationRound = NonNullable<
  EvaluationAdminLoaderData["plan"]
>["rounds"][number];

export type EvaluationAdminModel = {
  loaderData: EvaluationAdminLoaderData;
  actionData: EvaluationAdminActionData | undefined;
  navigation: EvaluationNavigation;
  committedWarning: boolean;
  assignmentUndo: {
    operationId: string;
    expiresAt: number;
  } | null;
  decisionId: string | null;
  setDecisionId: Dispatch<SetStateAction<string | null>>;
  noReviewOverrideConfirmed: boolean;
  setNoReviewOverrideConfirmed: Dispatch<SetStateAction<boolean>>;
  moderationSubmissionId: string | null;
  setModerationSubmissionId: Dispatch<SetStateAction<string | null>>;
  reopenAssignmentId: string | null;
  setReopenAssignmentId: Dispatch<SetStateAction<string | null>>;
  advanceOpen: boolean;
  setAdvanceOpen: Dispatch<SetStateAction<boolean>>;
  bulkAssignOpen: boolean;
  setBulkAssignOpen: Dispatch<SetStateAction<boolean>>;
  bulkAssignPreview: boolean;
  setBulkAssignPreview: Dispatch<SetStateAction<boolean>>;
  bulkAssignmentTarget: string;
  setBulkAssignmentTarget: Dispatch<SetStateAction<string>>;
  invitationRole: "evaluator" | "committee_chair";
  setInvitationRole: Dispatch<SetStateAction<"evaluator" | "committee_chair">>;
  bulkSubmissionIds: Set<string>;
  setBulkSubmissionIds: Dispatch<SetStateAction<Set<string>>>;
  selected: EvaluationSubmission | undefined;
  selectedHasCompletedReview: boolean;
  activeRound: EvaluationRound | undefined;
  nextRound: EvaluationRound | null | undefined;
  activeRoundAssignments: EvaluationAssignment[];
  sessionReviewAssignments: EvaluationAssignment[];
  unfinishedAssignmentCount: number;
  advanceableSubmissions: EvaluationSubmission[];
  assignmentTargets: Array<{
    value: string;
    label: string;
    kind: string;
  }>;
  nextRoundAssignmentTargets: Array<{
    value: string;
    label: string;
    kind: string;
  }>;
  bulkAssignableSubmissions: EvaluationSubmission[];
  bulkSelectedSubmissions: EvaluationSubmission[];
  bulkAssignmentTargetLabel: string | undefined;
  moderationSubmission: EvaluationSubmission | undefined;
  currentModeration:
    | EvaluationAdminLoaderData["moderations"][number]
    | null
    | undefined;
  reopenAssignment: EvaluationAssignment | undefined;
};

export function useEvaluationAdminState(
  loaderData: EvaluationAdminLoaderData,
): EvaluationAdminModel {
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
      (submission.reviewableInCurrentCycle ||
        submission.status === "decision_ready") &&
      activeRoundAssignments.some(
        (assignment) =>
          assignment.submissionId === submission.id &&
          (assignment.reviewStatus === "submitted" ||
            assignment.reviewStatus === "locked"),
      ),
  );
  const assignmentTargetsForRound = (round: EvaluationRound | undefined) => {
    if (!round) return [];
    const reviewerIds = new Set(
      round.reviewers.map((reviewer) => reviewer.personId),
    );
    return [
      ...loaderData.teams
        .filter((team) => team.status === "active")
        .map((team) => {
          const eligibleMemberCount = team.members.filter(
            (member) => member.authorised && reviewerIds.has(member.personId),
          ).length;
          return { team, eligibleMemberCount };
        })
        .filter(({ eligibleMemberCount }) => eligibleMemberCount > 0)
        .map(({ team, eligibleMemberCount }) => ({
          value: `team:${team.id}`,
          label: `${team.name} (${eligibleMemberCount})`,
          kind: "Teams",
        })),
      ...loaderData.evaluators
        .filter((evaluator) => reviewerIds.has(evaluator.id))
        .map((evaluator) => ({
          value: `person:${evaluator.id}`,
          label: evaluator.name,
          kind: "Individuals",
        })),
    ];
  };
  const assignmentTargets = assignmentTargetsForRound(activeRound);
  const nextRoundAssignmentTargets = assignmentTargetsForRound(
    nextRound ?? undefined,
  );
  const bulkAssignableSubmissions = loaderData.submissions.filter(
    (submission) => submission.reviewableInCurrentCycle,
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
    nextRoundAssignmentTargets,
    bulkAssignableSubmissions,
    bulkSelectedSubmissions,
    bulkAssignmentTargetLabel,
    moderationSubmission,
    currentModeration,
    reopenAssignment,
  };
}

export const EvaluationAdminModelContext =
  createContext<EvaluationAdminModel | null>(null);

export function useEvaluationAdminModel(): EvaluationAdminModel {
  const model = useContext(EvaluationAdminModelContext);
  if (!model)
    throw new Error("Evaluation administration model is unavailable.");
  return model;
}
