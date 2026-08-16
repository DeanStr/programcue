import { AlertTriangle, Lock, Send } from "lucide-react";

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

const REVIEW_NOTE_LIMIT = 8_000;

function ReviewNoteField({
  name,
  label,
  scope,
  scopeLabel,
  help,
  defaultValue,
  length,
  disabled,
}: {
  name: string;
  label: string;
  scope: "shared" | "private";
  scopeLabel: string;
  help: string;
  defaultValue: string;
  length: number;
  disabled: boolean;
}) {
  const fieldId = `review-note-${name}`;
  const helpId = `${fieldId}-help`;
  const countId = `${fieldId}-count`;
  return (
    <div className={`review-note review-note-${scope}`}>
      <label className="label" htmlFor={fieldId}>
        <span className="review-note-head">
          <span>{label}</span>
          <span className={`review-note-scope is-${scope}`}>
            {scope === "private" ? (
              <Lock aria-hidden size={12} />
            ) : (
              <Send aria-hidden size={12} />
            )}
            {scopeLabel}
          </span>
        </span>
      </label>
      <small className="subtle review-note-help" id={helpId}>
        {help}
      </small>
      <textarea
        className="textarea"
        id={fieldId}
        name={name}
        defaultValue={defaultValue}
        maxLength={REVIEW_NOTE_LIMIT}
        aria-describedby={`${helpId} ${countId}`}
        disabled={disabled}
      />
      <small
        className="subtle review-note-count pc-num"
        id={countId}
        aria-live="polite"
      >
        {length.toLocaleString()} / {REVIEW_NOTE_LIMIT.toLocaleString()}
        <span className="sr-only"> characters used</span>
      </small>
    </div>
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
    conflictChoice,
    recoveryPayload,
    suggestionImport,
    unchangedAiCriterionIds,
    confirmedAiCriterionIds,
    setAiCriterionConfirmed,
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
  const scoringLocked = readOnly || conflictChoice === "conflict";
  const unconfirmedAiCriterionIds = unchangedAiCriterionIds.filter(
    (criterionId) => !confirmedAiCriterionIds.has(criterionId),
  );
  const submitAllowed =
    conflictChoice === "affirmed" && unconfirmedAiCriterionIds.length === 0;
  const submitBlockedReason =
    conflictChoice === "conflict"
      ? "Declare the conflict to return this assignment. A conflicted review cannot be submitted."
      : conflictChoice === "unanswered"
        ? "Answer the conflict of interest question before submitting."
        : unconfirmedAiCriterionIds.length
          ? "Confirm every unchanged AI-derived criterion before submitting."
          : undefined;
  const reviewerSuggestion = workspace.reviewerAiSuggestion;
  const suggestionByCriterionId = new Map(
    reviewerSuggestion?.suggestions.map((suggestion) => [
      suggestion.criterionId,
      suggestion,
    ]) ?? [],
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
            const control = event.target;
            const criterionId =
              control instanceof HTMLInputElement ||
              control instanceof HTMLSelectElement ||
              control instanceof HTMLTextAreaElement
                ? control.name.startsWith("score:")
                  ? control.name.slice("score:".length)
                  : undefined
                : undefined;
            markDirty(criterionId);
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
        {suggestionImport.suggestionId ? (
          <input
            type="hidden"
            name="suggestionId"
            value={suggestionImport.suggestionId}
          />
        ) : null}
        {suggestionImport.importedCriterionIds.map((criterionId) => (
          <input
            key={criterionId}
            type="hidden"
            name="importedCriterionId"
            value={criterionId}
          />
        ))}
        {submitMode !== null
          ? unchangedAiCriterionIds
              .filter((criterionId) => confirmedAiCriterionIds.has(criterionId))
              .map((criterionId) => (
                <input
                  key={criterionId}
                  type="hidden"
                  name="confirmedAiCriterionId"
                  value={criterionId}
                />
              ))
          : null}
        <input
          type="hidden"
          name="openNext"
          value={submitMode === "next" ? "true" : "false"}
        />
        {/* Native-disabled controls stay readable but are omitted from FormData.
            Preserve the draft while the reviewer completes recusal. */}
        {conflictChoice === "conflict"
          ? workspace.criteria.map((criterion) => (
              <input
                key={criterion.id}
                type="hidden"
                name={`score:${criterion.id}`}
                value={recoveryPayload.scores[criterion.id] ?? ""}
              />
            ))
          : null}
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
              <kbd>?</kbd>
            </button>
          </div>
          {!readOnly ? (
            <fieldset
              className="review-conflict-gate"
              data-state={conflictChoice}
            >
              <legend className="review-conflict-legend">
                <span className="review-step-index" aria-hidden="true">
                  1
                </span>
                Conflict of interest
                <span className="status warning">Required</span>
              </legend>
              <p className="subtle review-conflict-question">
                Do you have a personal, professional or financial interest in
                this {submission.sourceType} or its speakers?
              </p>
              <label className="review-conflict-option">
                <input
                  type="radio"
                  name="conflictAffirmed"
                  value="affirmed"
                  defaultChecked={conflictChoice === "affirmed"}
                />
                <span>
                  <strong>No conflict</strong>
                  <small className="subtle">
                    I can review and score this {submission.sourceType}{" "}
                    impartially.
                  </small>
                </span>
              </label>
              <label className="review-conflict-option">
                <input
                  type="radio"
                  name="conflictAffirmed"
                  value="conflict"
                  defaultChecked={conflictChoice === "conflict"}
                />
                <span>
                  <strong>I have a conflict</strong>
                  <small className="subtle">
                    Scoring is disabled and this assignment returns to the
                    committee for reassignment.
                  </small>
                </span>
              </label>
              {conflictChoice === "conflict" ? (
                <div className="review-conflict-action" role="alert">
                  <AlertTriangle aria-hidden size={16} />
                  <p>
                    Scoring is disabled. Declare the conflict to return this
                    assignment — nothing you have already typed will be sent to
                    the applicant.
                  </p>
                  <button
                    ref={conflictTriggerRef}
                    className="btn danger small"
                    type="button"
                    onClick={() => {
                      clearAutosaveTimer();
                      setConflictOpen(true);
                    }}
                  >
                    Declare conflict and return
                  </button>
                </div>
              ) : conflictChoice === "unanswered" ? (
                <p className="review-conflict-pending subtle">
                  Answer this before submitting. You can score a draft first,
                  but the review will not submit until the question is answered.
                </p>
              ) : null}
            </fieldset>
          ) : null}
          <div
            className="review-rubric"
            data-scoring-locked={scoringLocked ? "" : undefined}
            aria-disabled={conflictChoice === "conflict" || undefined}
          >
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
              const aiSuggestion = suggestionByCriterionId.get(criterion.id);
              const imported = suggestionImport.importedCriterionIds.includes(
                criterion.id,
              );
              const unchanged = unchangedAiCriterionIds.includes(criterion.id);
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
                    {imported && aiSuggestion ? (
                      <small className="subtle">
                        AI rationale: {aiSuggestion.rationale}
                      </small>
                    ) : null}
                    {!readOnly && unchanged ? (
                      <label className="review-ai-confirmation">
                        <input
                          type="checkbox"
                          checked={confirmedAiCriterionIds.has(criterion.id)}
                          onChange={(event) =>
                            setAiCriterionConfirmed(
                              criterion.id,
                              event.target.checked,
                            )
                          }
                        />
                        I reviewed and confirm this unchanged AI-derived value
                      </label>
                    ) : null}
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
                    <div
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
                            disabled={scoringLocked}
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
                            disabled={scoringLocked}
                          />
                          <span className="pc-num">{option.label}</span>
                        </label>
                      ))}
                    </div>
                  ) : criterion.inputType === "free_text" ? (
                    <textarea
                      className="textarea"
                      id={inputId}
                      name={`score:${criterion.id}`}
                      defaultValue={storedValue}
                      aria-describedby={`${descriptionId} ${weightId}`}
                      required={criterion.required}
                      disabled={scoringLocked}
                    />
                  ) : (
                    <select
                      className="select review-score-select"
                      id={inputId}
                      name={`score:${criterion.id}`}
                      defaultValue={storedValue}
                      aria-describedby={`${descriptionId} ${weightId}`}
                      required={criterion.required}
                      disabled={scoringLocked}
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
              Overall recommendation
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
            <ReviewNoteField
              name="submitterFeedback"
              label="Applicant feedback"
              scope="shared"
              scopeLabel="Shared with the applicant"
              help="Sent to the applicant when administrators publish this decision. Write it to be read by the person who wrote the proposal."
              defaultValue={workspace.review?.submitterFeedback ?? ""}
              length={recoveryPayload.submitterFeedback.length}
              disabled={readOnly}
            />
            <ReviewNoteField
              name="privateNotes"
              label="Private notes"
              scope="private"
              scopeLabel="Committee only"
              help="Never shown to the applicant. Visible to administrators and the evaluation committee."
              defaultValue={workspace.review?.privateNotes ?? ""}
              length={recoveryPayload.privateNotes.length}
              disabled={readOnly}
            />
          </div>
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
                disabled={fetcher.state !== "idle" || !submitAllowed}
                title={submitBlockedReason}
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
                disabled={fetcher.state !== "idle" || !submitAllowed}
                title={submitBlockedReason}
                onClick={() => {
                  if (!formRef.current?.reportValidity()) return;
                  clearAutosaveTimer();
                  setSubmitMode("next");
                }}
              >
                Submit and open next
              </button>
              {submitBlockedReason ? (
                <p className="review-submit-block subtle" role="status">
                  {submitBlockedReason}
                </p>
              ) : null}
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
