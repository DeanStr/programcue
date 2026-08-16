import {
  createContext,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type FetcherWithComponents,
  useFetcher,
  useNavigate,
} from "react-router";

import { calculateRubricWeightedScore } from "~/modules/evaluations/evaluation-rules";
import { buildUnansweredReviewerAiImport } from "~/modules/evaluations/reviewer-ai-import";
import {
  clearDraftRecoveryScope,
  type DraftRecoveryController,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";
import type { loader } from "~/routes/review-workbench.server";

type ReviewWorkbenchActionData = {
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

type ReviewWorkbenchAction = () => Promise<ReviewWorkbenchActionData>;

export type ReviewConflictChoice = "unanswered" | "affirmed" | "conflict";

type ReviewWorkbenchLoaderData = Awaited<ReturnType<typeof loader>>;
type ReviewWorkspace = ReviewWorkbenchLoaderData["workspace"];
type ReviewAssignment = ReviewWorkspace["assignments"][number];

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

function isReviewRecoveryPayload(
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
  editGeneration: RefObject<number>;
  inFlightSaveGeneration: RefObject<number | null>;
  conflictOpen: boolean;
  setConflictOpen: Dispatch<SetStateAction<boolean>>;
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

/* Every scale renders as a radio group, so the group — not one control — is
   the scoring unit the keyboard drives. Marked in the DOM because the shortcut
   handler runs at the document, above the component that renders the rubric. */
const SCALE_GROUP_SELECTOR = "[data-review-scale]";

// A dialog owns the keyboard while it is open: a shortcut firing behind a modal
// edits a record the reviewer cannot see.
function reviewDialogIsOpen() {
  return Boolean(
    document.querySelector("[role='dialog'],[role='alertdialog']"),
  );
}

function reviewTargetIsTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  // Radios are the scoring control itself, so digits have to reach them.
  return target instanceof HTMLInputElement && target.type !== "radio";
}

/* A digit lands on the group focus is in; with focus outside the rubric it
   fills the first unscored group and moves on, so 4-4-3-5 typed blind scores
   the rubric top to bottom. */
function scoreRubricFromDigit(form: HTMLFormElement, digit: number) {
  const groups = Array.from(
    form.querySelectorAll<HTMLElement>(SCALE_GROUP_SELECTOR),
  );
  if (!groups.length) return false;
  const unscored = groups.filter(
    (group) => !group.querySelector("input:checked:not([value=''])"),
  );
  const focused = groups.find(
    (group) =>
      document.activeElement instanceof Node &&
      group.contains(document.activeElement),
  );
  const target = focused ?? unscored[0] ?? groups[0];
  const option =
    target.querySelectorAll<HTMLInputElement>(
      "input[type='radio']:not([value=''])",
    )[digit - 1] ?? null;
  if (!option || option.disabled) return false;
  option.click();
  const next = unscored.find(
    (group) =>
      group !== target && !group.querySelector("input:checked:not([value=''])"),
  );
  (
    next?.querySelector<HTMLInputElement>(
      "input[type='radio']:not(:disabled)",
    ) ?? option
  ).focus();
  return true;
}

export function reviewSaveCoversCurrentEdits(
  savedEditGeneration: number | null,
  currentEditGeneration: number,
) {
  return (
    savedEditGeneration !== null &&
    savedEditGeneration === currentEditGeneration
  );
}

export function reviewCanAdoptServerPayload(
  currentEditGeneration: number,
  serverSyncedEditGeneration: number,
) {
  return currentEditGeneration === serverSyncedEditGeneration;
}
export type ReviewWorkbenchWorkspaceProps = {
  loaderData: ReviewWorkbenchLoaderData;
};

export function useReviewWorkbenchState({
  loaderData,
}: ReviewWorkbenchWorkspaceProps): ReviewWorkbenchModel {
  const { viewer, eventName, eventTimezone, workspace } = loaderData;
  const assignmentKey = workspace.selected?.id ?? "no-assignment";
  const fetcher = useFetcher<ReviewWorkbenchAction>({
    key: `review-workbench:${assignmentKey}`,
  });
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const saveDraftTriggerRef = useRef<HTMLButtonElement>(null);
  const submitReviewTriggerRef = useRef<HTMLButtonElement>(null);
  const submitNextTriggerRef = useRef<HTMLButtonElement>(null);
  const conflictTriggerRef = useRef<HTMLButtonElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editGeneration = useRef(0);
  const serverSyncedEditGeneration = useRef(0);
  const inFlightSaveGeneration = useRef<number | null>(null);
  const recoveryAssignmentKey = useRef(assignmentKey);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [submitMode, setSubmitMode] = useState<"stay" | "next" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [pendingNavigation, setPendingNavigation] = useState<{
    href: string;
    sawSaveInFlight: boolean;
  } | null>(null);
  const requiredCriterionCount = workspace.criteria.filter(
    (criterion) => criterion.required,
  ).length;
  const readOnly = workspace.selected?.status === "submitted";
  const revision =
    fetcher.data &&
    "revision" in fetcher.data &&
    typeof fetcher.data.revision === "number"
      ? fetcher.data.revision
      : (workspace.review?.revision ?? 0);
  const committedWarning = Boolean(
    fetcher.data &&
      "committed" in fetcher.data &&
      fetcher.data.committed === true,
  );
  const saveFailed = Boolean(
    fetcher.data &&
      !committedWarning &&
      ("error" in fetcher.data || ("ok" in fetcher.data && !fetcher.data.ok)),
  );
  const selectedIndex = workspace.assignments.findIndex(
    (assignment) => assignment.id === workspace.selected?.id,
  );
  const previousAssignment =
    selectedIndex > 0 ? workspace.assignments[selectedIndex - 1] : null;
  const nextAssignment =
    selectedIndex >= 0 && selectedIndex < workspace.assignments.length - 1
      ? workspace.assignments[selectedIndex + 1]
      : null;
  const handledSubmission = useRef<string | null>(null);
  const serverRecoveryPayload = useMemo<ReviewRecoveryPayload>(
    () => ({
      scores: Object.fromEntries(
        workspace.criteria.map((criterion) => {
          const value = workspace.review?.scores[criterion.id];
          return [
            criterion.id,
            typeof value === "boolean"
              ? value
                ? "yes"
                : "no"
              : String(value ?? ""),
          ];
        }),
      ),
      recommendation: workspace.review?.recommendation ?? "",
      confidence: String(workspace.review?.confidence ?? ""),
      submitterFeedback: workspace.review?.submitterFeedback ?? "",
      privateNotes: workspace.review?.privateNotes ?? "",
      aiSuggestionId: workspace.review?.aiSuggestionId ?? null,
      aiImportedCriterionIds: workspace.review?.importedCriterionIds ?? [],
      conflictAffirmed: workspace.review?.conflictAffirmedAt ? "affirmed" : "",
    }),
    [workspace.criteria, workspace.review],
  );
  const [recoveryPayload, setRecoveryPayload] = useState(serverRecoveryPayload);
  const [suggestionImport, setSuggestionImport] = useState(() => ({
    suggestionId: workspace.review?.aiSuggestionId ?? null,
    importedCriterionIds: workspace.review?.importedCriterionIds ?? [],
  }));
  const [confirmedAiCriterionIds, setConfirmedAiCriterionIds] = useState<
    Set<string>
  >(() => new Set(workspace.review?.confirmedAiCriterionIds ?? []));
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
  const reviewerSuggestion = workspace.reviewerAiSuggestion;
  const suggestionByCriterionId = new Map(
    reviewerSuggestion?.suggestions.map((suggestion) => [
      suggestion.criterionId,
      suggestion,
    ]) ?? [],
  );
  const unchangedAiCriterionIds = suggestionImport.suggestionId
    ? suggestionImport.importedCriterionIds.filter((criterionId) => {
        const suggestion = suggestionByCriterionId.get(criterionId);
        return (
          suggestion?.suggestedValue !== null &&
          String(recoveryPayload.scores[criterionId] ?? "") ===
            suggestion?.suggestedValue
        );
      })
    : [];
  const restoreReview = useCallback((payload: ReviewRecoveryPayload) => {
    const form = formRef.current;
    if (!form) return;
    const setValue = (name: string, value: string) => {
      const control = form.elements.namedItem(name);
      if (
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement ||
        control instanceof HTMLTextAreaElement
      ) {
        control.value = value;
        return;
      }
      // A scale is a radio group, and its value setter only ever checks a
      // matching sibling. An unanswered criterion has no sibling to match, so
      // it has to be cleared explicitly or the recovered draft keeps whatever
      // the server copy had checked.
      if (
        typeof RadioNodeList !== "undefined" &&
        control instanceof RadioNodeList
      ) {
        if (value === "") {
          for (const option of Array.from(control))
            if (option instanceof HTMLInputElement) option.checked = false;
          return;
        }
        control.value = value;
      }
    };
    for (const [criterionId, value] of Object.entries(payload.scores))
      setValue(`score:${criterionId}`, value);
    setValue("recommendation", payload.recommendation);
    setValue("confidence", payload.confidence);
    setValue("submitterFeedback", payload.submitterFeedback);
    setValue("privateNotes", payload.privateNotes);
    setValue("conflictAffirmed", payload.conflictAffirmed);
    setSuggestionImport({
      suggestionId: payload.aiSuggestionId,
      importedCriterionIds: payload.aiImportedCriterionIds,
    });
    setConfirmedAiCriterionIds(new Set());
    setRecoveryPayload(payload);
    setDirty(true);
    editGeneration.current += 1;
    setEditVersion((current) => current + 1);
  }, []);
  const recovery = useDraftRecovery({
    scope: workspace.selected
      ? {
          eventId: viewer.eventId,
          personId: viewer.personId,
          recordType: "review",
          recordId: workspace.selected.id,
        }
      : null,
    serverRevision: revision,
    payload: recoveryPayload,
    dirty,
    onRestore: restoreReview,
    isPayloadCompatible: isReviewRecoveryPayload,
    enabled: Boolean(workspace.selected && !readOnly),
  });
  const selectedAssignmentId = workspace.selected?.id ?? null;
  const clearAutosaveTimer = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
  }, []);
  const cancelAutosave = useCallback(() => {
    clearAutosaveTimer();
    setDirty(false);
  }, [clearAutosaveTimer]);
  const flushAutosave = useCallback(() => {
    if (!dirty || saveFailed || fetcher.state !== "idle" || !formRef.current)
      return false;
    const values = new FormData(formRef.current);
    values.set("intent", "save");
    values.set("revision", String(revision));
    inFlightSaveGeneration.current = editGeneration.current;
    cancelAutosave();
    void fetcher.submit(values, { method: "post" });
    return true;
  }, [
    cancelAutosave,
    dirty,
    fetcher.state,
    fetcher.submit,
    revision,
    saveFailed,
  ]);
  useEffect(() => {
    if (!readOnly || !selectedAssignmentId) return;
    void clearDraftRecoveryScope({
      eventId: viewer.eventId,
      personId: viewer.personId,
      recordType: "review",
      recordId: selectedAssignmentId,
    });
  }, [readOnly, selectedAssignmentId, viewer.eventId, viewer.personId]);
  const handledSavedRevision = useRef<number | null>(null);
  const handledConflict = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each edit generation deliberately restarts the autosave timer even though the generation value is not submitted.
  useEffect(() => {
    if (
      readOnly ||
      conflictOpen ||
      submitMode !== null ||
      saveFailed ||
      !dirty ||
      fetcher.state !== "idle"
    )
      return;
    if (!formRef.current) return;
    saveTimer.current = setTimeout(() => {
      if (!formRef.current) return;
      const values = new FormData(formRef.current);
      values.set("intent", "save");
      values.set("revision", String(revision));
      inFlightSaveGeneration.current = editGeneration.current;
      setDirty(false);
      void fetcher.submit(values, { method: "post" });
    }, 1_000);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
  }, [
    conflictOpen,
    dirty,
    editVersion,
    fetcher,
    fetcher.state,
    readOnly,
    revision,
    saveFailed,
    submitMode,
  ]);
  useEffect(() => {
    if (saveFailed && !readOnly) setDirty(true);
  }, [readOnly, saveFailed]);
  useEffect(() => {
    if (!pendingNavigation) return;
    if (fetcher.state !== "idle") {
      if (!pendingNavigation.sawSaveInFlight) {
        setPendingNavigation((current) =>
          current ? { ...current, sawSaveInFlight: true } : null,
        );
      }
      return;
    }
    if (!pendingNavigation.sawSaveInFlight) return;
    if (saveFailed) {
      setPendingNavigation(null);
      return;
    }
    if (dirty) {
      const started = flushAutosave();
      if (started) {
        setPendingNavigation((current) =>
          current ? { ...current, sawSaveInFlight: false } : null,
        );
      }
      return;
    }
    const href = pendingNavigation.href;
    setPendingNavigation(null);
    void navigate(href);
  }, [
    dirty,
    fetcher.state,
    flushAutosave,
    navigate,
    pendingNavigation,
    saveFailed,
  ]);
  useEffect(() => {
    if (
      fetcher.state !== "idle" ||
      !fetcher.data ||
      !("submittedAssignmentId" in fetcher.data) ||
      !fetcher.data.submittedAssignmentId ||
      handledSubmission.current === fetcher.data.submittedAssignmentId
    ) {
      return;
    }
    handledSubmission.current = fetcher.data.submittedAssignmentId;
    if ("nextAssignmentId" in fetcher.data && fetcher.data.nextAssignmentId) {
      void navigate(
        `/review/workbench?assignment=${fetcher.data.nextAssignmentId}`,
      );
    }
  }, [fetcher.data, fetcher.state, navigate]);
  useEffect(() => {
    if (recoveryAssignmentKey.current !== assignmentKey) {
      recoveryAssignmentKey.current = assignmentKey;
      editGeneration.current = 0;
      serverSyncedEditGeneration.current = 0;
      inFlightSaveGeneration.current = null;
      handledSavedRevision.current = null;
      setDirty(false);
      setRecoveryPayload(serverRecoveryPayload);
      setSuggestionImport({
        suggestionId: workspace.review?.aiSuggestionId ?? null,
        importedCriterionIds: workspace.review?.importedCriterionIds ?? [],
      });
      setConfirmedAiCriterionIds(
        new Set(workspace.review?.confirmedAiCriterionIds ?? []),
      );
      return;
    }
    if (
      reviewCanAdoptServerPayload(
        editGeneration.current,
        serverSyncedEditGeneration.current,
      )
    ) {
      setRecoveryPayload(serverRecoveryPayload);
      setSuggestionImport({
        suggestionId: workspace.review?.aiSuggestionId ?? null,
        importedCriterionIds: workspace.review?.importedCriterionIds ?? [],
      });
    }
  }, [
    assignmentKey,
    serverRecoveryPayload,
    workspace.review?.aiSuggestionId,
    workspace.review?.confirmedAiCriterionIds,
    workspace.review?.importedCriterionIds,
  ]);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (
      "clearedAssignmentId" in fetcher.data &&
      typeof fetcher.data.clearedAssignmentId === "string" &&
      fetcher.data.clearedAssignmentId === workspace.selected?.id &&
      handledConflict.current !== fetcher.data.clearedAssignmentId
    ) {
      handledConflict.current = fetcher.data.clearedAssignmentId;
      void recovery
        .clear()
        .finally(() => navigate("/review/workbench", { replace: true }));
      return;
    }
    if (
      "revision" in fetcher.data &&
      typeof fetcher.data.revision === "number" &&
      !saveFailed &&
      handledSavedRevision.current !== fetcher.data.revision
    ) {
      handledSavedRevision.current = fetcher.data.revision;
      const savedEditGeneration = inFlightSaveGeneration.current;
      inFlightSaveGeneration.current = null;
      if (
        reviewSaveCoversCurrentEdits(
          savedEditGeneration,
          editGeneration.current,
        )
      ) {
        serverSyncedEditGeneration.current = editGeneration.current;
        void recovery.markServerSaved();
      }
    } else if (saveFailed) {
      inFlightSaveGeneration.current = null;
    }
  }, [
    fetcher.data,
    fetcher.state,
    navigate,
    recovery.clear,
    recovery.markServerSaved,
    saveFailed,
    workspace.selected?.id,
  ]);
  function markDirty(criterionId?: string) {
    if (saveFailed) fetcher.reset();
    if (criterionId) {
      setConfirmedAiCriterionIds((current) => {
        if (!current.has(criterionId)) return current;
        const next = new Set(current);
        next.delete(criterionId);
        return next;
      });
    }
    editGeneration.current += 1;
    setDirty(true);
    setEditVersion((current) => current + 1);
  }
  function applyReviewerAiSuggestion() {
    if (!reviewerSuggestion || readOnly) return;
    const imported = buildUnansweredReviewerAiImport(
      recoveryPayload.scores,
      reviewerSuggestion.suggestions,
    );
    if (!imported.importedCriterionIds.length) return;
    restoreReview({
      ...recoveryPayload,
      scores: imported.scores,
      aiSuggestionId: reviewerSuggestion.id,
      aiImportedCriterionIds: imported.importedCriterionIds,
    });
  }
  function setAiCriterionConfirmed(criterionId: string, confirmed: boolean) {
    setConfirmedAiCriterionIds((current) => {
      const next = new Set(current);
      if (confirmed) next.add(criterionId);
      else next.delete(criterionId);
      return next;
    });
  }
  function captureRecoveryPayload(form: HTMLFormElement) {
    const values = new FormData(form);
    setRecoveryPayload({
      scores: Object.fromEntries(
        workspace.criteria.map((criterion) => [
          criterion.id,
          String(values.get(`score:${criterion.id}`) ?? ""),
        ]),
      ),
      recommendation: String(values.get("recommendation") ?? ""),
      confidence: String(values.get("confidence") ?? ""),
      submitterFeedback: String(values.get("submitterFeedback") ?? ""),
      privateNotes: String(values.get("privateNotes") ?? ""),
      aiSuggestionId: suggestionImport.suggestionId,
      aiImportedCriterionIds: suggestionImport.importedCriterionIds,
      conflictAffirmed: String(values.get("conflictAffirmed") ?? ""),
    });
  }
  function requestAssignmentNavigation(href: string) {
    if (saveFailed) return;
    if (dirty || fetcher.state !== "idle") {
      setPendingNavigation({
        href,
        sawSaveInFlight: fetcher.state !== "idle",
      });
      if (fetcher.state === "idle") flushAutosave();
      return;
    }
    void navigate(href);
  }
  /* The shortcut handler reads the model through a ref rather than through its
     dependency list: navigation closes over autosave state that changes on
     every keystroke, and resubscribing the document listener that often would
     make a keypress depend on render timing. */
  const shortcutModel = useRef({
    previousAssignment,
    nextAssignment,
    readOnly,
    requestAssignmentNavigation,
  });
  useEffect(() => {
    shortcutModel.current = {
      previousAssignment,
      nextAssignment,
      readOnly,
      requestAssignmentNavigation,
    };
  });
  useEffect(() => {
    function openAssignment(assignment: ReviewAssignment | null) {
      if (!assignment) return false;
      shortcutModel.current.requestAssignmentNavigation(
        `/review/workbench?assignment=${assignment.id}`,
      );
      return true;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || reviewDialogIsOpen()) return;
      const locked = shortcutModel.current.readOnly;
      if (event.metaKey || event.ctrlKey) {
        // Commit shortcuts stay live inside the notes fields: they are the
        // fields a reviewer is in when the review is finished.
        if (event.key === "Enter" && !locked) {
          event.preventDefault();
          submitNextTriggerRef.current?.click();
        } else if (event.key.toLowerCase() === "s" && !locked) {
          event.preventDefault();
          saveDraftTriggerRef.current?.click();
        }
        return;
      }
      if (event.altKey || reviewTargetIsTyping(event.target)) return;
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.shiftKey) return;
      if (event.key === "j" || event.key === "]") {
        if (openAssignment(shortcutModel.current.nextAssignment))
          event.preventDefault();
        return;
      }
      if (event.key === "k" || event.key === "[") {
        if (openAssignment(shortcutModel.current.previousAssignment))
          event.preventDefault();
        return;
      }
      if (!locked && /^[1-9]$/.test(event.key) && formRef.current) {
        if (scoreRubricFromDigit(formRef.current, Number(event.key)))
          event.preventDefault();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  /* Opening an assignment puts the caret where the work starts. Only on a
     change: stealing focus on first paint would move a screen reader off the
     page heading before it has been read. */
  const focusedAssignmentKey = useRef(assignmentKey);
  useEffect(() => {
    if (focusedAssignmentKey.current === assignmentKey) return;
    focusedAssignmentKey.current = assignmentKey;
    const form = formRef.current;
    if (!form || readOnly) return;
    const groups = Array.from(
      form.querySelectorAll<HTMLElement>(SCALE_GROUP_SELECTOR),
    );
    const target =
      groups.find(
        (group) => !group.querySelector("input:checked:not([value=''])"),
      ) ?? groups[0];
    target
      ?.querySelector<HTMLInputElement>("input[type='radio']:not(:disabled)")
      ?.focus();
  }, [assignmentKey, readOnly]);
  return {
    viewer,
    workspace,
    eventName,
    eventTimezone,
    assignmentKey,
    fetcher,
    formRef,
    saveDraftTriggerRef,
    submitReviewTriggerRef,
    submitNextTriggerRef,
    conflictTriggerRef,
    editGeneration,
    inFlightSaveGeneration,
    conflictOpen,
    setConflictOpen,
    shortcutsOpen,
    setShortcutsOpen,
    submitMode,
    setSubmitMode,
    dirty,
    requiredCriterionCount,
    completedCriterionCount,
    weightedScore,
    conflictChoice,
    readOnly,
    revision,
    committedWarning,
    saveFailed,
    selectedIndex,
    previousAssignment,
    nextAssignment,
    recoveryPayload,
    recovery,
    suggestionImport,
    unchangedAiCriterionIds,
    confirmedAiCriterionIds,
    applyReviewerAiSuggestion,
    setAiCriterionConfirmed,
    clearAutosaveTimer,
    cancelAutosave,
    markDirty,
    captureRecoveryPayload,
    requestAssignmentNavigation,
  };
}

export const ReviewWorkbenchModelContext =
  createContext<ReviewWorkbenchModel | null>(null);

export function useReviewWorkbenchModel(): ReviewWorkbenchModel {
  const model = useContext(ReviewWorkbenchModelContext);
  if (!model) throw new Error("Review workbench model is unavailable.");
  return model;
}
