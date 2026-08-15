import { Link } from "react-router";
import { useReviewWorkbenchModel } from "~/components/review-workbench-model";
import { ReviewAidAction } from "~/modules/ai/contextual-ai-actions";

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
      <div className="divider" />
      <h3>AI review aid</h3>
      <ReviewAidAction key={selected.id} assignmentId={selected.id} />
    </article>
  );
}
