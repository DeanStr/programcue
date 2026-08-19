import { Form, Link } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { EmptyState } from "~/components/ui/states";
import { availableEvaluationAssignmentTargets } from "~/modules/evaluations/evaluation-assignment-availability";

export function EvaluationSessionQueue() {
  const {
    loaderData,
    setReopenAssignmentId,
    activeRound,
    activeRoundAssignments,
    assignmentTargets,
  } = useEvaluationAdminModel();
  return (
    <section className="card pad mt pc-eval-queue" id="evaluation-sessions">
      <div className="card-title">
        <div>
          <h2>Session queue</h2>
          <p className="subtle">
            Assign existing sessions directly. Reviewers receive a frozen copy
            of the session details and speakers at assignment time.
          </p>
        </div>
      </div>
      {loaderData.sessions.length ? (
        <section
          className="table-wrap pc-responsive-table-wrap"
          aria-label="Evaluation session queue"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
        >
          <table className="data-table pc-responsive-table pc-eval-table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Programme state</th>
                <th scope="col">Reviews</th>
                <th scope="col">Average</th>
                <th scope="col">Reviewers</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.sessions.map((session) => {
                const sessionAssignments = activeRoundAssignments.filter(
                  (assignment) =>
                    assignment.sessionId === session.id &&
                    assignment.status !== "cancelled",
                );
                const availableAssignmentTargets =
                  availableEvaluationAssignmentTargets({
                    assignmentTargets,
                    assignments: loaderData.assignments,
                    teams: loaderData.teams,
                    activeRound,
                    target: { type: "session", id: session.id },
                  });
                return (
                  <tr
                    key={session.id}
                    className={
                      loaderData.focusedSessionId === session.id
                        ? "pc-focused-record"
                        : undefined
                    }
                  >
                    <td data-label="Session" className="pc-record-primary-cell">
                      <div className="pc-record-stack">
                        <strong>{session.title}</strong>
                        <small className="subtle">
                          {session.reference} ·{" "}
                          {session.format.replaceAll("_", " ")} ·{" "}
                          {session.durationMinutes} min
                        </small>
                        {session.trackName ? (
                          <small className="subtle">{session.trackName}</small>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="Programme state">
                      <span className="status info">
                        {session.status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td data-label="Reviews">
                      {session.completedReviewCount} / {session.assignmentCount}
                      {loaderData.resultsRoundId ? (
                        <small>
                          <Link
                            to={`/admin/review?${new URLSearchParams({
                              resultsRound: loaderData.resultsRoundId,
                              session: session.id,
                              sort: loaderData.resultSort,
                              view: "results",
                              ...(loaderData.reviewFilter
                                ? { filter: loaderData.reviewFilter }
                                : {}),
                            })}#evaluation-discussion`}
                          >
                            Open discussion
                          </Link>
                        </small>
                      ) : null}
                    </td>
                    <td data-label="Average">
                      {session.averageScore === null
                        ? "—"
                        : Number(session.averageScore).toFixed(2)}
                    </td>
                    <td
                      data-label="Reviewers"
                      className="pc-record-action-cell"
                    >
                      {sessionAssignments.length > 0 && activeRound ? (
                        <div className="pc-record-stack">
                          <strong>
                            Assigned reviewers · {activeRound.name}
                          </strong>
                          {sessionAssignments.map((assignment) => (
                            <div
                              className="pc-record-stack"
                              key={assignment.id}
                            >
                              <small>
                                <strong>{assignment.evaluatorName}</strong> ·{" "}
                                {assignment.status
                                  .replaceAll("_", " ")
                                  .replace(/^./, (letter) =>
                                    letter.toUpperCase(),
                                  )}
                                {assignment.weightedScore === null
                                  ? ""
                                  : ` · ${Number(assignment.weightedScore).toFixed(2)} / 5`}
                              </small>
                              {assignment.reviewStatus === "submitted" ||
                              assignment.reviewStatus === "locked" ? (
                                <button
                                  type="button"
                                  className="btn small danger"
                                  aria-label={`Reopen ${assignment.evaluatorName}'s review for ${session.title}`}
                                  onClick={() =>
                                    setReopenAssignmentId(assignment.id)
                                  }
                                >
                                  Reopen review
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {activeRound && availableAssignmentTargets.length ? (
                        <Form
                          method="post"
                          className={`inline-form${sessionAssignments.length ? " mt" : ""}`}
                        >
                          <input type="hidden" name="intent" value="assign" />
                          <input
                            type="hidden"
                            name="roundId"
                            value={activeRound.id}
                          />
                          <input
                            type="hidden"
                            name="targetType"
                            value="session"
                          />
                          <input
                            type="hidden"
                            name="targetId"
                            value={session.id}
                          />
                          <select
                            className="select pc-eval-control"
                            name="assignmentTarget"
                            aria-label={`Evaluator or team for ${session.title}`}
                          >
                            {(["Teams", "Individuals"] as const).map((kind) => {
                              const targets = availableAssignmentTargets.filter(
                                (target) => target.kind === kind,
                              );
                              return targets.length ? (
                                <optgroup label={kind} key={kind}>
                                  {targets.map((target) => (
                                    <option
                                      value={target.value}
                                      key={target.value}
                                    >
                                      {target.label}
                                    </option>
                                  ))}
                                </optgroup>
                              ) : null;
                            })}
                          </select>
                          <button type="submit" className="pc-eval-text-action">
                            {sessionAssignments.length
                              ? "Add another reviewer"
                              : "Assign"}
                          </button>
                        </Form>
                      ) : (
                        <span className="help">
                          {!activeRound
                            ? "No active round"
                            : assignmentTargets.length > 0
                              ? "No additional eligible reviewers"
                              : "Add an evaluator or active team"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : (
        <EmptyState
          title="No direct sessions"
          description="Create a session before assigning it for review."
        />
      )}
    </section>
  );
}
