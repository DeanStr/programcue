import { Form } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { EventDateTime } from "~/components/ui/event-date-time";

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
      <div
        className="table-wrap pc-responsive-table-wrap"
        role="region"
        aria-label="Speaker access invitations"
        tabIndex={0}
      >
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
