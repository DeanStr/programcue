import { createContext, useContext, useEffect, useState } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";
import type { action } from "./evaluation-admin.server";
export {
  canReleaseEvaluationDecisions,
  decisionActionOutcome,
} from "./evaluation-admin-outcomes";
export { action, loader } from "./evaluation-admin.server";

import { Dialog } from "~/components/dialog";
import { EventDateTime } from "~/components/ui/event-date-time";
import type { Route } from "./+types/evaluation-admin";

export const meta = () => [{ title: "Evaluation · Program Cue" }];

const defaultRubric = [
  {
    name: "Relevance",
    description: "Fit for this event and audience",
    inputType: "scale_5",
    weightPercent: 25,
    required: true,
  },
  {
    name: "Originality",
    description: "Distinctive perspective",
    inputType: "scale_5",
    weightPercent: 20,
    required: true,
  },
  {
    name: "Content quality",
    description: "Clarity and substance",
    inputType: "scale_5",
    weightPercent: 25,
    required: true,
  },
  {
    name: "Practical application",
    description: "Useful attendee outcomes",
    inputType: "scale_5",
    weightPercent: 20,
    required: true,
  },
  {
    name: "Expertise",
    description: "Credible speaker experience",
    inputType: "scale_5",
    weightPercent: 10,
    required: true,
  },
] as const;

function RubricFields({
  criteria,
}: {
  criteria: ReadonlyArray<{
    name: string;
    description: string | null;
    inputType: string;
    weightPercent: number;
    required: boolean;
  }>;
}) {
  const rows = [
    ...criteria,
    {
      name: "",
      description: "",
      inputType: "free_text",
      weightPercent: 0,
      required: false,
    },
  ];
  return (
    <fieldset className="stack">
      <legend className="label">Rubric criteria</legend>
      <p className="help">
        Scored 1–5 and 1–10 criteria must total 100%. Yes/no and free-text
        criteria are contextual and must have zero weight. Every scored
        criterion is required; contextual criteria may be optional. Leave the
        final row blank unless another criterion is needed.
      </p>
      {rows.map((criterion, index) => (
        <div className="card pad" key={`${criterion.name}-${index}`}>
          <div className="grid grid-3">
            <label className="label">
              Criterion {index + 1}
              <input
                className="input"
                name="criterionName"
                defaultValue={criterion.name}
                required={index < criteria.length}
              />
            </label>
            <label className="label">
              Response type
              <select
                className="select"
                name="criterionInputType"
                defaultValue={criterion.inputType}
              >
                <option value="scale_5">Score 1–5</option>
                <option value="scale_10">Score 1–10</option>
                <option value="yes_no">Yes / no</option>
                <option value="free_text">Free text</option>
              </select>
            </label>
            <label className="label">
              Weight percent
              <input
                className="input"
                name="criterionWeight"
                type="number"
                min="0"
                max="100"
                defaultValue={criterion.weightPercent}
                required
              />
            </label>
          </div>
          <label className="label mt">
            Reviewer guidance
            <input
              className="input"
              name="criterionDescription"
              defaultValue={criterion.description ?? ""}
            />
          </label>
          <label className="label mt">
            Requirement
            <select
              className="select"
              name="criterionRequired"
              defaultValue={criterion.required ? "true" : "false"}
            >
              <option value="true">Required</option>
              <option value="false">Optional</option>
            </select>
          </label>
        </div>
      ))}
    </fieldset>
  );
}
function useEvaluationAdminState(
  loaderData: Route.ComponentProps["loaderData"],
) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  useEffect(() => {
    if (!loaderData.focusedRoundId) return;
    const target = document.getElementById(
      `evaluation-round-${loaderData.focusedRoundId}`,
    );
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  }, [loaderData.focusedRoundId]);
  const committedWarning = Boolean(
    actionData && "committed" in actionData && actionData.committed === true,
  );
  const assignmentUndo =
    actionData &&
    "undoOperationId" in actionData &&
    actionData.undoOperationId &&
    actionData.undoExpiresAt
      ? {
          operationId: actionData.undoOperationId,
          expiresAt: actionData.undoExpiresAt,
        }
      : null;
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [noReviewOverrideConfirmed, setNoReviewOverrideConfirmed] =
    useState(false);
  const [moderationSubmissionId, setModerationSubmissionId] = useState<
    string | null
  >(null);
  const [reopenAssignmentId, setReopenAssignmentId] = useState<string | null>(
    null,
  );
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkAssignPreview, setBulkAssignPreview] = useState(false);
  const [bulkAssignmentTarget, setBulkAssignmentTarget] = useState("");
  const [invitationRole, setInvitationRole] = useState<
    "evaluator" | "committee_chair"
  >("evaluator");
  const [bulkSubmissionIds, setBulkSubmissionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const selected = loaderData.submissions.find(
    (submission) => submission.id === decisionId,
  );
  const selectedHasCompletedReview = selected
    ? loaderData.assignments.some(
        (assignment) =>
          assignment.submissionId === selected.id &&
          (assignment.reviewStatus === "submitted" ||
            assignment.reviewStatus === "locked"),
      )
    : false;
  const activeRound = loaderData.plan?.rounds.find(
    (round) => round.status === "active",
  );
  const nextRound = activeRound
    ? loaderData.plan?.rounds.find(
        (round) =>
          round.status === "draft" &&
          round.roundNumber === activeRound.roundNumber + 1,
      )
    : null;
  const activeRoundAssignments = activeRound
    ? loaderData.assignments.filter(
        (assignment) => assignment.roundId === activeRound.id,
      )
    : [];
  const sessionReviewAssignments = activeRoundAssignments.filter(
    (assignment) => assignment.targetType === "session",
  );
  const unfinishedAssignmentCount = activeRoundAssignments.filter(
    (assignment) =>
      assignment.status === "assigned" ||
      assignment.status === "in_progress" ||
      assignment.status === "reopened",
  ).length;
  const advanceableSubmissions = loaderData.submissions.filter(
    (submission) =>
      ["assigned", "in_review", "decision_ready"].includes(submission.status) &&
      activeRoundAssignments.some(
        (assignment) =>
          assignment.submissionId === submission.id &&
          (assignment.reviewStatus === "submitted" ||
            assignment.reviewStatus === "locked"),
      ),
  );
  const assignmentTargets = [
    ...loaderData.teams
      .filter(
        (team) => team.status === "active" && team.eligibleMemberCount > 0,
      )
      .map((team) => ({
        value: `team:${team.id}`,
        label: `${team.name} (${team.eligibleMemberCount})`,
        kind: "Teams",
      })),
    ...loaderData.evaluators.map((evaluator) => ({
      value: `person:${evaluator.id}`,
      label: evaluator.name,
      kind: "Individuals",
    })),
  ];
  const bulkAssignableSubmissions = loaderData.submissions.filter(
    (submission) =>
      ["submitted", "assigned", "in_review"].includes(submission.status),
  );
  const bulkSelectedSubmissions = bulkAssignableSubmissions.filter(
    (submission) => bulkSubmissionIds.has(submission.id),
  );
  const bulkAssignmentTargetLabel = assignmentTargets.find(
    (target) => target.value === bulkAssignmentTarget,
  )?.label;
  const moderationSubmission = loaderData.submissions.find(
    (submission) => submission.id === moderationSubmissionId,
  );
  const currentModeration = activeRound
    ? loaderData.moderations.find(
        (moderation) =>
          moderation.roundId === activeRound.id &&
          moderation.submissionId === moderationSubmissionId,
      )
    : null;
  const reopenAssignment = loaderData.assignments.find(
    (assignment) => assignment.id === reopenAssignmentId,
  );
  return {
    loaderData,
    actionData,
    navigation,
    committedWarning,
    assignmentUndo,
    decisionId,
    setDecisionId,
    noReviewOverrideConfirmed,
    setNoReviewOverrideConfirmed,
    moderationSubmissionId,
    setModerationSubmissionId,
    reopenAssignmentId,
    setReopenAssignmentId,
    advanceOpen,
    setAdvanceOpen,
    bulkAssignOpen,
    setBulkAssignOpen,
    bulkAssignPreview,
    setBulkAssignPreview,
    bulkAssignmentTarget,
    setBulkAssignmentTarget,
    invitationRole,
    setInvitationRole,
    bulkSubmissionIds,
    setBulkSubmissionIds,
    selected,
    selectedHasCompletedReview,
    activeRound,
    nextRound,
    activeRoundAssignments,
    sessionReviewAssignments,
    unfinishedAssignmentCount,
    advanceableSubmissions,
    assignmentTargets,
    bulkAssignableSubmissions,
    bulkSelectedSubmissions,
    bulkAssignmentTargetLabel,
    moderationSubmission,
    currentModeration,
    reopenAssignment,
  };
}

const EvaluationAdminModelContext = createContext<ReturnType<
  typeof useEvaluationAdminState
> | null>(null);

function useEvaluationAdminModel() {
  const model = useContext(EvaluationAdminModelContext);
  if (!model)
    throw new Error("Evaluation administration model is unavailable.");
  return model;
}

function EvaluationMetrics() {
  const { loaderData } = useEvaluationAdminModel();
  const plan = loaderData.plan;
  if (!plan) return null;
  return (
    <div className="grid grid-4 mb">
      <section className="card metric">
        <span className="label">Plan</span>
        <strong className="value" style={{ fontSize: 18 }}>
          {plan.name}
        </strong>
      </section>
      <section className="card metric">
        <span className="label">Rounds</span>
        <strong className="value">{plan.rounds.length}</strong>
      </section>
      <section className="card metric">
        <span className="label">Evaluators</span>
        <strong className="value">{loaderData.evaluators.length}</strong>
      </section>
      <section className="card metric">
        <span className="label">Submissions</span>
        <strong className="value">{loaderData.submissions.length}</strong>
      </section>
    </div>
  );
}

function EvaluationTeamsPanel() {
  const { loaderData, navigation, invitationRole, setInvitationRole } =
    useEvaluationAdminModel();
  return (
    <section className="card pad mb">
      <div className="card-title">
        <div>
          <h2>Evaluation teams</h2>
          <p className="subtle">
            Team assignments expand to each active member and preserve the team
            on the assignment audit trail.
          </p>
        </div>
        <span className="status info right">{loaderData.teams.length}</span>
      </div>
      <details className="card pad mb">
        <summary>Manage evaluation access</summary>
        <div className="stack mt">
          <p className="help">
            Access is granted only after the recipient uses the sign-in link.
            Unaccepted invitations expire after seven days and can be resent
            with the same email address.
          </p>
          <Form method="post" className="grid grid-3">
            <input
              type="hidden"
              name="intent"
              value="invite-evaluation-member"
            />
            <label className="label">
              Name
              <input className="input" name="name" required />
            </label>
            <label className="label">
              Email
              <input className="input" name="email" type="email" required />
            </label>
            <label className="label">
              Access role
              <select
                className="select"
                name="role"
                value={invitationRole}
                onChange={(event) =>
                  setInvitationRole(
                    event.currentTarget.value as typeof invitationRole,
                  )
                }
              >
                <option value="evaluator">Evaluator</option>
                {loaderData.canManageEvaluationAccess ? (
                  <option value="committee_chair">Committee chair</option>
                ) : null}
              </select>
            </label>
            <label className="label">
              Team after evaluator acceptance
              <select
                className="select"
                name="teamId"
                disabled={invitationRole === "committee_chair"}
              >
                <option value="">No team yet</option>
                {loaderData.teams
                  .filter((team) => team.status === "active")
                  .map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className="btn primary"
              disabled={navigation.state !== "idle"}
            >
              Send invitation
            </button>
          </Form>
          {loaderData.evaluationInvitations.length ? (
            <div>
              <strong>Unaccepted invitations</strong>
              <ul className="list-clean mt">
                {loaderData.evaluationInvitations.map((invitation) => (
                  <li key={invitation.id}>
                    <span>
                      <strong>{invitation.name}</strong>
                      <small className="subtle">
                        {invitation.email} ·{" "}
                        {invitation.role.replaceAll("_", " ")} ·{" "}
                        {invitation.status}
                        {invitation.expiresAt ? (
                          <>
                            {" "}
                            · expires{" "}
                            <EventDateTime
                              epochSeconds={invitation.expiresAt}
                              timeZone={loaderData.eventTimezone}
                              showTimeZone
                            />
                          </>
                        ) : null}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {loaderData.canManageEvaluationAccess &&
          loaderData.evaluators.length ? (
            <div>
              <strong>Active evaluation participants</strong>
              <ul className="list-clean mt">
                {loaderData.evaluators.map((evaluator) => (
                  <li key={evaluator.id}>
                    <span>
                      <strong>{evaluator.name}</strong>
                      <small className="subtle">
                        {evaluator.email} ·{" "}
                        {evaluator.role.replaceAll("_", " ")}
                      </small>
                    </span>
                    <Form
                      method="post"
                      onSubmit={(event) => {
                        const effect =
                          evaluator.role === "committee_chair"
                            ? "Revoke committee-chair access and clear their named team-chair positions?"
                            : "Promote this evaluator to committee chair immediately?";
                        if (!window.confirm(effect)) event.preventDefault();
                      }}
                    >
                      <input
                        type="hidden"
                        name="intent"
                        value="change-chair-access"
                      />
                      <input
                        type="hidden"
                        name="personId"
                        value={evaluator.id}
                      />
                      <input type="hidden" name="confirmed" value="true" />
                      <button
                        className={`btn small ${
                          evaluator.role === "committee_chair" ? "danger" : ""
                        }`}
                        name="operation"
                        value={
                          evaluator.role === "committee_chair"
                            ? "revoke"
                            : "promote"
                        }
                        disabled={navigation.state !== "idle"}
                      >
                        {evaluator.role === "committee_chair"
                          ? "Revoke chair"
                          : "Promote to chair"}
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </details>
      <div className="grid grid-3 mb">
        {loaderData.teams.map((team) => (
          <article className="card pad" key={team.id}>
            <div className="card-title">
              <h3>{team.name}</h3>
              <span
                className={`status ${team.status === "active" ? "success" : "neutral"}`}
              >
                {team.status}
              </span>
            </div>
            <p className="subtle">
              {team.description || "No team description"}
            </p>
            {team.members.length ? (
              <ul className="list-clean">
                {team.members.map((member) => (
                  <li key={member.personId}>
                    <span>
                      <strong>{member.name}</strong>
                      <small className="subtle">
                        {member.role.replaceAll("_", " ")}
                        {member.authorised ? "" : " · event access inactive"}
                      </small>
                    </span>
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="change-team-member"
                      />
                      <input type="hidden" name="teamId" value={team.id} />
                      <input
                        type="hidden"
                        name="personId"
                        value={member.personId}
                      />
                      <input
                        type="hidden"
                        name="memberRole"
                        value={member.role}
                      />
                      <button
                        className="btn small"
                        name="operation"
                        value="remove"
                        disabled={navigation.state !== "idle"}
                      >
                        Remove
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="help">No active members.</p>
            )}
            {team.status === "active" && loaderData.evaluators.length ? (
              <Form method="post" className="stack mt">
                <input type="hidden" name="intent" value="change-team-member" />
                <input type="hidden" name="teamId" value={team.id} />
                <select
                  className="select"
                  name="personId"
                  aria-label={`Member for ${team.name}`}
                >
                  {loaderData.evaluators.map((evaluator) => (
                    <option key={evaluator.id} value={evaluator.id}>
                      {evaluator.name}
                    </option>
                  ))}
                </select>
                <select
                  className="select"
                  name="memberRole"
                  aria-label={`Role in ${team.name}`}
                >
                  <option value="evaluator">Evaluator</option>
                  <option value="chair">Chair</option>
                </select>
                <button
                  className="btn small"
                  name="operation"
                  value="add"
                  disabled={navigation.state !== "idle"}
                >
                  Add or update member
                </button>
              </Form>
            ) : null}
            <details className="mt">
              <summary>Edit team</summary>
              <Form method="post" className="stack mt">
                <input type="hidden" name="intent" value="save-team" />
                <input type="hidden" name="teamId" value={team.id} />
                <label className="label">
                  Name
                  <input
                    className="input"
                    name="name"
                    defaultValue={team.name}
                    required
                  />
                </label>
                <label className="label">
                  Description
                  <textarea
                    className="textarea"
                    name="description"
                    defaultValue={team.description ?? ""}
                  />
                </label>
                <label className="label">
                  Named chair
                  <select
                    className="select"
                    name="chairPersonId"
                    defaultValue={team.chairPersonId ?? ""}
                  >
                    <option value="">No named chair</option>
                    {loaderData.evaluators
                      .filter(
                        (evaluator) => evaluator.role === "committee_chair",
                      )
                      .map((evaluator) => (
                        <option key={evaluator.id} value={evaluator.id}>
                          {evaluator.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="label">
                  Status
                  <select
                    className="select"
                    name="status"
                    defaultValue={team.status}
                  >
                    <option value="active">Active</option>
                    <option value="archived">Archived</option>
                  </select>
                </label>
                <button className="btn" disabled={navigation.state !== "idle"}>
                  Save team
                </button>
              </Form>
            </details>
          </article>
        ))}
      </div>
      <details>
        <summary>Create evaluation team</summary>
        <Form method="post" className="stack mt">
          <input type="hidden" name="intent" value="save-team" />
          <input type="hidden" name="status" value="active" />
          <label className="label">
            Team name
            <input className="input" name="name" required />
          </label>
          <label className="label">
            Description
            <textarea className="textarea" name="description" />
          </label>
          <label className="label">
            Named chair
            <select className="select" name="chairPersonId">
              <option value="">No named chair</option>
              {loaderData.evaluators
                .filter((evaluator) => evaluator.role === "committee_chair")
                .map((evaluator) => (
                  <option key={evaluator.id} value={evaluator.id}>
                    {evaluator.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            className="btn primary"
            disabled={navigation.state !== "idle"}
          >
            Create team
          </button>
        </Form>
      </details>
    </section>
  );
}

function EvaluationRoundsPanel() {
  const { loaderData, navigation } = useEvaluationAdminModel();
  const plan = loaderData.plan;
  if (!plan) return null;
  return (
    <div className="grid grid-3 mb">
      {plan.rounds.map((round) => (
        <section
          id={`evaluation-round-${round.id}`}
          className="card pad"
          key={round.id}
          tabIndex={round.id === loaderData.focusedRoundId ? -1 : undefined}
        >
          <div className="card-title">
            <h2>Round {round.roundNumber}</h2>
            <span
              className={`status ${round.status === "active" ? "success" : "info"}`}
            >
              {round.status}
            </span>
          </div>
          <h3>{round.name}</h3>
          {round.criteria.map((criterion) => (
            <div className="progress-row" key={criterion.id}>
              <span>
                <span>{criterion.name}</span>
                <small className="subtle">
                  {" · Response: "}
                  {criterion.inputType === "scale_5"
                    ? "Score 1–5"
                    : criterion.inputType === "scale_10"
                      ? "Score 1–10"
                      : criterion.inputType === "yes_no"
                        ? "Yes / no"
                        : "Free text"}
                </small>
              </span>
              {criterion.weightPercent > 0 ? (
                <>
                  <div className="progress">
                    <span style={{ width: `${criterion.weightPercent}%` }} />
                  </div>
                  <b>{criterion.weightPercent}%</b>
                </>
              ) : (
                <span className="help">unweighted</span>
              )}
            </div>
          ))}
          {round.status === "draft" ? (
            <details className="mt">
              <summary>Edit draft round and rubric</summary>
              <Form method="post" className="stack mt">
                <input type="hidden" name="intent" value="update-draft-round" />
                <input type="hidden" name="roundId" value={round.id} />
                <input
                  type="hidden"
                  name="roundRevision"
                  value={round.revision}
                />
                <label className="label">
                  Round name
                  <input
                    className="input"
                    name="name"
                    defaultValue={round.name}
                    required
                  />
                </label>
                <RubricFields criteria={round.criteria} />
                <button className="btn" disabled={navigation.state !== "idle"}>
                  Save draft round
                </button>
              </Form>
            </details>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function EvaluationProgressionPanel() {
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

function EvaluationSubmissionQueue() {
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

function AcceptedSpeakerInvitationsPanel() {
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

function EvaluationSessionQueue() {
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

function EvaluationModerationPanel() {
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

function EvaluationPlanState() {
  const { loaderData, navigation } = useEvaluationAdminModel();
  return !loaderData.plan ? (
    <section className="card pad">
      <h2>Create the evaluation plan</h2>
      <p className="subtle">
        Configure the first review round and its weighted rubric. Active round
        rubrics become protected once assignments exist.
      </p>
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="create-plan" />
        <label className="label">
          Plan name
          <input
            className="input"
            name="planName"
            defaultValue="Programme committee review"
            required
          />
        </label>
        <label className="label">
          First round name
          <input
            className="input"
            name="roundName"
            defaultValue="Initial review"
            required
          />
        </label>
        <label className="validation-item">
          <input type="checkbox" name="anonymous" value="true" />
          <span>
            <strong>Blind speaker identity context</strong>
            Speaker names and email addresses are omitted from reviewer
            workspaces for every round. Administrator-only form answers are
            always excluded, whether identity blinding is on or off.
          </span>
        </label>
        {loaderData.canManageEvaluationAccess ? (
          <label className="label">
            Final decision authority
            <select className="select" name="decisionRole">
              <option value="administrator">Owners and administrators</option>
              <option value="committee_chair">
                Owners, administrators and committee chairs
              </option>
            </select>
          </label>
        ) : (
          <div className="validation-item">
            <input type="hidden" name="decisionRole" value="administrator" />
            <strong>Final decisions remain administrator-only</strong>
            <span>
              An owner or administrator must explicitly grant final decision
              authority to committee chairs.
            </span>
          </div>
        )}
        <RubricFields
          criteria={defaultRubric.map((criterion) => ({
            ...criterion,
            description: criterion.description,
          }))}
        />
        <button className="btn primary" disabled={navigation.state !== "idle"}>
          Create review plan
        </button>
      </Form>
    </section>
  ) : (
    <>
      <EvaluationMetrics />
      <EvaluationTeamsPanel />
      <EvaluationRoundsPanel />
      <EvaluationProgressionPanel />
      <EvaluationSubmissionQueue />
      <AcceptedSpeakerInvitationsPanel />
      <EvaluationSessionQueue />
      <EvaluationModerationPanel />
    </>
  );
}

function EvaluationHeader() {
  const {
    loaderData,
    actionData,
    navigation,
    committedWarning,
    assignmentUndo,
    decisionId,
    setDecisionId,
    noReviewOverrideConfirmed,
    setNoReviewOverrideConfirmed,
    moderationSubmissionId,
    setModerationSubmissionId,
    reopenAssignmentId,
    setReopenAssignmentId,
    advanceOpen,
    setAdvanceOpen,
    bulkAssignOpen,
    setBulkAssignOpen,
    bulkAssignPreview,
    setBulkAssignPreview,
    bulkAssignmentTarget,
    setBulkAssignmentTarget,
    invitationRole,
    setInvitationRole,
    bulkSubmissionIds,
    setBulkSubmissionIds,
    selected,
    selectedHasCompletedReview,
    activeRound,
    nextRound,
    activeRoundAssignments,
    sessionReviewAssignments,
    unfinishedAssignmentCount,
    advanceableSubmissions,
    assignmentTargets,
    bulkAssignableSubmissions,
    bulkSelectedSubmissions,
    bulkAssignmentTargetLabel,
    moderationSubmission,
    currentModeration,
    reopenAssignment,
  } = useEvaluationAdminModel();
  return (
    <div className="page-head">
      <div>
        <h1>Evaluation</h1>
        <p>
          Configure review, assign evaluators and release programme decisions.
        </p>
      </div>
      <div className="page-actions">
        <Link className="btn" to="/review/workbench">
          Open reviewer workspace
        </Link>
      </div>
    </div>
  );
}

function EvaluationFilterNotice() {
  const { loaderData } = useEvaluationAdminModel();
  return loaderData.unassignedOnly ? (
    <div className="validation-item warn card pad mb" role="status">
      <strong>Unassigned proposals</strong>
      <span>
        Showing {loaderData.submissions.length} of{" "}
        {loaderData.totalSubmissionCount} submitted records.{" "}
        <Link to="/admin/review">Clear filter</Link>
      </span>
    </div>
  ) : null;
}

function EvaluationActionNotice() {
  const { actionData, committedWarning } = useEvaluationAdminModel();
  return actionData &&
    ("error" in actionData || ("ok" in actionData && !actionData.ok)) ? (
    <div
      className={`validation-item ${committedWarning ? "warn" : "error"} mb`}
      role={committedWarning ? "status" : "alert"}
    >
      {"error" in actionData ? actionData.error : actionData.message}
    </div>
  ) : actionData?.message ? (
    <div className="validation-item ok mb" role="status">
      {actionData.message}
    </div>
  ) : null;
}

function EvaluationAssignmentUndo() {
  const { assignmentUndo } = useEvaluationAdminModel();
  return assignmentUndo ? (
    <div className="validation-item warn mb" role="status">
      <span>
        This assignment change is reversible for five minutes if no review work
        starts.
      </span>
      <Form method="post" className="right">
        <input type="hidden" name="intent" value="undo-assignments" />
        <input
          type="hidden"
          name="operationId"
          value={assignmentUndo.operationId}
        />
        <input type="hidden" name="confirmed" value="true" />
        <button className="btn small" type="submit">
          Undo assignments
        </button>
      </Form>
    </div>
  ) : null;
}

function BulkAssignmentDialog() {
  const {
    navigation,
    bulkAssignOpen,
    setBulkAssignOpen,
    bulkAssignPreview,
    setBulkAssignPreview,
    bulkAssignmentTarget,
    setBulkAssignmentTarget,
    bulkSubmissionIds,
    setBulkSubmissionIds,
    activeRound,
    assignmentTargets,
    bulkAssignableSubmissions,
    bulkSelectedSubmissions,
    bulkAssignmentTargetLabel,
  } = useEvaluationAdminModel();
  return bulkAssignOpen && activeRound ? (
    <Dialog
      title={
        bulkAssignPreview ? "Confirm bulk assignment" : "Bulk assign reviewers"
      }
      onClose={() => setBulkAssignOpen(false)}
      footer={null}
    >
      {bulkAssignPreview ? (
        <Form
          method="post"
          className="stack"
          onSubmit={() => setBulkAssignOpen(false)}
        >
          <input type="hidden" name="intent" value="assign" />
          <input type="hidden" name="roundId" value={activeRound.id} />
          <input type="hidden" name="targetType" value="submission" />
          <input
            type="hidden"
            name="assignmentTarget"
            value={bulkAssignmentTarget}
          />
          {bulkSelectedSubmissions.map((submission) => (
            <input
              key={submission.id}
              type="hidden"
              name="targetId"
              value={submission.id}
            />
          ))}
          <div className="validation-item warn">
            <strong>
              Assign {bulkAssignmentTargetLabel} to{" "}
              {bulkSelectedSubmissions.length} submission
              {bulkSelectedSubmissions.length === 1 ? "" : "s"}
            </strong>
            <span>
              One assignment is created per eligible reviewer and proposal.
              Existing matching assignments stay unchanged. New untouched
              assignments can be undone for five minutes.
            </span>
          </div>
          <ul>
            {bulkSelectedSubmissions.map((submission) => (
              <li key={submission.id}>
                <strong>{submission.title}</strong> · {submission.reference}
              </li>
            ))}
          </ul>
          <div className="page-actions">
            <button
              type="button"
              className="btn"
              onClick={() => setBulkAssignPreview(false)}
            >
              Back
            </button>
            <button
              className="btn primary"
              disabled={navigation.state !== "idle"}
            >
              Confirm assignments
            </button>
          </div>
        </Form>
      ) : (
        <div className="stack">
          <label className="label">
            Evaluator or team
            <select
              className="select"
              value={bulkAssignmentTarget}
              onChange={(event) =>
                setBulkAssignmentTarget(event.currentTarget.value)
              }
            >
              {(["Teams", "Individuals"] as const).map((kind) => {
                const targets = assignmentTargets.filter(
                  (target) => target.kind === kind,
                );
                return targets.length ? (
                  <optgroup label={kind} key={kind}>
                    {targets.map((target) => (
                      <option key={target.value} value={target.value}>
                        {target.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </label>
          <fieldset className="stack">
            <legend className="label">Affected submissions</legend>
            <div className="page-actions">
              <button
                type="button"
                className="btn small"
                onClick={() =>
                  setBulkSubmissionIds(
                    new Set(
                      bulkAssignableSubmissions.map(
                        (submission) => submission.id,
                      ),
                    ),
                  )
                }
              >
                Select all
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => setBulkSubmissionIds(new Set())}
              >
                Clear
              </button>
            </div>
            {bulkAssignableSubmissions.map((submission) => (
              <label key={submission.id} className="validation-item">
                <input
                  type="checkbox"
                  checked={bulkSubmissionIds.has(submission.id)}
                  onChange={(event) => {
                    const next = new Set(bulkSubmissionIds);
                    if (event.currentTarget.checked) next.add(submission.id);
                    else next.delete(submission.id);
                    setBulkSubmissionIds(next);
                  }}
                />
                <span>
                  <strong>{submission.title}</strong>
                  <small className="subtle">
                    {submission.reference} ·{" "}
                    {submission.status.replaceAll("_", " ")}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="btn primary"
            disabled={
              bulkSubmissionIds.size === 0 || !bulkAssignmentTargetLabel
            }
            onClick={() => setBulkAssignPreview(true)}
          >
            Preview {bulkSubmissionIds.size} assignment target
            {bulkSubmissionIds.size === 1 ? "" : "s"}
          </button>
        </div>
      )}
    </Dialog>
  ) : null;
}

function RoundAdvancementDialog() {
  const {
    navigation,
    advanceOpen,
    setAdvanceOpen,
    activeRound,
    nextRound,
    advanceableSubmissions,
    assignmentTargets,
  } = useEvaluationAdminModel();
  return advanceOpen && activeRound && nextRound ? (
    <Dialog
      title={`Advance to ${nextRound.name}`}
      onClose={() => setAdvanceOpen(false)}
      footer={null}
    >
      <Form
        method="post"
        className="stack"
        onSubmit={() => setAdvanceOpen(false)}
      >
        <input type="hidden" name="intent" value="advance-round" />
        <input type="hidden" name="fromRoundId" value={activeRound.id} />
        <input
          type="hidden"
          name="fromRoundRevision"
          value={activeRound.revision}
        />
        <input type="hidden" name="toRoundId" value={nextRound.id} />
        <input
          type="hidden"
          name="toRoundRevision"
          value={nextRound.revision}
        />
        <input type="hidden" name="confirmed" value="true" />
        <fieldset className="stack">
          <legend className="label">Shortlist to advance</legend>
          {advanceableSubmissions.map((submission) => (
            <label key={submission.id} className="validation-item">
              <input
                type="checkbox"
                name="submissionId"
                value={submission.id}
              />
              <span>
                <strong>{submission.title}</strong>
                <small className="subtle">
                  {submission.reference} · average{" "}
                  {submission.averageScore === null
                    ? "not calculated"
                    : `${Number(submission.averageScore).toFixed(2)} / 5`}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="label">
          Next-round reviewers
          <select className="select" name="assignmentTarget" required>
            {(["Teams", "Individuals"] as const).map((kind) => {
              const targets = assignmentTargets.filter(
                (target) => target.kind === kind,
              );
              return targets.length ? (
                <optgroup label={kind} key={kind}>
                  {targets.map((target) => (
                    <option key={target.value} value={target.value}>
                      {target.label}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </label>
        <div className="validation-item warn">
          <strong>This closes {activeRound.name}</strong>
          <span>
            All submitted reviews in the current round become locked. The next
            round becomes active and only the selected submissions receive new
            assignments. Other current-round proposals leave active review ready
            for a final outcome. This is not an undo action.
          </span>
        </div>
        <button className="btn primary" disabled={navigation.state !== "idle"}>
          Close round and advance shortlist
        </button>
      </Form>
    </Dialog>
  ) : null;
}

function ModerationDialog() {
  const {
    navigation,
    setModerationSubmissionId,
    activeRound,
    activeRoundAssignments,
    moderationSubmission,
    currentModeration,
  } = useEvaluationAdminModel();
  return moderationSubmission && activeRound ? (
    <Dialog
      title={`Moderation · ${moderationSubmission.title}`}
      onClose={() => setModerationSubmissionId(null)}
      footer={null}
    >
      <Form
        method="post"
        className="stack"
        onSubmit={() => setModerationSubmissionId(null)}
      >
        <input type="hidden" name="intent" value="moderate" />
        <input type="hidden" name="roundId" value={activeRound.id} />
        <input
          type="hidden"
          name="submissionId"
          value={moderationSubmission.id}
        />
        <input
          type="hidden"
          name="expectedModerationId"
          value={currentModeration?.id ?? ""}
        />
        <div className="card pad">
          <strong>Submitted reviewer outcomes</strong>
          <ul>
            {activeRoundAssignments
              .filter(
                (assignment) =>
                  assignment.submissionId === moderationSubmission.id &&
                  (assignment.reviewStatus === "submitted" ||
                    assignment.reviewStatus === "locked"),
              )
              .map((assignment) => (
                <li key={assignment.id}>
                  <strong>{assignment.evaluatorName}</strong>:{" "}
                  {assignment.weightedScore === null
                    ? "unscored"
                    : `${Number(assignment.weightedScore).toFixed(2)} / 5`}
                  {assignment.recommendation
                    ? ` · ${assignment.recommendation.replaceAll("_", " ")}`
                    : ""}
                  {assignment.confidence
                    ? ` · confidence ${assignment.confidence} / 5`
                    : ""}
                  {assignment.privateNotes ? (
                    <small className="subtle">
                      Private notes: {assignment.privateNotes}
                    </small>
                  ) : null}
                  {assignment.submitterFeedback ? (
                    <small className="subtle">
                      Applicant feedback: {assignment.submitterFeedback}
                    </small>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
        <label className="label">
          Moderated recommendation
          <select
            className="select"
            name="recommendation"
            defaultValue={currentModeration?.recommendation ?? "advance"}
          >
            <option value="advance">Advance to next round</option>
            <option value="accept">Accept</option>
            <option value="waitlist">Waitlist</option>
            <option value="reject">Reject</option>
          </select>
        </label>
        <label className="label">
          Moderated score (optional)
          <input
            className="input"
            type="number"
            name="moderatedScore"
            min="1"
            max="5"
            step="0.01"
            defaultValue={currentModeration?.moderatedScore ?? ""}
          />
        </label>
        <label className="label">
          Moderation notes
          <textarea
            className="textarea"
            name="notes"
            required
            defaultValue={currentModeration?.notes ?? ""}
          />
        </label>
        <div className="validation-item warn">
          <strong>Confirmation locks the moderation outcome</strong>
          <span>
            It marks this submission decision-ready. A later correction requires
            another explicitly confirmed moderation or reopening a review, which
            supersedes this outcome.
          </span>
        </div>
        <label className="label">
          <span>
            <input type="checkbox" name="confirmed" value="true" /> I confirm
            this moderation outcome should be locked.
          </span>
        </label>
        <div className="page-actions">
          {currentModeration?.status === "confirmed" ? null : (
            <button
              className="btn"
              name="moderationStatus"
              value="draft"
              disabled={navigation.state !== "idle"}
            >
              Save draft
            </button>
          )}
          <button
            className="btn primary"
            name="moderationStatus"
            value="confirmed"
            disabled={navigation.state !== "idle"}
          >
            Confirm moderation
          </button>
        </div>
      </Form>
    </Dialog>
  ) : null;
}

function ReviewReopenDialog() {
  const { navigation, setReopenAssignmentId, reopenAssignment } =
    useEvaluationAdminModel();
  return reopenAssignment ? (
    <Dialog
      title={`Reopen ${reopenAssignment.evaluatorName}'s review`}
      onClose={() => setReopenAssignmentId(null)}
      footer={null}
    >
      <Form
        method="post"
        className="stack"
        onSubmit={() => setReopenAssignmentId(null)}
      >
        <input type="hidden" name="intent" value="reopen-review" />
        <input type="hidden" name="assignmentId" value={reopenAssignment.id} />
        <input type="hidden" name="confirmed" value="true" />
        <label className="label">
          Reason for reopening
          <textarea
            className="textarea"
            name="reason"
            minLength={10}
            required
          />
        </label>
        <div className="validation-item warn">
          <strong>The submitted snapshot remains immutable</strong>
          <span>
            Reopening creates a new review revision
            {reopenAssignment.targetType === "submission"
              ? " and supersedes any current moderation for this submission. Released decisions cannot be reopened here."
              : ". The frozen session source remains unchanged."}
          </span>
        </div>
        <button className="btn danger" disabled={navigation.state !== "idle"}>
          Reopen review
        </button>
      </Form>
    </Dialog>
  ) : null;
}

function DecisionDialog() {
  const {
    loaderData,
    navigation,
    setDecisionId,
    noReviewOverrideConfirmed,
    setNoReviewOverrideConfirmed,
    selected,
    selectedHasCompletedReview,
  } = useEvaluationAdminModel();
  return selected ? (
    <Dialog
      title={`Decision · ${selected.title}`}
      onClose={() => {
        setDecisionId(null);
        setNoReviewOverrideConfirmed(false);
      }}
      footer={null}
    >
      <Form
        method="post"
        onSubmit={() => setDecisionId(null)}
        className="stack"
      >
        <input type="hidden" name="intent" value="decide" />
        <input type="hidden" name="submissionId" value={selected.id} />
        <label className="label">
          Decision
          <select className="select" name="decision">
            <option value="accepted">Accept</option>
            <option value="waitlisted">Maybe</option>
            <option value="rejected">Reject</option>
          </select>
        </label>
        <label className="label">
          Rationale
          <textarea className="textarea" name="rationale" />
        </label>
        <label className="speaker-confirm">
          <input
            type="checkbox"
            name="includeReviewerFeedback"
            value="true"
            disabled={!selectedHasCompletedReview}
          />{" "}
          Include submitted reviewer feedback in the decision email
        </label>
        <span className="help">
          Only applicant-facing feedback from submitted or locked reviews in the
          latest completed round is included. Private reviewer notes are never
          sent. Decision templates can render the rationale and selected
          feedback with {"{{decision.rationale}}"} and {"{{decision.feedback}}"}
          .
        </span>
        <label className="label">
          Acceptance session duration (minutes)
          <input
            className="input"
            type="number"
            name="sessionDurationMinutes"
            min="5"
            max="1440"
            defaultValue="60"
            required
          />
          <span className="help">
            Used only when an accepted decision is released. This explicit value
            becomes the unscheduled session duration.
          </span>
        </label>
        <div className="card pad">
          <strong>Effect preview</strong>
          <ul>
            <li>
              {selectedHasCompletedReview
                ? "A released decision is linked to the latest completed review round; reviewer scores and moderation remain unchanged."
                : "A released decision is recorded as an audited administrator override without round-level review evidence."}
            </li>
            <li>
              Releasing an acceptance creates a linked unscheduled session,
              speaker relationships and the configured automatic onboarding task
              plan; saving a decision draft does not.
            </li>
            <li>
              Release cancels every unfinished reviewer assignment for this
              submission. Submitted and locked review evidence remains in the
              audit history.
            </li>
            <li>
              Release updates applicant-visible state and durably records
              notification work before delivery. Saving a draft does neither.
            </li>
          </ul>
        </div>
        {selectedHasCompletedReview ? null : (
          <label className="validation-item warn">
            <input
              type="checkbox"
              name="confirmedWithoutReview"
              value="true"
              checked={noReviewOverrideConfirmed}
              onChange={(event) =>
                setNoReviewOverrideConfirmed(event.currentTarget.checked)
              }
            />
            <span>
              <strong>Confirm review-evidence override</strong>
              No completed review is linked. Releasing now will be audited
              without round-level review evidence.
            </span>
          </label>
        )}
        {selected.unclaimedSpeakerCount > 0 ? (
          <div className="validation-item warn">
            <strong>Co-speaker claim required</strong>
            <span>
              {selected.unclaimedSpeakerCount} co-speaker
              {selected.unclaimedSpeakerCount === 1 ? " has" : "s have"} not
              claimed access. Acceptance cannot be released until every speaker
              is linked to an identity.
            </span>
          </div>
        ) : null}
        {loaderData.canReleaseDecisions ? null : (
          <div className="validation-item warn">
            <strong>Release restricted</strong>
            <span>
              This plan reserves final decisions for owners and administrators.
              You can save a draft for review.
            </span>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            className="btn"
            name="release"
            value="false"
            disabled={navigation.state !== "idle"}
          >
            Save draft
          </button>
          {loaderData.canReleaseDecisions ? (
            <button
              className="btn primary"
              name="release"
              value="true"
              disabled={
                navigation.state !== "idle" ||
                (!selectedHasCompletedReview && !noReviewOverrideConfirmed)
              }
            >
              Release decision
            </button>
          ) : null}
        </div>
      </Form>
    </Dialog>
  ) : null;
}

function EvaluationAdminPage() {
  return (
    <>
      <EvaluationHeader />
      <EvaluationFilterNotice />
      <EvaluationActionNotice />
      <EvaluationAssignmentUndo />
      <EvaluationPlanState />
      <BulkAssignmentDialog />
      <RoundAdvancementDialog />
      <ModerationDialog />
      <ReviewReopenDialog />
      <DecisionDialog />
    </>
  );
}

export default function EvaluationAdmin({ loaderData }: Route.ComponentProps) {
  const model = useEvaluationAdminState(loaderData);
  return (
    <EvaluationAdminModelContext.Provider value={model}>
      <EvaluationAdminPage />
    </EvaluationAdminModelContext.Provider>
  );
}
