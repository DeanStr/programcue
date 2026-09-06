import { createContext, useContext, useMemo, useRef, useState } from "react";
import { calculateRubricWeightedScore } from "~/modules/evaluations/evaluation-rules";
import type {
  ReviewConflictChoice,
  ReviewWorkbenchLoaderData,
  ReviewWorkbenchModel,
} from "./review-workbench-contract";
import { useReviewWorkbenchDraft } from "./review-workbench-draft";
import { useReviewWorkbenchShortcuts } from "./review-workbench-shortcuts";

export type {
  ReviewConflictChoice,
  ReviewRecoveryPayload,
  ReviewWorkbenchModel,
} from "./review-workbench-contract";
export {
  reviewCanAdoptServerPayload,
  reviewSaveCoversCurrentEdits,
} from "./review-workbench-draft";
export type ReviewWorkbenchWorkspaceProps = {
  loaderData: ReviewWorkbenchLoaderData;
};
export function useReviewWorkbenchState({
  loaderData,
}: ReviewWorkbenchWorkspaceProps): ReviewWorkbenchModel {
  const { viewer, eventName, eventTimezone, workspace } = loaderData;
  const assignmentKey = workspace.selected?.id ?? "no-assignment";
  const draft = useReviewWorkbenchDraft(loaderData);
  const { recoveryPayload, readOnly, requestAssignmentNavigation, formRef } =
    draft;
  const saveDraftTriggerRef = useRef<HTMLButtonElement>(null);
  const submitReviewTriggerRef = useRef<HTMLButtonElement>(null);
  const submitNextTriggerRef = useRef<HTMLButtonElement>(null);
  const conflictTriggerRef = useRef<HTMLButtonElement>(null);
  const abstentionTriggerRef = useRef<HTMLButtonElement>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const requiredCriterionCount = workspace.criteria.filter(
    (criterion) => criterion.required,
  ).length;
  const selectedIndex = workspace.assignments.findIndex(
    (assignment) => assignment.id === workspace.selected?.id,
  );
  const previousAssignment =
    selectedIndex > 0 ? workspace.assignments[selectedIndex - 1] : null;
  const nextAssignment =
    selectedIndex >= 0 && selectedIndex < workspace.assignments.length - 1
      ? workspace.assignments[selectedIndex + 1]
      : null;
  /* The recovery payload already mirrors every score the reviewer has entered,
     on the server copy, on a restore and on every edit. A second copy of the
     same values only existed to count them, and two states for one fact drift. */
  const completedCriterionCount = workspace.criteria.filter(
    (criterion) =>
      criterion.required &&
      (recoveryPayload.scores[criterion.id] ?? "").trim() !== "",
  ).length;
  const scaledCriteria = useMemo(
    () =>
      workspace.criteria
        .filter(
          (criterion) =>
            criterion.inputType === "scale_5" ||
            criterion.inputType === "scale_10",
        )
        .map((criterion) => ({
          id: criterion.id,
          weightPercent: criterion.weightPercent,
          inputType: criterion.inputType as "scale_5" | "scale_10",
        })),
    [workspace.criteria],
  );
  /* The same rule the action applies on submit, so the number on the panel is
     the number the round will store. It has no answer until every scaled
     criterion holds a whole score, and a partial total would be a figure the
     reviewer could act on that no review ever records. */
  const weightedScore = useMemo(() => {
    try {
      return calculateRubricWeightedScore(
        scaledCriteria,
        recoveryPayload.scores,
      );
    } catch {
      return null;
    }
  }, [scaledCriteria, recoveryPayload.scores]);
  const conflictChoice: ReviewConflictChoice =
    recoveryPayload.conflictAffirmed === "affirmed"
      ? "affirmed"
      : recoveryPayload.conflictAffirmed === "conflict"
        ? "conflict"
        : "unanswered";
  useReviewWorkbenchShortcuts({
    previousAssignment,
    nextAssignment,
    readOnly,
    requestAssignmentNavigation,
    formRef,
    submitNextTriggerRef,
    saveDraftTriggerRef,
    setShortcutsOpen,
    assignmentKey,
  });
  return {
    ...draft,
    viewer,
    workspace,
    eventName,
    eventTimezone,
    assignmentKey,
    saveDraftTriggerRef,
    submitReviewTriggerRef,
    submitNextTriggerRef,
    conflictTriggerRef,
    abstentionTriggerRef,
    shortcutsOpen,
    setShortcutsOpen,
    requiredCriterionCount,
    completedCriterionCount,
    weightedScore,
    conflictChoice,
    selectedIndex,
    previousAssignment,
    nextAssignment,
  };
}
export const ReviewWorkbenchModelContext =
  createContext<ReviewWorkbenchModel | null>(null);

export function useReviewWorkbenchModel(): ReviewWorkbenchModel {
  const model = useContext(ReviewWorkbenchModelContext);
  if (!model) throw new Error("Review workbench model is unavailable.");
  return model;
}
