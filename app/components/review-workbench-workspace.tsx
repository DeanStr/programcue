import { Link } from "react-router";

import { Dialog } from "~/components/dialog";
import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import {
  ReviewWorkbenchModelContext,
  useReviewWorkbenchModel,
  useReviewWorkbenchState,
  type ReviewWorkbenchWorkspaceProps,
} from "~/components/review-workbench-model";
import { ReviewerShell } from "~/components/reviewer-shell";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { EmptyState } from "~/components/ui/states";
import { ReviewAidAction } from "~/modules/ai/contextual-ai-actions";

export {
  reviewCanAdoptServerPayload,
  reviewSaveCoversCurrentEdits,
} from "~/components/review-workbench-model";

function ReviewQueuePanel() {
  const { workspace, fetcher, dirty, saveFailed, requestAssignmentNavigation } =
    useReviewWorkbenchModel();
  return (
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
      <nav className="review-queue-list" aria-label="Assigned review sources">
        {workspace.assignments.map((assignment) => {
          const href = `/review/workbench?assignment=${assignment.id}`;
          return (
            <Link
              to={href}
              key={assignment.id}
              className={`queue-card${assignment.id === workspace.selected?.id ? " active" : ""}`}
              aria-current={
                assignment.id === workspace.selected?.id ? "page" : undefined
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
  );
}

function ReviewSubmissionPanel() {
  const {
    workspace,
    saveFailed,
    previousAssignment,
    nextAssignment,
    requestAssignmentNavigation,
  } = useReviewWorkbenchModel();
  const selected = workspace.selected;
  const submission = workspace.submission;
  if (!selected || !submission) return null;
  return (
    <article
      className="card pad review-detail"
      aria-labelledby="review-submission-title"
    >
      <div className="card-title">
        <span className="status info">
          {selected.status.replaceAll("_", " ")}
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
        {submission.title}
      </h2>
      <p className="subtle">
        {submission.blindedReviewing
          ? "Speaker identity hidden"
          : submission.speakerNames.join(", ") ||
            (submission.sourceType === "session"
              ? "No speakers attached"
              : "Speaker pending")}{" "}
        <span aria-hidden="true">·</span> {submission.format}
      </p>
      <div className="divider" />
      <h3>
        {submission.sourceType === "session" ? "Session snapshot" : "Proposal"}
      </h3>
      <dl className="review-answer-list">
        {submission.answerFields.map((field) => (
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
            {submission.sourceType === "session"
              ? "Session attachments"
              : "Submission attachments"}
          </h3>
          <ul className="list-clean">
            {workspace.attachments.map((attachment) => (
              <li key={attachment.id}>
                <a href={attachment.downloadHref}>{attachment.filename}</a>
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
      <ReviewAidAction key={selected.id} assignmentId={selected.id} />
    </article>
  );
}

function ReviewScorePanel() {
  const {
    workspace,
    assignmentKey,
    fetcher,
    formRef,
    submitReviewTriggerRef,
    submitNextTriggerRef,
    conflictTriggerRef,
    editGeneration,
    inFlightSaveGeneration,
    setConflictOpen,
    submitMode,
    setSubmitMode,
    requiredCriterionCount,
    completedCriterionCount,
    setCompletedCriterionCount,
    readOnly,
    revision,
    markDirty,
    captureRecoveryPayload,
    cancelAutosave,
    clearAutosaveTimer,
  } = useReviewWorkbenchModel();
  const selected = workspace.selected;
  const submission = workspace.submission;
  if (!selected || !submission) return null;
  return (
    <section className="card review-score" aria-labelledby="review-score-title">
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
                  String(values.get(`score:${criterion.id}`) ?? "").trim() !==
                    "",
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
        <input type="hidden" name="assignmentId" value={selected.id} />
        <input type="hidden" name="revision" value={revision} />
        <input
          type="hidden"
          name="openNext"
          value={submitMode === "next" ? "true" : "false"}
        />
        <div className="pad review-score-body">
          <div className="card-title review-score-head">
            <h2 id="review-score-title">Score {submission.sourceType}</h2>
            <span className="status info">
              {completedCriterionCount} / {requiredCriterionCount}
              <span className="sr-only"> required criteria complete</span>
            </span>
            {!readOnly ? (
              <button
                ref={conflictTriggerRef}
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
              const currentValue = workspace.review?.scores[criterion.id] ?? "";
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
                        {criterion.inputType === "yes_no" ||
                        criterion.inputType === "dropdown"
                          ? "Choose…"
                          : "Score"}
                      </option>
                      {criterion.inputType === "dropdown" ? (
                        criterion.options.map((option) => (
                          <option value={option} key={option}>
                            {option}
                          </option>
                        ))
                      ) : criterion.inputType === "yes_no" ? (
                        <>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </>
                      ) : (
                        Array.from(
                          {
                            length: criterion.inputType === "scale_10" ? 10 : 5,
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
                <option value="conditional_accept">Conditional accept</option>
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
                ref={submitReviewTriggerRef}
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
                ref={submitNextTriggerRef}
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
  );
}

function ReviewWorkspaceState() {
  const { workspace } = useReviewWorkbenchModel();
  return !workspace.selected || !workspace.submission ? (
    <section className="card pad">
      <EmptyState
        title="No assigned reviews"
        description="Your active assignments will appear here."
        headingLevel={2}
      />
    </section>
  ) : (
    <div className="review-layout">
      <ReviewQueuePanel />
      <ReviewSubmissionPanel />
      <ReviewScorePanel />
    </div>
  );
}

function ReviewWorkbenchHeader() {
  const { fetcher, dirty, readOnly, committedWarning, saveFailed, recovery } =
    useReviewWorkbenchModel();
  return (
    <div className="page-head review-page-head">
      <div>
        <h1>Review Workbench</h1>
        <p>
          Review assigned submissions and sessions without losing queue context.
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
  );
}

function ReviewDraftRecoveryNotice() {
  const { recovery } = useReviewWorkbenchModel();
  return <DraftRecoveryFeedback recovery={recovery} />;
}

function ReviewActionNotice() {
  const { fetcher, committedWarning } = useReviewWorkbenchModel();
  return fetcher.data &&
    !committedWarning &&
    ("error" in fetcher.data || ("ok" in fetcher.data && !fetcher.data.ok)) ? (
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
  ) : null;
}

function ReviewSubmitDialog() {
  const {
    workspace,
    fetcher,
    submitMode,
    setSubmitMode,
    readOnly,
    submitReviewTriggerRef,
    submitNextTriggerRef,
  } = useReviewWorkbenchModel();
  return submitMode && workspace.selected && !readOnly ? (
    <Dialog
      title={
        submitMode === "next"
          ? "Submit and open the next review?"
          : "Submit this review?"
      }
      onClose={() => setSubmitMode(null)}
      returnFocus={
        submitMode === "next" ? submitNextTriggerRef : submitReviewTriggerRef
      }
      footer={null}
    >
      <div className="stack">
        <div className="validation-item warn">
          <strong>The submitted revision will be locked</strong>
          <span>
            Your scores, recommendation and notes become an immutable submitted
            snapshot. Only an authorised evaluation manager can explicitly
            reopen the review, and that creates a new revision.
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
            {submitMode === "next" ? "Submit and open next" : "Submit review"}
          </button>
        </div>
      </div>
    </Dialog>
  ) : null;
}

function ReviewDraftConflictNotice() {
  const { assignmentKey, fetcher, recoveryPayload, recovery } =
    useReviewWorkbenchModel();
  const { confirm, dialog } = useConfirm();
  return fetcher.data && "conflict" in fetcher.data && fetcher.data.conflict ? (
    <>
      {dialog}
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
                { type: "application/json" },
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
            onClick={() =>
              confirm(
                {
                  title: "Load the latest server review?",
                  description:
                    "The editor contents in this browser are discarded, the recovery copy is cleared and the page reloads with the newest server revision. Export your local edits first if you still need them.",
                  confirmLabel: "Discard and load server version",
                  tone: "danger",
                },
                () => {
                  void recovery.clear().then(() => window.location.reload());
                },
              )
            }
          >
            Load server version
          </button>
        </span>
      </div>
    </>
  ) : null;
}

function ReviewConflictDialog() {
  const {
    workspace,
    fetcher,
    conflictOpen,
    setConflictOpen,
    conflictTriggerRef,
    readOnly,
    cancelAutosave,
  } = useReviewWorkbenchModel();
  return conflictOpen && workspace.selected && !readOnly ? (
    <Dialog
      title="Declare a conflict"
      onClose={() => setConflictOpen(false)}
      returnFocus={conflictTriggerRef}
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
          {fetcher.state === "submitting" ? "Declaring…" : "Declare and recuse"}
        </button>
      </fetcher.Form>
    </Dialog>
  ) : null;
}

function ReviewWorkbenchPage() {
  const { viewer, eventName } = useReviewWorkbenchModel();
  return (
    <ReviewerShell viewer={viewer} eventName={eventName}>
      <ReviewWorkbenchHeader />
      <ReviewDraftRecoveryNotice />
      <ReviewActionNotice />
      <ReviewWorkspaceState />
      <ReviewSubmitDialog />
      <ReviewDraftConflictNotice />
      <ReviewConflictDialog />
    </ReviewerShell>
  );
}

export function ReviewWorkbenchWorkspace(props: ReviewWorkbenchWorkspaceProps) {
  const model = useReviewWorkbenchState(props);
  return (
    <ReviewWorkbenchModelContext.Provider value={model}>
      <ReviewWorkbenchPage />
    </ReviewWorkbenchModelContext.Provider>
  );
}
