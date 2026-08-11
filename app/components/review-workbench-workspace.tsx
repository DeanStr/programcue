import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";

import { Dialog } from "~/components/dialog";
import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import { ReviewerShell } from "~/components/reviewer-shell";
import { ReviewAidAction } from "~/modules/ai/contextual-ai-actions";
import {
  clearDraftRecoveryScope,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";
import type { action, loader } from "~/routes/review-workbench.server";

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

export function ReviewWorkbenchWorkspace({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { viewer, eventName, workspace } = loaderData;
  const assignmentKey = workspace.selected?.id ?? "no-assignment";
  const fetcher = useFetcher<typeof action>({
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
  type ReviewRecoveryPayload = {
    scores: Record<string, string>;
    recommendation: string;
    confidence: string;
    submitterFeedback: string;
    privateNotes: string;
  };
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

  return (
    <ReviewerShell viewer={viewer} eventName={eventName}>
      <div className="page-head review-page-head">
        <div>
          <h1>Review Workbench</h1>
          <p>
            Review assigned submissions and sessions without losing queue
            context.
          </p>
        </div>
        <div className="page-actions">
          <DraftRecoveryStatus state={recovery.state} />
          <span
            className={`status ${dirty || committedWarning ? "warning" : saveFailed ? "danger" : fetcher.state === "idle" ? "success" : "info"}`}
          >
            {readOnly
              ? "Submitted"
              : fetcher.state !== "idle"
                ? "Saving…"
                : committedWarning
                  ? "Saved · live update delayed"
                  : saveFailed
                    ? "Save failed"
                    : dirty
                      ? "Unsaved changes"
                      : "Saved"}
          </span>
        </div>
      </div>
      <DraftRecoveryFeedback recovery={recovery} />
      {fetcher.data &&
      !committedWarning &&
      ("error" in fetcher.data ||
        ("ok" in fetcher.data && !fetcher.data.ok)) ? (
        <div className="validation-item error mb" role="alert">
          {"error" in fetcher.data ? fetcher.data.error : fetcher.data.message}
        </div>
      ) : fetcher.data && "message" in fetcher.data && fetcher.data.message ? (
        <div
          className={`validation-item ${committedWarning ? "warn" : "ok"} mb`}
          role="status"
        >
          {fetcher.data.message}
        </div>
      ) : null}
      {!workspace.selected || !workspace.submission ? (
        <section className="card pad">
          <div className="empty">
            <h2>No assigned reviews</h2>
            <p>Your active assignments will appear here.</p>
          </div>
        </section>
      ) : (
        <div className="review-layout">
          <aside
            className="card pad review-queue"
            aria-labelledby="review-queue-title"
          >
            <div className="card-title">
              <h2 id="review-queue-title">My queue</h2>
              <span className="status info right">
                {workspace.assignments.length}
              </span>
            </div>
            <nav
              className="review-queue-list"
              aria-label="Assigned review sources"
            >
              {workspace.assignments.map((assignment) => {
                const href = `/review/workbench?assignment=${assignment.id}`;
                return (
                  <Link
                    to={href}
                    key={assignment.id}
                    className={`queue-card${assignment.id === workspace.selected?.id ? " active" : ""}`}
                    aria-current={
                      assignment.id === workspace.selected?.id
                        ? "page"
                        : undefined
                    }
                    onClick={(event) => {
                      if (saveFailed || dirty || fetcher.state !== "idle") {
                        event.preventDefault();
                        requestAssignmentNavigation(href);
                      }
                    }}
                  >
                    <span className="pill track">
                      {assignment.category ?? "Uncategorised"}
                    </span>
                    <h3>{assignment.title}</h3>
                    <small className="subtle">
                      {assignment.reference} <span aria-hidden="true">·</span>{" "}
                      {assignment.status.replaceAll("_", " ")}
                    </small>
                  </Link>
                );
              })}
            </nav>
          </aside>
          <article
            className="card pad review-detail"
            aria-labelledby="review-submission-title"
          >
            <div className="card-title">
              <span className="status info">
                {workspace.selected.status.replaceAll("_", " ")}
              </span>
              <div className="page-actions right">
                <button
                  type="button"
                  className="btn small"
                  disabled={!previousAssignment || saveFailed}
                  onClick={() => {
                    if (previousAssignment) {
                      requestAssignmentNavigation(
                        `/review/workbench?assignment=${previousAssignment.id}`,
                      );
                    }
                  }}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn small"
                  disabled={!nextAssignment || saveFailed}
                  onClick={() => {
                    if (nextAssignment) {
                      requestAssignmentNavigation(
                        `/review/workbench?assignment=${nextAssignment.id}`,
                      );
                    }
                  }}
                >
                  Next
                </button>
              </div>
            </div>
            <h2 className="mt" id="review-submission-title">
              {workspace.submission.title}
            </h2>
            <p className="subtle">
              {workspace.submission.blindedReviewing
                ? "Speaker identity hidden"
                : workspace.submission.speakerNames.join(", ") ||
                  (workspace.submission.sourceType === "session"
                    ? "No speakers attached"
                    : "Speaker pending")}{" "}
              <span aria-hidden="true">·</span> {workspace.submission.format}
            </p>
            <div className="divider" />
            <h3>
              {workspace.submission.sourceType === "session"
                ? "Session snapshot"
                : "Proposal"}
            </h3>
            <dl className="review-answer-list">
              {workspace.submission.answerFields.map((field) => (
                <div key={field.id}>
                  <dt>{field.label}</dt>
                  <dd>
                    {Array.isArray(field.value)
                      ? field.value.join(", ")
                      : String(field.value ?? "")}
                  </dd>
                </div>
              ))}
            </dl>
            {workspace.attachments.length ? (
              <>
                <div className="divider" />
                <h3>
                  {workspace.submission.sourceType === "session"
                    ? "Session attachments"
                    : "Submission attachments"}
                </h3>
                <ul className="list-clean">
                  {workspace.attachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a href={attachment.downloadHref}>
                        {attachment.filename}
                      </a>
                      <small className="subtle">
                        {attachment.kind.replaceAll("_", " ")} ·{" "}
                        {Math.max(1, Math.ceil(attachment.sizeBytes / 1024))} KB
                      </small>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <div className="divider" />
            <h3>AI review aid</h3>
            <ReviewAidAction
              key={workspace.selected.id}
              assignmentId={workspace.selected.id}
            />
          </article>
          <section
            className="card review-score"
            aria-labelledby="review-score-title"
          >
            <fetcher.Form
              id="review-score-form"
              key={assignmentKey}
              method="post"
              ref={formRef}
              onChange={(event) => {
                if (!readOnly) {
                  markDirty();
                  captureRecoveryPayload(event.currentTarget);
                  const values = new FormData(event.currentTarget);
                  setCompletedCriterionCount(
                    workspace.criteria.filter(
                      (criterion) =>
                        criterion.required &&
                        String(
                          values.get(`score:${criterion.id}`) ?? "",
                        ).trim() !== "",
                    ).length,
                  );
                }
              }}
              onSubmit={(event) => {
                const submitter = (event.nativeEvent as SubmitEvent).submitter;
                if (
                  submitter instanceof HTMLButtonElement &&
                  (submitter.value === "save" || submitter.value === "submit")
                ) {
                  inFlightSaveGeneration.current = editGeneration.current;
                }
                cancelAutosave();
                setSubmitMode(null);
              }}
              className="review-score-form"
            >
              <input
                type="hidden"
                name="assignmentId"
                value={workspace.selected.id}
              />
              <input type="hidden" name="revision" value={revision} />
              <input
                type="hidden"
                name="openNext"
                value={submitMode === "next" ? "true" : "false"}
              />
              <div className="pad review-score-body">
                <div className="card-title review-score-head">
                  <h2 id="review-score-title">
                    Score {workspace.submission.sourceType}
                  </h2>
                  <span className="status info">
                    {completedCriterionCount} / {requiredCriterionCount}
                    <span className="sr-only"> required criteria complete</span>
                  </span>
                  {!readOnly ? (
                    <button
                      className="btn small danger"
                      type="button"
                      onClick={() => {
                        clearAutosaveTimer();
                        setConflictOpen(true);
                      }}
                    >
                      Declare conflict
                    </button>
                  ) : null}
                </div>
                <div className="review-rubric">
                  {workspace.criteria.map((criterion) => {
                    const inputId = `criterion-${criterion.id}`;
                    const descriptionId = `${inputId}-description`;
                    const weightId = `${inputId}-weight`;
                    const currentValue =
                      workspace.review?.scores[criterion.id] ?? "";
                    const selectValue =
                      typeof currentValue === "boolean"
                        ? currentValue
                          ? "yes"
                          : "no"
                        : currentValue;
                    return (
                      <div className="review-rubric-row" key={criterion.id}>
                        <div className="review-criterion">
                          <label htmlFor={inputId}>
                            {criterion.name}
                            {criterion.required ? (
                              <span className="sr-only"> (required)</span>
                            ) : null}
                          </label>
                          <small className="subtle" id={descriptionId}>
                            {criterion.description}
                          </small>
                        </div>
                        <span className="review-weight" id={weightId}>
                          {criterion.weightPercent > 0
                            ? `${criterion.weightPercent}%`
                            : criterion.required
                              ? "Required"
                              : "Optional"}
                          {criterion.weightPercent > 0 ? (
                            <span className="sr-only"> weight</span>
                          ) : null}
                        </span>
                        {criterion.inputType === "free_text" ? (
                          <textarea
                            className="textarea"
                            id={inputId}
                            name={`score:${criterion.id}`}
                            defaultValue={String(selectValue)}
                            aria-describedby={`${descriptionId} ${weightId}`}
                            required={criterion.required}
                            disabled={readOnly}
                          />
                        ) : (
                          <select
                            className="select review-score-select"
                            id={inputId}
                            name={`score:${criterion.id}`}
                            defaultValue={selectValue as string | number}
                            aria-describedby={`${descriptionId} ${weightId}`}
                            required={criterion.required}
                            disabled={readOnly}
                          >
                            <option value="">
                              {criterion.inputType === "yes_no"
                                ? "Choose…"
                                : "Score"}
                            </option>
                            {criterion.inputType === "yes_no" ? (
                              <>
                                <option value="yes">Yes</option>
                                <option value="no">No</option>
                              </>
                            ) : (
                              Array.from(
                                {
                                  length:
                                    criterion.inputType === "scale_10" ? 10 : 5,
                                },
                                (_, index) => index + 1,
                              ).map((score) => (
                                <option value={score} key={score}>
                                  {score} /{" "}
                                  {criterion.inputType === "scale_10" ? 10 : 5}
                                </option>
                              ))
                            )}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="review-overall-fields">
                  <label className="label">
                    Recommendation
                    <select
                      className="select"
                      name="recommendation"
                      defaultValue={workspace.review?.recommendation ?? ""}
                      disabled={readOnly}
                    >
                      <option value="">Choose…</option>
                      <option value="accept">Accept</option>
                      <option value="minor_changes">Minor changes</option>
                      <option value="conditional_accept">
                        Conditional accept
                      </option>
                      <option value="waitlist">Waitlist</option>
                      <option value="reject">Reject</option>
                    </select>
                  </label>
                  <label className="label">
                    Confidence
                    <select
                      className="select"
                      name="confidence"
                      defaultValue={workspace.review?.confidence ?? ""}
                      disabled={readOnly}
                    >
                      <option value="">Choose…</option>
                      {[1, 2, 3, 4, 5].map((score) => (
                        <option key={score} value={score}>
                          {score} / 5
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="review-notes">
                  <label className="label">
                    Applicant feedback
                    <textarea
                      className="textarea"
                      name="submitterFeedback"
                      defaultValue={workspace.review?.submitterFeedback ?? ""}
                      disabled={readOnly}
                    />
                  </label>
                  <label className="label">
                    Private notes
                    <textarea
                      className="textarea"
                      name="privateNotes"
                      defaultValue={workspace.review?.privateNotes ?? ""}
                      disabled={readOnly}
                    />
                  </label>
                </div>
              </div>
              <div className="sticky-actions review-actions">
                {readOnly ? (
                  <span className="subtle" role="status">
                    This review is submitted and locked.
                  </span>
                ) : (
                  <>
                    <span className="subtle">
                      Drafts save after one second of inactivity.
                    </span>
                    <span className="spacer" />
                    <button
                      className="btn"
                      type="submit"
                      name="intent"
                      value="save"
                      formNoValidate
                      disabled={fetcher.state !== "idle"}
                    >
                      Save draft
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={fetcher.state !== "idle"}
                      onClick={() => {
                        clearAutosaveTimer();
                        setSubmitMode("stay");
                      }}
                    >
                      Submit review
                    </button>
                    <button
                      className="btn primary"
                      type="button"
                      disabled={fetcher.state !== "idle"}
                      onClick={() => {
                        clearAutosaveTimer();
                        setSubmitMode("next");
                      }}
                    >
                      Submit and open next
                    </button>
                  </>
                )}
              </div>
            </fetcher.Form>
          </section>
        </div>
      )}
      {submitMode && workspace.selected && !readOnly ? (
        <Dialog
          title={
            submitMode === "next"
              ? "Submit and open the next review?"
              : "Submit this review?"
          }
          onClose={() => setSubmitMode(null)}
          footer={null}
        >
          <div className="stack">
            <div className="validation-item warn">
              <strong>The submitted revision will be locked</strong>
              <span>
                Your scores, recommendation and notes become an immutable
                submitted snapshot. Only an authorised evaluation manager can
                explicitly reopen the review, and that creates a new revision.
              </span>
            </div>
            <p>
              {submitMode === "next"
                ? "After the server confirms submission, the next unfinished assignment will open automatically."
                : "You will remain on this submitted review after the server confirms it."}
            </p>
            <div className="page-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setSubmitMode(null)}
              >
                Continue editing
              </button>
              <button
                form="review-score-form"
                type="submit"
                name="intent"
                value="submit"
                className="btn primary"
                disabled={fetcher.state !== "idle"}
              >
                {submitMode === "next"
                  ? "Submit and open next"
                  : "Submit review"}
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {fetcher.data && "conflict" in fetcher.data && fetcher.data.conflict ? (
        <div className="validation-item error mb" role="alert">
          <strong>Draft conflict</strong>
          <span>
            Your browser recovery copy remains intact. Export it or explicitly
            load the newer server revision; Program Cue will not overwrite it.
          </span>
          <span className="row-actions right">
            <button
              className="btn small"
              type="button"
              onClick={() => {
                const blob = new Blob(
                  [JSON.stringify(recoveryPayload, null, 2)],
                  {
                    type: "application/json",
                  },
                );
                const href = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = href;
                link.download = `${assignmentKey}-review-recovery.json`;
                link.click();
                URL.revokeObjectURL(href);
              }}
            >
              Export local edits
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "Discard the current editor contents and load the latest server review?",
                  )
                ) {
                  void recovery.clear().then(() => window.location.reload());
                }
              }}
            >
              Load server version
            </button>
          </span>
        </div>
      ) : null}
      {conflictOpen && workspace.selected && !readOnly ? (
        <Dialog
          title="Declare a conflict"
          onClose={() => setConflictOpen(false)}
          footer={null}
        >
          <fetcher.Form
            method="post"
            className="stack"
            onSubmit={() => {
              cancelAutosave();
              setConflictOpen(false);
            }}
          >
            <input type="hidden" name="intent" value="conflict" />
            <input
              type="hidden"
              name="assignmentId"
              value={workspace.selected.id}
            />
            <label className="label">
              Reason
              <textarea
                className="textarea"
                name="reason"
                minLength={10}
                required
              />
            </label>
            <p className="help">
              The review will be recused and returned to the committee for
              reassignment.
            </p>
            <button className="btn danger" disabled={fetcher.state !== "idle"}>
              {fetcher.state === "submitting"
                ? "Declaring…"
                : "Declare and recuse"}
            </button>
          </fetcher.Form>
        </Dialog>
      ) : null}
    </ReviewerShell>
  );
}
