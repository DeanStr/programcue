import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  useFetcher,
  useNavigate,
  type FetcherWithComponents,
} from "react-router";

import {
  clearDraftRecoveryScope,
  useDraftRecovery,
  type DraftRecoveryController,
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

type ReviewWorkbenchLoaderData = Awaited<ReturnType<typeof loader>>;
type ReviewWorkspace = ReviewWorkbenchLoaderData["workspace"];
type ReviewAssignment = ReviewWorkspace["assignments"][number];

export type ReviewRecoveryPayload = {
  scores: Record<string, string>;
  recommendation: string;
  confidence: string;
  submitterFeedback: string;
  privateNotes: string;
};

export type ReviewWorkbenchModel = {
  viewer: ReviewWorkbenchLoaderData["viewer"];
  workspace: ReviewWorkspace;
  eventName: string;
  assignmentKey: string;
  fetcher: FetcherWithComponents<ReviewWorkbenchActionData>;
  formRef: RefObject<HTMLFormElement | null>;
  submitReviewTriggerRef: RefObject<HTMLButtonElement | null>;
  submitNextTriggerRef: RefObject<HTMLButtonElement | null>;
  conflictTriggerRef: RefObject<HTMLButtonElement | null>;
  editGeneration: RefObject<number>;
  inFlightSaveGeneration: RefObject<number | null>;
  conflictOpen: boolean;
  setConflictOpen: Dispatch<SetStateAction<boolean>>;
  submitMode: "stay" | "next" | null;
  setSubmitMode: Dispatch<SetStateAction<"stay" | "next" | null>>;
  dirty: boolean;
  requiredCriterionCount: number;
  completedCriterionCount: number;
  setCompletedCriterionCount: Dispatch<SetStateAction<number>>;
  readOnly: boolean;
  revision: number;
  committedWarning: boolean;
  saveFailed: boolean;
  previousAssignment: ReviewAssignment | null;
  nextAssignment: ReviewAssignment | null;
  recoveryPayload: ReviewRecoveryPayload;
  recovery: DraftRecoveryController<ReviewRecoveryPayload>;
  clearAutosaveTimer(): void;
  cancelAutosave(): void;
  markDirty(): void;
  captureRecoveryPayload(form: HTMLFormElement): void;
  requestAssignmentNavigation(href: string): void;
};

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
  const { viewer, eventName, workspace } = loaderData;
  const assignmentKey = workspace.selected?.id ?? "no-assignment";
  const fetcher = useFetcher<ReviewWorkbenchAction>({
    key: `review-workbench:${assignmentKey}`,
  });
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const submitReviewTriggerRef = useRef<HTMLButtonElement>(null);
  const submitNextTriggerRef = useRef<HTMLButtonElement>(null);
  const conflictTriggerRef = useRef<HTMLButtonElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editGeneration = useRef(0);
  const serverSyncedEditGeneration = useRef(0);
  const inFlightSaveGeneration = useRef<number | null>(null);
  const recoveryAssignmentKey = useRef(assignmentKey);
  const [conflictOpen, setConflictOpen] = useState(false);
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
  const storedCompletedCriterionCount = workspace.criteria.filter(
    (criterion) => {
      if (!criterion.required) return false;
      const response = workspace.review?.scores[criterion.id];
      return !(
        response === undefined ||
        (typeof response === "string" && response.trim() === "")
      );
    },
  ).length;
  const [completedCriterionCount, setCompletedCriterionCount] = useState(
    storedCompletedCriterionCount,
  );
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
    }),
    [workspace.criteria, workspace.review],
  );
  const [recoveryPayload, setRecoveryPayload] = useState(serverRecoveryPayload);
  const restoreReview = useCallback(
    (payload: ReviewRecoveryPayload) => {
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
        }
      };
      for (const [criterionId, value] of Object.entries(payload.scores))
        setValue(`score:${criterionId}`, value);
      setValue("recommendation", payload.recommendation);
      setValue("confidence", payload.confidence);
      setValue("submitterFeedback", payload.submitterFeedback);
      setValue("privateNotes", payload.privateNotes);
      setRecoveryPayload(payload);
      setCompletedCriterionCount(
        workspace.criteria.filter(
          (criterion) =>
            criterion.required &&
            String(payload.scores[criterion.id] ?? "").trim() !== "",
        ).length,
      );
      setDirty(true);
      editGeneration.current += 1;
      setEditVersion((current) => current + 1);
    },
    [workspace.criteria],
  );
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
    enabled: Boolean(workspace.selected && !readOnly),
  });
  useEffect(() => {
    if (!readOnly || !workspace.selected) return;
    void clearDraftRecoveryScope({
      eventId: viewer.eventId,
      personId: viewer.personId,
      recordType: "review",
      recordId: workspace.selected.id,
    });
  }, [readOnly, viewer.eventId, viewer.personId, workspace.selected?.id]);
  const handledSavedRevision = useRef<number | null>(null);
  const handledConflict = useRef<string | null>(null);
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
  }, [dirty, fetcher.state, navigate, pendingNavigation, saveFailed]);
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
      setCompletedCriterionCount(storedCompletedCriterionCount);
      setRecoveryPayload(serverRecoveryPayload);
      return;
    }
    if (
      reviewCanAdoptServerPayload(
        editGeneration.current,
        serverSyncedEditGeneration.current,
      )
    ) {
      setCompletedCriterionCount(storedCompletedCriterionCount);
      setRecoveryPayload(serverRecoveryPayload);
    }
  }, [assignmentKey, serverRecoveryPayload, storedCompletedCriterionCount]);
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
  function clearAutosaveTimer() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
  }
  function cancelAutosave() {
    clearAutosaveTimer();
    setDirty(false);
  }
  function flushAutosave() {
    if (!dirty || saveFailed || fetcher.state !== "idle" || !formRef.current)
      return false;
    const values = new FormData(formRef.current);
    values.set("intent", "save");
    values.set("revision", String(revision));
    inFlightSaveGeneration.current = editGeneration.current;
    cancelAutosave();
    void fetcher.submit(values, { method: "post" });
    return true;
  }
  function markDirty() {
    if (saveFailed) fetcher.reset();
    editGeneration.current += 1;
    setDirty(true);
    setEditVersion((current) => current + 1);
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
  return {
    viewer,
    workspace,
    eventName,
    assignmentKey,
    fetcher,
    formRef,
    submitReviewTriggerRef,
    submitNextTriggerRef,
    conflictTriggerRef,
    editGeneration,
    inFlightSaveGeneration,
    conflictOpen,
    setConflictOpen,
    submitMode,
    setSubmitMode,
    dirty,
    requiredCriterionCount,
    completedCriterionCount,
    setCompletedCriterionCount,
    readOnly,
    revision,
    committedWarning,
    saveFailed,
    previousAssignment,
    nextAssignment,
    recoveryPayload,
    recovery,
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
