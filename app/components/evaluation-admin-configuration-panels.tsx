import { Form } from "react-router";

import { EventDateTime } from "~/components/ui/event-date-time";
import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import {
  EvaluationProgressionPanel,
  EvaluationSubmissionQueue,
  AcceptedSpeakerInvitationsPanel,
  EvaluationSessionQueue,
  EvaluationModerationPanel,
} from "~/components/evaluation-admin-queue-panels";

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

export function RubricFields({
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

export function EvaluationMetrics() {
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

export function EvaluationTeamsPanel() {
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

export function EvaluationRoundsPanel() {
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

export function EvaluationPlanState() {
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
