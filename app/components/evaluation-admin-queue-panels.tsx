import { Form } from "react-router";

import { EventDateTime } from "~/components/ui/event-date-time";
import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";

export function EvaluationProgressionPanel() {
  const {
    loaderData,
    navigation,
    setAdvanceOpen,
    activeRound,
    nextRound,
    unfinishedAssignmentCount,
    advanceableSubmissions,
    assignmentTargets,
  } = useEvaluationAdminModel();
  const plan = loaderData.plan;
  if (!plan) return null;
  return (
    <section className="card pad mb">
      <div className="card-title">
        <div>
          <h2>Round progression</h2>
          <p className="subtle">
            Add a protected next round by cloning an existing rubric, then
            advance a reviewed shortlist atomically.
          </p>
        </div>
      </div>
      {plan.rounds.length < 10 ? (
        <Form method="post" className="inline-form mb">
          <input type="hidden" name="intent" value="add-next-round" />
          <input type="hidden" name="planId" value={plan.id} />
          <input type="hidden" name="planRevision" value={plan.revision} />
          <input
            className="input"
            name="name"
            placeholder={`Round ${plan.rounds.length + 1} name`}
            aria-label="Next round name"
            required
          />
          <select
            className="select"
            name="cloneRoundId"
            aria-label="Rubric to clone"
            defaultValue={activeRound?.id ?? plan.rounds.at(-1)?.id}
          >
            {plan.rounds.map((round) => (
              <option key={round.id} value={round.id}>
                Clone {round.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={navigation.state !== "idle"}>
            Add next round
          </button>
        </Form>
      ) : null}
      {activeRound && nextRound ? (
        <div className="validation-item warn">
          <span>
            <strong>
              {unfinishedAssignmentCount === 0
                ? `${advanceableSubmissions.length} reviewed submission${advanceableSubmissions.length === 1 ? "" : "s"} can be shortlisted for ${nextRound.name}.`
                : `${unfinishedAssignmentCount} assignment${unfinishedAssignmentCount === 1 ? " remains" : "s remain"} unfinished in ${activeRound.name}.`}
            </strong>
            Advancing closes and locks the current round, activates the next
            round and creates the new assignments together.
          </span>
          <button
            type="button"
            className="btn small primary"
            disabled={
              unfinishedAssignmentCount > 0 ||
              advanceableSubmissions.length === 0 ||
              assignmentTargets.length === 0
            }
            onClick={() => setAdvanceOpen(true)}
          >
            Review advancement
          </button>
        </div>
      ) : activeRound ? (
        <p className="help">Add the next round before advancing a shortlist.</p>
      ) : (
        <p className="help">There is no active evaluation round.</p>
      )}
    </section>
  );
}

export function EvaluationSubmissionQueue() {
  const {
    loaderData,
    setDecisionId,
    setNoReviewOverrideConfirmed,
    setBulkAssignOpen,
    setBulkAssignPreview,
    setBulkAssignmentTarget,
    setBulkSubmissionIds,
    activeRound,
    assignmentTargets,
    bulkAssignableSubmissions,
  } = useEvaluationAdminModel();
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Submission queue</h2>
        <div className="page-actions right">
          <span className="help">Assignments and decisions are audited</span>
          {activeRound &&
          assignmentTargets.length > 0 &&
          bulkAssignableSubmissions.length > 0 ? (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setBulkSubmissionIds(new Set());
                setBulkAssignmentTarget(assignmentTargets[0]?.value ?? "");
                setBulkAssignPreview(false);
                setBulkAssignOpen(true);
              }}
            >
              Bulk assign
            </button>
          ) : null}
        </div>
      </div>
      {loaderData.submissions.length ? (
        <div className="table-wrap pc-responsive-table-wrap">
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th scope="col">Submission</th>
                <th scope="col">Status</th>
                <th scope="col">Reviews</th>
                <th scope="col">Average</th>
                <th scope="col">Assign</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.submissions.map((submission) => {
                const terminal = [
                  "accepted",
                  "waitlisted",
                  "rejected",
                ].includes(submission.status);
                const decidable =
                  !terminal && submission.status !== "withdrawn";
                const assignable = [
                  "submitted",
                  "assigned",
                  "in_review",
                ].includes(submission.status);
                return (
                  <tr key={submission.id}>
                    <td
                      className="pc-record-primary-cell"
                      data-label="Submission"
                    >
                      <div className="pc-record-stack">
                        <strong>{submission.title}</strong>
                        <small className="subtle">{submission.reference}</small>
                        <small className="subtle">
                          {submission.category ?? "Uncategorised"}
                        </small>
                        {submission.routedTeamName ? (
                          <small className="subtle">
                            Routed to {submission.routedTeamName}
                          </small>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="Status">
                      <span
                        className={`status ${terminal ? "success" : "info"}`}
                      >
                        {submission.status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td data-label="Reviews">
                      {submission.completedReviewCount} /{" "}
                      {submission.assignmentCount}
                    </td>
                    <td data-label="Average">
                      {submission.averageScore === null
                        ? "—"
                        : Number(submission.averageScore).toFixed(2)}
                    </td>
                    <td data-label="Assign" className="pc-record-action-cell">
                      {assignable && activeRound && assignmentTargets.length ? (
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
                            value="submission"
                          />
                          <input
                            type="hidden"
                            name="targetId"
                            value={submission.id}
                          />
                          <select
                            className="select"
                            name="assignmentTarget"
                            aria-label={`Evaluator or team for ${submission.title}`}
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
                          <button className="btn small">Assign</button>
                        </Form>
                      ) : (
                        <span className="help">
                          {!assignable
                            ? "Review closed"
                            : !activeRound
                              ? "No active round"
                              : "Add an evaluator or active team"}
                        </span>
                      )}
                    </td>
                    <td data-label="Decision" className="pc-record-action-cell">
                      {!decidable ? (
                        <span className="status neutral">
                          {terminal ? "Final" : "Unavailable"}
                        </span>
                      ) : (
                        <button
                          className="btn small primary"
                          type="button"
                          onClick={() => {
                            setNoReviewOverrideConfirmed(false);
                            setDecisionId(submission.id);
                          }}
                        >
                          Decide
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <h2>No submitted proposals</h2>
          <p>Published form submissions will appear here.</p>
        </div>
      )}
    </section>
  );
}

export function AcceptedSpeakerInvitationsPanel() {
  const { loaderData, navigation } = useEvaluationAdminModel();
  return loaderData.acceptedSpeakerInvitations.length ? (
    <section className="card pad mt">
      <div className="card-title">
        <div>
          <h2>Speaker access invitations</h2>
          <p className="subtle">
            Renew an unaccepted speaker link explicitly. Renewal rotates the
            one-time token, invalidates every earlier link and starts a new
            seven-day window.
          </p>
        </div>
      </div>
      <div className="table-wrap pc-responsive-table-wrap">
        <table className="data-table pc-responsive-table">
          <thead>
            <tr>
              <th scope="col">Speaker</th>
              <th scope="col">Accepted session</th>
              <th scope="col">Access state</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {loaderData.acceptedSpeakerInvitations.map((invitation) => (
              <tr key={invitation.membershipId}>
                <td className="pc-record-primary-cell" data-label="Speaker">
                  <div className="pc-record-stack">
                    <strong>{invitation.name}</strong>
                    <small className="subtle">{invitation.email}</small>
                  </div>
                </td>
                <td data-label="Accepted session">{invitation.sessionTitle}</td>
                <td data-label="Access state">
                  <span
                    className={`status ${invitation.status === "expired" ? "danger" : "info"}`}
                  >
                    {invitation.status}
                  </span>{" "}
                  <EventDateTime
                    epochSeconds={invitation.expiresAt}
                    timeZone={loaderData.eventTimezone}
                  >
                    {invitation.status === "expired"
                      ? "expired link"
                      : "pending link"}
                  </EventDateTime>
                </td>
                <td className="pc-record-action-cell" data-label="Action">
                  {loaderData.acceptedSpeakerInvitationResendEnabled ? (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="resend-accepted-speaker"
                      />
                      <input
                        type="hidden"
                        name="decisionId"
                        value={invitation.decisionId}
                      />
                      <input
                        type="hidden"
                        name="membershipId"
                        value={invitation.membershipId}
                      />
                      <input
                        type="hidden"
                        name="expectedExpiresAt"
                        value={invitation.expiresAt}
                      />
                      <button
                        className="btn small"
                        disabled={navigation.state !== "idle"}
                      >
                        Renew invitation
                      </button>
                    </Form>
                  ) : (
                    <span className="help">Demo mode sends no email</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  ) : null;
}

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
        <div className="table-wrap pc-responsive-table-wrap">
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
                <tr key={session.id}>
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
                        <button className="btn small">Assign</button>
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
        <div className="empty">
          <h2>No direct sessions</h2>
          <p>Create a session before assigning it for review.</p>
        </div>
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

export function EvaluationModerationPanel() {
  const {
    loaderData,
    setModerationSubmissionId,
    setReopenAssignmentId,
    activeRound,
    activeRoundAssignments,
  } = useEvaluationAdminModel();
  return activeRound ? (
    <section className="card pad mt">
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
            <details className="card pad" key={submission.id}>
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
                        {assignment.recommendation
                          ? ` · ${assignment.recommendation.replaceAll("_", " ")}`
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
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => setReopenAssignmentId(assignment.id)}
                      >
                        Reopen review
                      </button>
                    ) : null}
                  </div>
                ))}
                {completed.length ? (
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
