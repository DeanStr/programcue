import { Sparkles } from "lucide-react";
import { Link, useFetcher } from "react-router";
import { useReviewWorkbenchModel } from "~/components/review-workbench-model";
import { buildUnansweredReviewerAiImport } from "~/modules/evaluations/reviewer-ai-import";
import type { action } from "~/routes/review-workbench.server";

const QUEUE_STATE_RAIL: Record<string, string> = {
  submitted: "var(--state-good-solid)",
  in_progress: "var(--brand-600)",
  reopened: "var(--state-warn-solid)",
};

export function ReviewQueuePanel() {
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
                {current ? (
                  <>
                    <span className="queue-card-current">Current</span>
                    <span aria-hidden="true"> · </span>
                  </>
                ) : null}
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

function ReviewerAiSuggestionPanel() {
  const {
    workspace,
    readOnly,
    recoveryPayload,
    applyReviewerAiSuggestion,
    suggestionImport,
  } = useReviewWorkbenchModel();
  const fetcher = useFetcher<typeof action>();
  const selected = workspace.selected;
  if (!selected) return null;
  if (!workspace.reviewerAiSetting.supported) return null;
  const suggestion = workspace.reviewerAiSuggestion;
  const initialDraftSaved = Boolean(
    workspace.review && Object.keys(workspace.review.scores).length,
  );
  const pending = fetcher.state !== "idle";
  const criterionById = new Map(
    workspace.criteria.map((criterion) => [criterion.id, criterion]),
  );
  const answerById = new Map(
    workspace.submission?.answerFields.map((field) => [field.id, field]) ?? [],
  );
  const hasUnansweredClosedSuggestion = Boolean(
    suggestion &&
      buildUnansweredReviewerAiImport(
        recoveryPayload.scores,
        suggestion.suggestions,
      ).importedCriterionIds.length,
  );
  return (
    <div className="stack">
      <p className="help">
        Suggestions are assignment-specific and advisory. AI cannot write notes,
        feedback, confidence or a final recommendation, and it cannot submit
        this review.
      </p>
      {!workspace.reviewerAiSetting.enabled ? (
        <div className="validation-item">
          <strong>Disabled for this event</strong>
          <span>An event administrator must explicitly opt in.</span>
        </div>
      ) : suggestion ? (
        <div className="stack" data-testid="reviewer-ai-suggestion">
          <div className="validation-item info">
            <strong>
              {suggestion.stale
                ? "AI suggestions need regeneration"
                : suggestion.status === "imported"
                  ? "AI suggestions imported into this draft"
                  : "AI suggestions ready for review"}
            </strong>
            <span>
              {suggestion.stale
                ? "The review changed after these suggestions were generated. Dismiss them before requesting a fresh set."
                : `${suggestion.provider.replaceAll("_", " ")} · ${suggestion.model}`}
            </span>
          </div>
          {suggestion.suggestions.map((item) => {
            const criterion = criterionById.get(item.criterionId);
            if (!criterion) {
              throw new Error(
                `Reviewer AI suggestion ${suggestion.id} references unknown criterion ${item.criterionId}.`,
              );
            }
            const evidenceLabels = item.evidenceFieldIds.map((fieldId) => {
              const answer = answerById.get(fieldId);
              if (!answer) {
                throw new Error(
                  `Reviewer AI suggestion ${suggestion.id} references unknown evidence field ${fieldId}.`,
                );
              }
              return answer.label;
            });
            return (
              <div className="validation-item" key={item.criterionId}>
                <strong>
                  {criterion.name}: {item.suggestedValue ?? "Rationale only"}
                </strong>
                <span>{item.rationale}</span>
                <small>
                  Evidence:{" "}
                  {evidenceLabels.length
                    ? evidenceLabels.join(", ")
                    : "No matching source field identified"}
                </small>
              </div>
            );
          })}
          {!readOnly &&
          suggestion.status === "offered" &&
          suggestionImport.suggestionId !== suggestion.id ? (
            <div className="cluster">
              <button
                className="btn primary"
                type="button"
                disabled={
                  pending || suggestion.stale || !hasUnansweredClosedSuggestion
                }
                onClick={applyReviewerAiSuggestion}
              >
                Fill unanswered criteria
              </button>
              <fetcher.Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="dismiss-reviewer-ai-suggestion"
                />
                <input
                  type="hidden"
                  name="suggestionId"
                  value={suggestion.id}
                />
                <button type="submit" className="btn" disabled={pending}>
                  Dismiss suggestions
                </button>
              </fetcher.Form>
              {!hasUnansweredClosedSuggestion ? (
                <span className="help">
                  Every closed criterion already has your answer. Change one
                  manually if the suggestion changes your assessment.
                </span>
              ) : null}
            </div>
          ) : suggestionImport.suggestionId === suggestion.id ? (
            <p className="help">
              Change any value normally. Only unchanged imported values require
              an explicit confirmation before submission.
            </p>
          ) : null}
        </div>
      ) : !initialDraftSaved ? (
        <div className="validation-item">
          <strong>Start with your own assessment</strong>
          <span>
            Save at least one rubric response before requesting AI suggestions.
          </span>
        </div>
      ) : readOnly ? null : (
        <fetcher.Form method="post" className="stack">
          <input
            type="hidden"
            name="intent"
            value="generate-reviewer-ai-suggestion"
          />
          <input type="hidden" name="assignmentId" value={selected.id} />
          {workspace.reviewerAiRetry ? (
            <>
              <input
                type="hidden"
                name="failedOperationId"
                value={workspace.reviewerAiRetry.operationId}
              />
              <label className="validation-item warning">
                <input
                  type="checkbox"
                  name="duplicateRiskAcknowledged"
                  value="true"
                  required
                />
                <span>
                  <strong>Confirm another provider request</strong>
                  Program Cue could not safely reconcile the previous provider
                  request. Retrying may duplicate usage or charges.
                </span>
              </label>
            </>
          ) : null}
          <button type="submit" className="btn" disabled={pending}>
            <Sparkles aria-hidden size={14} />
            {pending
              ? "Generating criterion suggestions…"
              : workspace.reviewerAiRetry
                ? "Retry criterion suggestions"
                : "Generate criterion suggestions"}
          </button>
        </fetcher.Form>
      )}
      {fetcher.data && "error" in fetcher.data ? (
        <p className="status danger" role="alert">
          {fetcher.data.error}
        </p>
      ) : fetcher.data?.message ? (
        <p className="status info" role="status">
          {fetcher.data.message}
        </p>
      ) : null}
    </div>
  );
}

export function ReviewSubmissionPanel() {
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
      {workspace.reviewerAiSetting.supported ? (
        <div className="review-ai-aside">
          <h3>AI reviewer suggestions</h3>
          <ReviewerAiSuggestionPanel key={selected.id} />
        </div>
      ) : null}
    </article>
  );
}
