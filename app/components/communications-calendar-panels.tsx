import { Form, Link } from "react-router";
import type { CommunicationsCentreLoaderData } from "~/routes/communications-centre";
import {
  communicationCategoryLabel as categoryLabel,
  formatCommunicationDate as formatDate,
  type PendingIntent,
} from "./communications-panel-shared";

export function CommunicationRecipientIdentity({
  name,
  email,
}: {
  name: string;
  email: string;
}) {
  return (
    <div className="comms-recipient-identity">
      <div className="comms-recipient-name">
        <strong>{name}</strong>
      </div>
      <div className="comms-recipient-email">
        <small>{email}</small>
      </div>
    </div>
  );
}

function lifecycleKey(
  target: CommunicationsCentreLoaderData["calendarTargets"][number],
  method: "REQUEST" | "CANCEL",
  provider: "email_ics" | "google" | "microsoft",
) {
  return `calendar:${target.invitationId ?? `${target.sessionId}:${target.personId}`}:${(target.sequenceNumber ?? -1) + 1}:${method}:${provider}`;
}

function CalendarAction({
  target,
  method,
  provider,
  connectionId,
  working,
}: {
  target: CommunicationsCentreLoaderData["calendarTargets"][number];
  method: "REQUEST" | "CANCEL";
  provider: "email_ics" | "google" | "microsoft";
  connectionId?: string | null;
  working: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="calendar-lifecycle" />
      <input type="hidden" name="sessionId" value={target.sessionId} />
      <input type="hidden" name="personId" value={target.personId} />
      <input type="hidden" name="method" value={method} />
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="connectionId" value={connectionId ?? ""} />
      <input
        type="hidden"
        name="idempotencyKey"
        value={lifecycleKey(target, method, provider)}
      />
      <button className="btn small" disabled={working}>
        {method === "CANCEL"
          ? "Cancel invitation"
          : provider === "email_ics"
            ? target.invitationId
              ? "Email ICS update"
              : "Send email ICS"
            : `${target.invitationId ? "Update" : "Send to"} ${provider === "google" ? "Google" : "Microsoft"}`}
      </button>
    </Form>
  );
}

export function CalendarAdministration({
  loaderData,
  working,
  pendingIntent,
}: {
  loaderData: CommunicationsCentreLoaderData;
  working: boolean;
  pendingIntent: PendingIntent;
}) {
  return (
    <section className="card pad mt">
      <div className="card-title">
        <h2>Calendar administration</h2>
        <span className="help right">Google, Microsoft 365 and email ICS</span>
      </div>
      <div className="row-actions mb">
        <Link className="btn" to="/oauth/calendar/google">
          Connect my Google Calendar
        </Link>
        <Link className="btn" to="/oauth/calendar/microsoft">
          Connect my Microsoft 365 calendar
        </Link>
      </div>
      {loaderData.connections.length ? (
        <div className="table-wrap mb">
          <table className="data-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.connections.map((connection) => (
                <tr key={connection.id}>
                  <td>
                    {connection.personName}
                    <small>{connection.email}</small>
                  </td>
                  <td>{categoryLabel(connection.provider)}</td>
                  <td>
                    <span
                      className={`status ${connection.status === "connected" ? "success" : connection.status === "needs_attention" ? "danger" : "info"}`}
                    >
                      {categoryLabel(connection.status)}
                    </span>
                    <small>
                      Token expires{" "}
                      {formatDate(
                        connection.expiresAt,
                        loaderData.eventTimezone,
                      )}
                    </small>
                    <small>
                      Last provider sync{" "}
                      {formatDate(
                        connection.lastSyncedAt,
                        loaderData.eventTimezone,
                      )}
                    </small>
                  </td>
                  <td>
                    <div className="row-actions">
                      {connection.status === "connected" ||
                      connection.status === "needs_attention" ? (
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="refresh-calendar"
                          />
                          <input
                            type="hidden"
                            name="connectionId"
                            value={connection.id}
                          />
                          <button className="btn small" disabled={working}>
                            {working && pendingIntent === "refresh-calendar"
                              ? "Refreshing…"
                              : "Refresh token"}
                          </button>
                        </Form>
                      ) : null}
                      {connection.status === "connected" ||
                      connection.status === "needs_attention" ? (
                        <Form
                          method="post"
                          onSubmit={(event) => {
                            if (
                              !window.confirm(
                                "Disconnect this calendar account? Active direct invitations must be cancelled first.",
                              )
                            )
                              event.preventDefault();
                          }}
                        >
                          <input
                            type="hidden"
                            name="intent"
                            value="disconnect-calendar"
                          />
                          <input
                            type="hidden"
                            name="connectionId"
                            value={connection.id}
                          />
                          <button className="btn small" disabled={working}>
                            Disconnect
                          </button>
                        </Form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="help mb">No direct calendar account is connected.</p>
      )}
      <h3>Published-session invitations</h3>
      {loaderData.calendarTargets.length ? (
        <div className="table-wrap pc-responsive-table-wrap">
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Speaker</th>
                <th>Current state</th>
                <th>Explicit lifecycle actions</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.calendarTargets.map((target) => {
                const active =
                  target.invitationId &&
                  target.method !== "CANCEL" &&
                  target.invitationStatus !== "cancelled";
                const providerSelectionAvailable =
                  !target.invitationId ||
                  (target.method === "CANCEL" &&
                    target.invitationStatus === "cancelled");
                return (
                  <tr key={`${target.sessionId}:${target.personId}`}>
                    <td className="pc-record-primary-cell" data-label="Session">
                      {target.sessionTitle}
                    </td>
                    <td data-label="Speaker">
                      <CommunicationRecipientIdentity
                        name={target.personName}
                        email={target.email}
                      />
                    </td>
                    <td data-label="Current state">
                      {target.invitationStatus
                        ? `${target.invitationProvider ?? "pending"} · seq ${target.sequenceNumber} · ${target.invitationStatus}${target.rsvpStatus ? ` · RSVP ${categoryLabel(target.rsvpStatus)}` : ""}`
                        : "Not sent"}
                    </td>
                    <td className="pc-record-action-cell" data-label="Actions">
                      <div className="row-actions">
                        {providerSelectionAvailable ? (
                          <>
                            <CalendarAction
                              target={target}
                              method="REQUEST"
                              provider="email_ics"
                              working={working}
                            />
                            {target.activeProvider &&
                            target.activeConnectionId ? (
                              <CalendarAction
                                target={target}
                                method="REQUEST"
                                provider={target.activeProvider}
                                connectionId={target.activeConnectionId}
                                working={working}
                              />
                            ) : null}
                          </>
                        ) : target.invitationProvider ? (
                          <CalendarAction
                            target={target}
                            method="REQUEST"
                            provider={target.invitationProvider}
                            connectionId={target.invitationConnectionId}
                            working={working}
                          />
                        ) : null}
                        {active && target.invitationProvider ? (
                          <CalendarAction
                            target={target}
                            method="CANCEL"
                            provider={target.invitationProvider}
                            connectionId={target.invitationConnectionId}
                            working={working}
                          />
                        ) : null}
                        {active &&
                        target.invitationId &&
                        target.invitationProvider !== "email_ics" &&
                        (target.invitationStatus === "sent" ||
                          target.invitationStatus === "confirmed") ? (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="reconcile-calendar-rsvp"
                            />
                            <input
                              type="hidden"
                              name="invitationId"
                              value={target.invitationId}
                            />
                            <button className="btn small" disabled={working}>
                              Reconcile RSVP
                            </button>
                          </Form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty compact">
          <p>
            Publish a scheduled speaker session to administer its invitation.
          </p>
        </div>
      )}
    </section>
  );
}

export function CalendarLifecycleTable({
  loaderData,
}: {
  loaderData: CommunicationsCentreLoaderData;
}) {
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Calendar lifecycle</h2>
        <span className="status info right">
          {loaderData.invitations.length}
        </span>
      </div>
      {loaderData.invitations.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Speaker</th>
                <th>Provider</th>
                <th>Lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.invitations.map((invitation) => (
                <tr key={invitation.id}>
                  <td className="pc-record-primary-cell" data-label="Session">
                    {invitation.sessionTitle}
                    <small>{invitation.icalUid}</small>
                  </td>
                  <td data-label="Speaker">
                    <CommunicationRecipientIdentity
                      name={invitation.personName}
                      email={invitation.email}
                    />
                  </td>
                  <td data-label="Provider">
                    {invitation.provider ?? "Pending"}
                  </td>
                  <td data-label="Lifecycle">
                    <span
                      className={`status ${invitation.status === "sent" || invitation.status === "confirmed" ? "success" : invitation.status === "failed" ? "danger" : "info"}`}
                    >
                      {invitation.method} · seq {invitation.sequenceNumber} ·{" "}
                      {invitation.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty compact">
          <p>
            Published schedule updates will create stable-UID calendar
            operations here.
          </p>
        </div>
      )}
    </section>
  );
}
