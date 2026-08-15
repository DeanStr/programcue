import { useReviewWorkbenchModel } from "~/components/review-workbench-model";
import { EmptyState } from "~/components/ui/states";
import { ReviewDiscussionPanel } from "./review-workbench-discussion-panel";
import {
  ReviewQueuePanel,
  ReviewSubmissionPanel,
} from "./review-workbench-submission-panels";

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

export function ReviewScorePanel() {
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

export function ReviewWorkspaceState() {
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
    <>
      <div className="review-layout">
        <ReviewQueuePanel />
        <ReviewSubmissionPanel />
        <ReviewScorePanel />
      </div>
      <ReviewDiscussionPanel />
    </>
  );
}
