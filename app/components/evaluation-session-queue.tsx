import { Form, Link } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { EmptyState } from "~/components/ui/states";

export function EvaluationSessionQueue() {
  const {
    loaderData,
    setReopenAssignmentId,
    activeRound,
    sessionReviewAssignments,
    assignmentTargets,
  } = useEvaluationAdminModel();
  return (
    <section className="card pad mt">
      {/* The enclosing AdminPageSection already names this "Session queue"; a
          card heading repeating it word for word gave the page two headings
          with the same name and told a reader nothing twice. What the section
          header cannot carry is the consequence of assigning, so that stays. */}
      <p className="subtle mb">
        Assign existing sessions directly. Reviewers receive a frozen copy of
        the session details and speakers at assignment time.
      </p>
      {loaderData.sessions.length ? (
        <div
          className="table-wrap pc-responsive-table-wrap"
          role="region"
          aria-label="Evaluation session queue"
          tabIndex={0}
        >
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Programme state</th>
                <th scope="col">Reviews</th>
                <th scope="col">Average</th>
                <th scope="col">Assign</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.sessions.map((session) => (
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
                  <td data-label="Assign" className="pc-record-action-cell">
                    {activeRound && assignmentTargets.length ? (
                      <Form method="post" className="inline-form">
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
                          className="select"
                          name="assignmentTarget"
                          aria-label={`Evaluator or team for ${session.title}`}
                        >
                          {(["Teams", "Individuals"] as const).map((kind) => {
                            const targets = assignmentTargets.filter(
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
                        <button type="submit" className="btn small">
                          Assign
                        </button>
                      </Form>
                    ) : (
                      <span className="help">
                        {!activeRound
                          ? "No active round"
                          : "Add an evaluator or active team"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No direct sessions"
          description="Create a session before assigning it for review."
        />
      )}
      {sessionReviewAssignments.length ? (
        <div className="stack mt">
          <strong>Active-round session reviews</strong>
          <ul className="list-clean">
            {sessionReviewAssignments.map((assignment) => (
              <li key={assignment.id}>
                <span>
                  <strong>{assignment.targetTitle}</strong>
                  <small className="subtle">
                    {assignment.evaluatorName} ·{" "}
                    {assignment.status.replaceAll("_", " ")}
                    {assignment.weightedScore === null
                      ? ""
                      : ` · ${Number(assignment.weightedScore).toFixed(2)} / 5`}
                  </small>
                </span>
                {assignment.reviewStatus === "submitted" ||
                assignment.reviewStatus === "locked" ? (
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() => setReopenAssignmentId(assignment.id)}
                  >
                    Reopen review
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
