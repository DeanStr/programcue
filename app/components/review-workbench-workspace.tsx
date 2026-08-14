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

/* The rail is never the only carrier: the same state is spelled out in the
   card's last line, so colour-blind, printed and forced-colors readings all
   still answer "how far is this one". */
const QUEUE_STATE_RAIL: Record<string, string> = {
  submitted: "var(--state-good-solid)",
  in_progress: "var(--brand-600)",
  reopened: "var(--state-warn-solid)",
};

function ReviewQueuePanel() {
  const { workspace, fetcher, dirty, saveFailed, requestAssignmentNavigation } =
    useReviewWorkbenchModel();
  const submittedCount = workspace.assignments.filter(
    (assignment) => assignment.status === "submitted",
  ).length;
  const assignedCount = workspace.assignments.length;
  return (
    <aside
      className="card pad review-queue"
      aria-labelledby="review-queue-title"
    >
      <div className="card-title">
        <h2 id="review-queue-title">My queue</h2>
        <span className="status info right">{assignedCount}</span>
      </div>
      <p className="review-queue-progress">
        <span className="pc-num">
          {submittedCount} of {assignedCount}
        </span>{" "}
        submitted
      </p>
      <div className="progress" aria-hidden="true">
        <span
          style={{
            width: `${assignedCount ? Math.round((submittedCount / assignedCount) * 100) : 0}%`,
          }}
        />
      </div>
      <nav className="review-queue-list" aria-label="Assigned review sources">
        {workspace.assignments.map((assignment) => {
          const href = `/review/workbench?assignment=${assignment.id}`;
          const current = assignment.id === workspace.selected?.id;
          return (
            <Link
              to={href}
              key={assignment.id}
              className={`queue-card rail-left${current ? " active" : ""}`}
              style={
                {
                  "--rail":
                    QUEUE_STATE_RAIL[assignment.status] ??
                    "var(--border-strong)",
                } as React.CSSProperties
              }
              aria-current={current ? "page" : undefined}
              onClick={(event) => {
                if (saveFailed || dirty || fetcher.state !== "idle") {
                  event.preventDefault();
                  requestAssignmentNavigation(href);
                }
              }}
            >
              <h3>{assignment.title}</h3>
              <span className="pill track">
                {assignment.category ?? "Uncategorised"}
              </span>
              <small className="queue-card-state">
                {assignment.status.replaceAll("_", " ")}{" "}
                <span aria-hidden="true">·</span>{" "}
                <span className="pc-num">{assignment.reference}</span>
              </small>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

/* A field the header already carries is not a second fact, and three of the six
   rows in the reading column were literal repeats of the title 100px above.
   Matched on value as well as id so a form that reuses one of these ids for
   something else keeps its answer. */
function unrepeatedAnswerFields(
  submission: NonNullable<
    ReturnType<typeof useReviewWorkbenchModel>["workspace"]["submission"]
  >,
) {
  const headed = new Map([
    ["title", submission.title],
    ["category", submission.category],
    ["format", submission.format],
  ]);
  return submission.answerFields
    .map((field) => ({
      ...field,
      text: Array.isArray(field.value)
        ? field.value.join(", ")
        : String(field.value ?? ""),
    }))
    .filter((field) => headed.get(field.id) !== field.text)
    .map((field) => ({
      ...field,
      /* Prose and a three-word answer are not the same kind of thing: one is
         read, the other is checked. Length is what separates them, because the
         schema does not say which fields are which. */
      prose: field.text.length > 60 || field.text.includes("\n"),
    }));
}

function ReviewSubmissionPanel() {
  const {
    workspace,
    saveFailed,
    selectedIndex,
    previousAssignment,
    nextAssignment,
    requestAssignmentNavigation,
  } = useReviewWorkbenchModel();
  const selected = workspace.selected;
  const submission = workspace.submission;
  if (!selected || !submission) return null;
  const answerFields = unrepeatedAnswerFields(submission);
  return (
    <article
      className="card pad review-detail"
      aria-labelledby="review-submission-title"
    >
      <div className="review-detail-head">
        <div className="review-detail-identity">
          <h2 id="review-submission-title">{submission.title}</h2>
          <p className="subtle">
            {submission.blindedReviewing
              ? "Speaker identity hidden"
              : submission.speakerNames.join(", ") ||
                (submission.sourceType === "session"
                  ? "No speakers attached"
                  : "Speaker pending")}{" "}
            <span aria-hidden="true">·</span> {submission.format}
          </p>
        </div>
        <div className="review-detail-nav">
          <span className="review-queue-position pc-num">
            {selectedIndex + 1} / {workspace.assignments.length}
          </span>
          {workspace.assignments.length > 1 ? (
            <span className="review-kbd-hint" aria-hidden="true">
              <kbd>K</kbd>
              <kbd>J</kbd>
            </span>
          ) : null}
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
      <div className="divider" />
      <h3>
        {submission.sourceType === "session" ? "Session snapshot" : "Proposal"}
      </h3>
      <dl className="review-answer-list">
        {answerFields.map((field) => (
          <div
            key={field.id}
            className={field.prose ? "review-answer prose" : "review-answer"}
          >
            <dt>{field.label}</dt>
            <dd>{field.text}</dd>
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

/* A scale is a choice among a handful of fixed positions. A row of segments
   states the chosen one at rest, so four criteria read as a profile; a dropdown
   costs a popup per criterion and shows nothing afterwards. Only a genuinely
   open list stays a <select>. */
function scaleOptions(inputType: string) {
  if (inputType === "yes_no")
    return [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ];
  if (inputType !== "scale_5" && inputType !== "scale_10") return null;
  return Array.from(
    { length: inputType === "scale_10" ? 10 : 5 },
    (_, index) => ({ value: String(index + 1), label: String(index + 1) }),
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
    setShortcutsOpen,
    saveDraftTriggerRef,
    dirty,
    saveFailed,
    submitMode,
    setSubmitMode,
    requiredCriterionCount,
    completedCriterionCount,
    weightedScore,
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
  // Weights without a weighted total is an arithmetic homework assignment; a
  // rubric with no scaled criterion has no total to show in the first place.
  const weighted = workspace.criteria.some(
    (criterion) =>
      criterion.inputType === "scale_5" || criterion.inputType === "scale_10",
  );
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
            <span className="status info right">
              {completedCriterionCount} / {requiredCriterionCount}
              <span className="sr-only"> required criteria complete</span>
            </span>
            <button
              type="button"
              className="review-shortcut-trigger"
              aria-label="Keyboard shortcuts"
              onClick={() => setShortcutsOpen(true)}
            >
              <kbd aria-hidden="true">?</kbd>
            </button>
          </div>
          <div className="review-rubric">
            {workspace.criteria.map((criterion) => {
              const inputId = `criterion-${criterion.id}`;
              const labelId = `${inputId}-label`;
              const descriptionId = `${inputId}-description`;
              const weightId = `${inputId}-weight`;
              const currentValue = workspace.review?.scores[criterion.id] ?? "";
              const storedValue =
                typeof currentValue === "boolean"
                  ? currentValue
                    ? "yes"
                    : "no"
                  : String(currentValue);
              const scale = scaleOptions(criterion.inputType);
              return (
                <div className="review-rubric-row" key={criterion.id}>
                  <div className="review-criterion">
                    {scale ? (
                      <span className="review-criterion-name" id={labelId}>
                        {criterion.name}
                        {criterion.required ? (
                          <span className="sr-only"> (required)</span>
                        ) : null}
                      </span>
                    ) : (
                      <label
                        className="review-criterion-name"
                        htmlFor={inputId}
                      >
                        {criterion.name}
                        {criterion.required ? (
                          <span className="sr-only"> (required)</span>
                        ) : null}
                      </label>
                    )}
                    <small className="subtle" id={descriptionId}>
                      {criterion.description}
                    </small>
                  </div>
                  <span className="review-weight pc-num" id={weightId}>
                    {criterion.weightPercent > 0
                      ? `${criterion.weightPercent}%`
                      : criterion.required
                        ? "Required"
                        : "Optional"}
                    {criterion.weightPercent > 0 ? (
                      <span className="sr-only"> weight</span>
                    ) : null}
                  </span>
                  {scale ? (
                    <fieldset
                      className="review-scale"
                      data-review-scale=""
                      role="radiogroup"
                      aria-labelledby={labelId}
                      aria-describedby={`${descriptionId} ${weightId}`}
                    >
                      {/* An optional criterion has to be able to go back to
                          unanswered; a dropdown could, and a row of segments
                          only can if one of them says so. */}
                      {!criterion.required ? (
                        <label className="review-scale-option is-clear">
                          <input
                            className="review-scale-input"
                            type="radio"
                            name={`score:${criterion.id}`}
                            value=""
                            defaultChecked={storedValue === ""}
                            disabled={readOnly}
                          />
                          <span>
                            <span aria-hidden="true">—</span>
                            <span className="sr-only">Not scored</span>
                          </span>
                        </label>
                      ) : null}
                      {scale.map((option) => (
                        <label
                          className="review-scale-option"
                          key={option.value}
                        >
                          <input
                            className="review-scale-input"
                            type="radio"
                            name={`score:${criterion.id}`}
                            value={option.value}
                            defaultChecked={storedValue === option.value}
                            required={criterion.required}
                            disabled={readOnly}
                          />
                          <span className="pc-num">{option.label}</span>
                        </label>
                      ))}
                    </fieldset>
                  ) : criterion.inputType === "free_text" ? (
                    <textarea
                      className="textarea"
                      id={inputId}
                      name={`score:${criterion.id}`}
                      defaultValue={storedValue}
                      aria-describedby={`${descriptionId} ${weightId}`}
                      required={criterion.required}
                      disabled={readOnly}
                    />
                  ) : (
                    <select
                      className="select review-score-select"
                      id={inputId}
                      name={`score:${criterion.id}`}
                      defaultValue={storedValue}
                      aria-describedby={`${descriptionId} ${weightId}`}
                      required={criterion.required}
                      disabled={readOnly}
                    >
                      <option value="">Choose…</option>
                      {criterion.options.map((option) => (
                        <option value={option} key={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
          {weighted ? (
            <div className="score-summary">
              <div>
                <span className="score-summary-label">Weighted score</span>
                <small className="subtle">
                  {weightedScore === null
                    ? "Appears once every scored criterion has a value."
                    : "Weighted by the criterion percentages in this round."}
                </small>
              </div>
              <strong
                className={`score-summary-value pc-num${weightedScore === null ? " is-pending" : ""}`}
              >
                {weightedScore === null ? "—" : weightedScore.toFixed(2)}
                <span className="score-summary-unit"> / 5</span>
              </strong>
            </div>
          ) : null}
          <div className="review-overall-fields">
            <label className="label">
              Recommendation
              <select
                className="select"
                name="recommendation"
                defaultValue={workspace.review?.recommendation ?? ""}
                required
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
                required
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
          {!readOnly ? (
            <div className="review-recusal">
              <button
                ref={conflictTriggerRef}
                className="btn small"
                type="button"
                onClick={() => {
                  clearAutosaveTimer();
                  setConflictOpen(true);
                }}
              >
                Declare conflict
              </button>
              <small className="subtle">
                Recuses you and returns this {submission.sourceType} to the
                committee.
              </small>
            </div>
          ) : null}
        </div>
        <div className="sticky-actions review-actions">
          {readOnly ? (
            <span className="subtle" role="status">
              This review is submitted and locked.
            </span>
          ) : (
            <>
              <span className="review-save-state">
                {fetcher.state !== "idle"
                  ? "Saving…"
                  : saveFailed
                    ? "Save failed"
                    : dirty
                      ? "Unsaved"
                      : "Saved"}
              </span>
              <button
                ref={saveDraftTriggerRef}
                className="btn review-save-draft"
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
                  if (!formRef.current?.reportValidity()) return;
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
                  if (!formRef.current?.reportValidity()) return;
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

function ReviewShortcutSheet() {
  const { shortcutsOpen, setShortcutsOpen, readOnly } =
    useReviewWorkbenchModel();
  return shortcutsOpen ? (
    <Dialog
      title="Keyboard shortcuts"
      onClose={() => setShortcutsOpen(false)}
      footer={
        <button
          type="button"
          className="btn"
          onClick={() => setShortcutsOpen(false)}
        >
          Close
        </button>
      }
    >
      <dl className="shortcut-list review-shortcut-list">
        <div>
          <dt>
            <kbd>J</kbd> / <kbd>K</kbd>
          </dt>
          <dd>Open the next or previous assignment</dd>
        </div>
        {!readOnly ? (
          <>
            <div>
              <dt>
                <kbd>1</kbd> – <kbd>9</kbd>
              </dt>
              <dd>
                Score the criterion you are on, then move to the next unscored
                one
              </dd>
            </div>
            <div>
              <dt>
                <kbd>←</kbd> / <kbd>→</kbd>
              </dt>
              <dd>Move within one criterion&rsquo;s scale</dd>
            </div>
            <div>
              <dt>
                <kbd>⌘/Ctrl</kbd> + <kbd>S</kbd>
              </dt>
              <dd>Save the draft now</dd>
            </div>
            <div>
              <dt>
                <kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd>
              </dt>
              <dd>Submit this review and open the next</dd>
            </div>
          </>
        ) : null}
        <div>
          <dt>
            <kbd>?</kbd>
          </dt>
          <dd>Open this shortcut reference</dd>
        </div>
      </dl>
    </Dialog>
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
      <ReviewShortcutSheet />
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
