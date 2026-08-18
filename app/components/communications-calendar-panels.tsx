import { CalendarPlus, Link2 } from "lucide-react";
import { Form, Link, useSubmit } from "react-router";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { providerLabel } from "~/lib/provider-labels";
import { shortReference } from "~/lib/short-reference";
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

function connectedProviderConnections(
  connections: CommunicationsCentreLoaderData["connections"],
  personId: string,
) {
  const providers = new Set<string>();
  return connections.filter((connection) => {
    if (
      connection.personId !== personId ||
      connection.status !== "connected" ||
      providers.has(connection.provider)
    ) {
      return false;
    }
    providers.add(connection.provider);
    return true;
  });
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
  const creating =
    !target.invitationId ||
    (target.method === "CANCEL" && target.invitationStatus === "cancelled");
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
      <button type="submit" className="btn small" disabled={working}>
        {method === "CANCEL"
          ? "Cancel invitation"
          : provider === "email_ics"
            ? creating
              ? "Email the invitation"
              : "Email an update"
            : `${creating ? "Send to" : "Update"} ${provider === "google" ? "Google Calendar" : "Microsoft Outlook"}`}
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
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
  return (
    <section className="card pad">
      {dialog}
      <div className="card-title">
        <h2>Calendar connections</h2>
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
        <section
          className="table-wrap mb"
          aria-label="Calendar connections"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Participant</th>
                <th scope="col">Provider</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
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
                          <button
                            type="submit"
                            className="btn small"
                            disabled={working}
                          >
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
                            event.preventDefault();
                            const form = event.currentTarget;
                            confirm(
                              {
                                title: "Disconnect this calendar account?",
                                description:
                                  "Program Cue stops sending and updating invitations through this account. Active direct invitations must be cancelled first.",
                                records: [
                                  `${connection.personName} · ${categoryLabel(connection.provider)} · ${connection.email}`,
                                ],
                                confirmLabel: "Disconnect account",
                                cancelLabel: "Keep connected",
                              },
                              () => submit(form),
                            );
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
                          <button
                            type="submit"
                            className="btn small"
                            disabled={working}
                          >
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
        </section>
      ) : (
        <EmptyState
          className="mb comms-empty"
          icon={Link2}
          title="No calendar account is connected"
          description="Connect Google or Microsoft 365 above to send invitations directly from a participant's own calendar. Email ICS invitations work without a connection."
        />
      )}
      <h3>Published-session invitations</h3>
      {loaderData.calendarTargets.length ? (
        <section
          className="table-wrap pc-responsive-table-wrap"
          aria-label="Published-session calendar invitations"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
        >
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Speaker</th>
                <th scope="col">Current state</th>
                <th scope="col">Explicit lifecycle actions</th>
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
                const providerConnections = connectedProviderConnections(
                  loaderData.connections,
                  target.personId,
                );
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
                            {providerConnections.map((connection) => (
                              <CalendarAction
                                key={connection.id}
                                target={target}
                                method="REQUEST"
                                provider={connection.provider}
                                connectionId={connection.id}
                                working={working}
                              />
                            ))}
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
                            <button
                              type="submit"
                              className="btn small"
                              disabled={working}
                            >
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
        </section>
      ) : (
        <EmptyState
          className="comms-empty"
          headingLevel={4}
          icon={CalendarPlus}
          title="No session invitations to administer"
          description="Publish a scheduled speaker session to administer its invitation."
        />
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
        <ul
          className="comms-activity-list"
          aria-label="Calendar invitation activity"
        >
          {loaderData.invitations.map((invitation) => (
            <li className="comms-activity-row" key={invitation.id}>
              <div className="comms-activity-identity">
                <strong>{invitation.sessionTitle}</strong>
                <small>
                  {invitation.personName} · {invitation.email} ·{" "}
                  {providerLabel(invitation.provider, "Not sent yet")} ·{" "}
                  Calendar reference {shortReference(invitation.icalUid)}
                </small>
              </div>
              <div className="comms-activity-meta">
                <DomainStatusBadge
                  domain="calendarInvitation"
                  status={invitation.status}
                />
                <div>
                  {invitation.method === "CANCEL"
                    ? "Cancellation"
                    : "Invitation"}
                  {invitation.sequenceNumber > 0
                    ? ` · update ${invitation.sequenceNumber}`
                    : ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="comms-activity-empty">
          No calendar operations yet. Published schedule updates will create
          stable-UID calendar operations here.
        </p>
      )}
    </section>
  );
}
