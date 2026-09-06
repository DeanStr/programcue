import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import {
  clearDraftRecoveryScope,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";
import { useReviewWorkbenchAi } from "./review-workbench-ai";
import {
  isReviewRecoveryPayload,
  type ReviewRecoveryPayload,
  type ReviewWorkbenchAction,
  type ReviewWorkbenchLoaderData,
} from "./review-workbench-contract";

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
export function useReviewWorkbenchDraft({
  viewer,
  workspace,
}: ReviewWorkbenchLoaderData) {
  const assignmentKey = workspace.selected?.id ?? "no-assignment";
  const fetcher = useFetcher<ReviewWorkbenchAction>({
    key: `review-workbench:${assignmentKey}`,
  });
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editGeneration = useRef(0);
  const serverSyncedEditGeneration = useRef(0);
  const inFlightSaveGeneration = useRef<number | null>(null);
  const recoveryAssignmentKey = useRef(assignmentKey);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [abstentionOpen, setAbstentionOpen] = useState(false);
  const [submitMode, setSubmitMode] = useState<"stay" | "next" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  /* The revision sent with the next save is the last revision the server
     acknowledged for this assignment. It must not be read directly from
     fetcher.data: React Router can retain a previous response while another
     edit is being queued, and a retained response is not a new CAS token. */
  const [acknowledgedRevision, setAcknowledgedRevision] = useState(
    workspace.review?.revision ?? 0,
  );
  const acknowledgedRevisionRef = useRef(acknowledgedRevision);
  const [pendingNavigation, setPendingNavigation] = useState<{
    href: string;
    sawSaveInFlight: boolean;
  } | null>(null);
  const readOnly = workspace.selected?.status === "submitted";
  const revision = acknowledgedRevision;
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
  const {
    suggestionImport,
    setSuggestionImport,
    confirmedAiCriterionIds,
    setConfirmedAiCriterionIds,
    unchangedAiCriterionIds,
    applyReviewerAiSuggestion,
    setAiCriterionConfirmed,
  } = useReviewWorkbenchAi(workspace, recoveryPayload, readOnly);
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
    },
    [setSuggestionImport, setConfirmedAiCriterionIds],
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
    // Fetcher idleness can arrive before the acknowledgement effect advances
    // the revision. Keep ownership of that save until it is processed, so a
    // queued navigation cannot submit newer edits with the previous revision.
    if (
      !dirty ||
      saveFailed ||
      fetcher.state !== "idle" ||
      inFlightSaveGeneration.current !== null ||
      !formRef.current
    )
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
      abstentionOpen ||
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
    abstentionOpen,
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
      acknowledgedRevisionRef.current = workspace.review?.revision ?? 0;
      setAcknowledgedRevision(workspace.review?.revision ?? 0);
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
    workspace.review?.revision,
    setSuggestionImport,
    setConfirmedAiCriterionIds,
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
      /* A response is only an acknowledgement for the request currently
         owned by this assignment. Older retained responses cannot advance
         the revision token or clear a newer draft. */
      if (
        savedEditGeneration === null ||
        fetcher.data.revision <= acknowledgedRevisionRef.current
      ) {
        return;
      }
      acknowledgedRevisionRef.current = fetcher.data.revision;
      setAcknowledgedRevision(fetcher.data.revision);
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
  useEffect(() => {
    const serverRevision = workspace.review?.revision ?? 0;
    if (
      fetcher.state === "idle" &&
      !dirty &&
      inFlightSaveGeneration.current === null &&
      serverRevision > acknowledgedRevisionRef.current
    ) {
      acknowledgedRevisionRef.current = serverRevision;
      setAcknowledgedRevision(serverRevision);
    }
  }, [dirty, fetcher.state, workspace.review?.revision]);
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
  return {
    fetcher,
    formRef,
    editGeneration,
    inFlightSaveGeneration,
    conflictOpen,
    setConflictOpen,
    abstentionOpen,
    setAbstentionOpen,
    submitMode,
    setSubmitMode,
    dirty,
    readOnly,
    revision,
    committedWarning,
    saveFailed,
    recoveryPayload,
    recovery,
    suggestionImport,
    unchangedAiCriterionIds,
    confirmedAiCriterionIds,
    applyReviewerAiSuggestion: () => applyReviewerAiSuggestion(restoreReview),
    setAiCriterionConfirmed,
    clearAutosaveTimer,
    cancelAutosave,
    markDirty,
    captureRecoveryPayload,
    requestAssignmentNavigation,
  };
}
