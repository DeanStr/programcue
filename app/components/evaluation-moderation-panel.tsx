import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";

export function EvaluationModerationPanel() {
  const {
    loaderData,
    setModerationSubmissionId,
    setReopenAssignmentId,
    activeRound,
    activeRoundAssignments,
  } = useEvaluationAdminModel();
  return activeRound ? (
    <section className="card pad mt pc-eval-moderation">
      <div className="card-title">
        <div>
          <h2>Moderation and review control</h2>
          <p className="subtle">
            Compare submitted reviewer outcomes, record the chair's moderation
            and explicitly reopen a locked review when a correction is required.
          </p>
        </div>
        <span className="status info right">{activeRound.name}</span>
      </div>
      <div className="stack">
        {loaderData.submissions.map((submission) => {
          const assignments = activeRoundAssignments.filter(
            (assignment) => assignment.submissionId === submission.id,
          );
          const completed = assignments.filter(
            (assignment) =>
              assignment.reviewStatus === "submitted" ||
              assignment.reviewStatus === "locked",
          );
          const moderation = loaderData.moderations.find(
            (candidate) =>
              candidate.roundId === activeRound.id &&
              candidate.submissionId === submission.id,
          );
          if (assignments.length === 0) return null;
          return (
            <details className="card pad pc-disclosure" key={submission.id}>
              <summary>
                <strong>{submission.title}</strong> · {completed.length}/
                {assignments.length} submitted
                {moderation ? ` · moderation ${moderation.status}` : ""}
              </summary>
              <div className="stack mt">
                {assignments.map((assignment) => (
                  <div className="validation-item" key={assignment.id}>
                    <span>
                      <strong>{assignment.evaluatorName}</strong>
                      {assignment.teamName ? ` · ${assignment.teamName}` : ""}
                      <small className="subtle">
                        {assignment.status.replaceAll("_", " ")}
                        {assignment.weightedScore === null
                          ? ""
                          : ` · ${Number(assignment.weightedScore).toFixed(2)} / 5`}
                        {assignment.recommendationLabel
                          ? ` · ${assignment.recommendationLabel}`
                          : ""}
                      </small>
                      {assignment.conflictNotes ? (
                        <small className="subtle">
                          Conflict: {assignment.conflictNotes}
                        </small>
                      ) : null}
                    </span>
                    {assignment.status === "submitted" &&
                    (assignment.reviewStatus === "submitted" ||
                      assignment.reviewStatus === "locked") ? (
                      ["accepted", "waitlisted", "rejected"].includes(
                        submission.status,
                      ) && !submission.reviewableInCurrentCycle ? (
                        <span className="subtle">
                          Released decisions cannot be reopened here.
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn small"
                          onClick={() => setReopenAssignmentId(assignment.id)}
                        >
                          Reopen review
                        </button>
                      )
                    ) : null}
                  </div>
                ))}
                {completed.length > 0 &&
                !(
                  ["accepted", "waitlisted", "rejected"].includes(
                    submission.status,
                  ) && !submission.reviewableInCurrentCycle
                ) ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setModerationSubmissionId(submission.id)}
                  >
                    {moderation ? "Review moderation" : "Moderate reviews"}
                  </button>
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  ) : null;
}
