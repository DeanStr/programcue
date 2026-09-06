import type { Dispatch, RefObject, SetStateAction } from "react";
import type { FetcherWithComponents } from "react-router";
import type { DraftRecoveryController } from "~/platform/drafts/draft-recovery";
import type { loader } from "~/routes/review-workbench.server";

export type ReviewWorkbenchActionData = {
  ok?: boolean;
  error?: string;
  message?: string;
  revision?: number;
  committed?: boolean;
  conflict?: boolean;
  submittedAssignmentId?: string;
  nextAssignmentId?: string | null;
  clearedAssignmentId?: string;
};

export type ReviewWorkbenchAction = () => Promise<ReviewWorkbenchActionData>;

export type ReviewConflictChoice = "unanswered" | "affirmed" | "conflict";

export type ReviewWorkbenchLoaderData = Awaited<ReturnType<typeof loader>>;
export type ReviewWorkspace = ReviewWorkbenchLoaderData["workspace"];
export type ReviewAssignment = ReviewWorkspace["assignments"][number];

export type ReviewRecoveryPayload = {
  scores: Record<string, string>;
  recommendation: string;
  confidence: string;
  submitterFeedback: string;
  privateNotes: string;
  aiSuggestionId: string | null;
  aiImportedCriterionIds: string[];
  /* "affirmed", "conflict" or "" for unanswered. The answer lives here rather
     than in panel state because the score panel unmounts whenever the workspace
     transiently has no selection, and a declaration that disappears on a
     revalidation is worse than no declaration at all. */
  conflictAffirmed: string;
};

export function isReviewRecoveryPayload(
  value: unknown,
): value is ReviewRecoveryPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const scores = candidate.scores;
  const importedCriterionIds = candidate.aiImportedCriterionIds;
  return (
    Boolean(scores) &&
    typeof scores === "object" &&
    !Array.isArray(scores) &&
    Object.entries(scores as Record<string, unknown>).every(
      ([criterionId, score]) =>
        criterionId.length > 0 && typeof score === "string",
    ) &&
    typeof candidate.recommendation === "string" &&
    typeof candidate.confidence === "string" &&
    typeof candidate.submitterFeedback === "string" &&
    typeof candidate.privateNotes === "string" &&
    (candidate.aiSuggestionId === null ||
      typeof candidate.aiSuggestionId === "string") &&
    Array.isArray(importedCriterionIds) &&
    importedCriterionIds.every(
      (criterionId): criterionId is string =>
        typeof criterionId === "string" && criterionId.length > 0,
    ) &&
    new Set(importedCriterionIds).size === importedCriterionIds.length &&
    (candidate.conflictAffirmed === "" ||
      candidate.conflictAffirmed === "affirmed" ||
      candidate.conflictAffirmed === "conflict")
  );
}

export type ReviewWorkbenchModel = {
  viewer: ReviewWorkbenchLoaderData["viewer"];
  workspace: ReviewWorkspace;
  eventName: string;
  eventTimezone: string;
  assignmentKey: string;
  fetcher: FetcherWithComponents<ReviewWorkbenchActionData>;
  formRef: RefObject<HTMLFormElement | null>;
  saveDraftTriggerRef: RefObject<HTMLButtonElement | null>;
  submitReviewTriggerRef: RefObject<HTMLButtonElement | null>;
  submitNextTriggerRef: RefObject<HTMLButtonElement | null>;
  conflictTriggerRef: RefObject<HTMLButtonElement | null>;
  abstentionTriggerRef: RefObject<HTMLButtonElement | null>;
  editGeneration: RefObject<number>;
  inFlightSaveGeneration: RefObject<number | null>;
  conflictOpen: boolean;
  setConflictOpen: Dispatch<SetStateAction<boolean>>;
  abstentionOpen: boolean;
  setAbstentionOpen: Dispatch<SetStateAction<boolean>>;
  shortcutsOpen: boolean;
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  submitMode: "stay" | "next" | null;
  setSubmitMode: Dispatch<SetStateAction<"stay" | "next" | null>>;
  dirty: boolean;
  requiredCriterionCount: number;
  completedCriterionCount: number;
  weightedScore: number | null;
  conflictChoice: ReviewConflictChoice;
  readOnly: boolean;
  revision: number;
  committedWarning: boolean;
  saveFailed: boolean;
  selectedIndex: number;
  previousAssignment: ReviewAssignment | null;
  nextAssignment: ReviewAssignment | null;
  recoveryPayload: ReviewRecoveryPayload;
  recovery: DraftRecoveryController<ReviewRecoveryPayload>;
  suggestionImport: {
    suggestionId: string | null;
    importedCriterionIds: string[];
  };
  unchangedAiCriterionIds: string[];
  confirmedAiCriterionIds: Set<string>;
  applyReviewerAiSuggestion(): void;
  setAiCriterionConfirmed(criterionId: string, confirmed: boolean): void;
  clearAutosaveTimer(): void;
  cancelAutosave(): void;
  markDirty(criterionId?: string): void;
  captureRecoveryPayload(form: HTMLFormElement): void;
  requestAssignmentNavigation(href: string): void;
};
