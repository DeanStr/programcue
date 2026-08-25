import { useEffect, useState } from "react";
import { Form, useLocation, useNavigate } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { EventDateTime } from "~/components/ui/event-date-time";

export function EvaluationTeamsPanel() {
  const { loaderData, navigation, invitationRole, setInvitationRole } =
    useEvaluationAdminModel();
  const { confirm, dialog } = useConfirm();
  const location = useLocation();
  const navigate = useNavigate();
  const [accessOpen, setAccessOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: React Router location changes are the trigger for rereading the browser-only fragment after hydration and Back/Forward navigation.
  useEffect(() => {
    // Fragments never reach the server. Read the browser URL after hydration so
    // direct loads match the closed server markup before opening the target.
    setAccessOpen(window.location.hash === "#evaluation-access");
  }, [location.hash]);
  return (
    <section className="card pad mb pc-eval-teams">
      {dialog}
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
      <details
        id="evaluation-access"
        className="card pad mb pc-disclosure"
        open={accessOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setAccessOpen(open);
          if (!open && window.location.hash === "#evaluation-access") {
            void navigate(`${location.pathname}${location.search}`, {
              replace: true,
              preventScrollReset: true,
            });
          }
        }}
      >
        <summary>Manage evaluation access</summary>
        <div className="stack mt">
          <p className="help">
            {loaderData.demoMode
              ? "Exact SBEK fixture identities activate locally after this explicit invitation; no email delivery is claimed. Every other unaccepted invitation expires after seven days."
              : "Access is granted only after the recipient uses the sign-in link. Unaccepted invitations expire after seven days and can be resent with the same email address."}
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
              type="submit"
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
                {loaderData.evaluators.map((evaluator) => {
                  const isChair = evaluator.role === "committee_chair";
                  const chairedTeams = loaderData.teams
                    .filter((team) => team.chairPersonId === evaluator.id)
                    .map((team) => team.name);
                  return (
                    <li key={evaluator.id}>
                      <span>
                        <strong>{evaluator.name}</strong>
                        <small className="subtle">
                          {evaluator.email} ·{" "}
                          {evaluator.role.replaceAll("_", " ")}
                        </small>
                      </span>
                      <Form method="post">
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
                        <input
                          type="hidden"
                          name="operation"
                          value={isChair ? "revoke" : "promote"}
                        />
                        <button
                          type="button"
                          className={`btn small ${isChair ? "danger" : ""}`}
                          disabled={navigation.state !== "idle"}
                          onClick={(event) => {
                            const form = event.currentTarget.form;
                            confirm(
                              isChair
                                ? {
                                    title: "Revoke committee-chair access?",
                                    description: `${evaluator.name} drops back to evaluator access immediately and is cleared from every named team-chair position.`,
                                    records: chairedTeams.length
                                      ? chairedTeams
                                      : undefined,
                                    confirmLabel: "Revoke chair",
                                    tone: "danger",
                                  }
                                : {
                                    title: "Promote to committee chair?",
                                    description: `${evaluator.name} gains committee-chair access immediately, including any decision authority the plan grants to chairs.`,
                                    confirmLabel: "Promote to chair",
                                    tone: "primary",
                                  },
                              () => form?.requestSubmit(),
                            );
                          }}
                        >
                          {isChair ? "Revoke chair" : "Promote to chair"}
                        </button>
                      </Form>
                    </li>
                  );
                })}
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
                        type="submit"
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
                  type="submit"
                  className="btn small"
                  name="operation"
                  value="add"
                  disabled={navigation.state !== "idle"}
                >
                  Add or update member
                </button>
              </Form>
            ) : null}
            <details className="mt pc-disclosure">
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
                <button
                  type="submit"
                  className="btn"
                  disabled={navigation.state !== "idle"}
                >
                  Save team
                </button>
              </Form>
            </details>
          </article>
        ))}
      </div>
      <details className="pc-disclosure">
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
            type="submit"
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
