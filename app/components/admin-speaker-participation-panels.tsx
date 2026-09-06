import { CalendarClock } from "lucide-react";
import { Form } from "react-router";
import { Button } from "~/components/ui/button";
import type { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { formatEventLocalAvailabilityWindow } from "~/modules/schedule/schedule-time";

import {
  type AdminSpeakerDetailLoaderData,
  formatTimestamp,
} from "./admin-speaker-detail-presentation";

export function AdminSpeakerAvailabilityPanel({
  detail,
  availability,
  busy,
  confirmAction,
}: {
  detail: AdminSpeakerDetailLoaderData["detail"];
  availability: AdminSpeakerDetailLoaderData["availability"];
  busy: boolean;
  confirmAction: ReturnType<typeof useConfirm>["confirm"];
}) {
  const { event } = detail;
  return (
    <section className="crm-record-section" id="availability">
      <h2>Speaker availability</h2>
      <p className="subtle">
        Speakers record these unavailable times in {event.timezone}. The private
        note stays with the speaker.
      </p>
      {availability.windows.length === 0 ? (
        <p className="subtle">No unavailable periods recorded.</p>
      ) : (
        <ul className="stack">
          {availability.windows.map((window) => (
            <li key={window.id} className="stack">
              <p>
                <strong>
                  {formatEventLocalAvailabilityWindow(
                    window.startsAt,
                    window.endsAt,
                    event.timezone,
                  )}
                </strong>
              </p>
              {window.overlappingSessions.length ? (
                <p className="subtle">
                  Overlaps draft sessions:{" "}
                  {window.overlappingSessions
                    .map((session) => session.title)
                    .join(", ")}
                </p>
              ) : (
                <p className="subtle">No overlapping draft sessions.</p>
              )}
              <Form method="post">
                <input
                  type="hidden"
                  name="_intent"
                  value="delete_speaker_blackout"
                />
                <input
                  type="hidden"
                  name="eventRevision"
                  value={availability.event.revision}
                />
                <input type="hidden" name="windowId" value={window.id} />
                <input type="hidden" name="confirmation" value="delete" />
                <Button
                  type="button"
                  disabled={busy}
                  onClick={(clickEvent) => {
                    const form = clickEvent.currentTarget.form;
                    if (!form) return;
                    confirmAction(
                      {
                        title: "Remove this unavailable period?",
                        description:
                          "The speaker can add the same period again. This does not edit the published programme.",
                        records: [
                          formatEventLocalAvailabilityWindow(
                            window.startsAt,
                            window.endsAt,
                            event.timezone,
                          ),
                          ...window.overlappingSessions.map(
                            (session) => `Overlaps “${session.title}”`,
                          ),
                        ],
                        confirmLabel: "Remove period",
                      },
                      () => {
                        form.requestSubmit();
                      },
                    );
                  }}
                >
                  Remove unavailable period
                </Button>
              </Form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AdminSpeakerSessionsPanel({
  detail,
  busy,
  confirmAction,
}: {
  detail: AdminSpeakerDetailLoaderData["detail"];
  busy: boolean;
  confirmAction: ReturnType<typeof useConfirm>["confirm"];
}) {
  const { profile, event, sessions } = detail;
  return (
    <section className="crm-record-section" id="sessions">
      <h2>Linked sessions</h2>
      {sessions.length ? (
        <section
          className="table-wrap pc-responsive-table-wrap"
          aria-label="Linked speaker sessions"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
        >
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Role</th>
                <th scope="col">Participation</th>
                <th scope="col">Status</th>
                <th scope="col">Placement</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td className="pc-record-primary-cell" data-label="Session">
                    <span className="pc-record-identity">
                      <strong>{session.title}</strong>
                      <small>
                        {session.format} · {session.durationMinutes} minutes
                      </small>
                    </span>
                  </td>
                  <td data-label="Role">
                    <span className="pc-record-stack">
                      {session.roles.map((role) => (
                        <span key={role.role}>{role.label}</span>
                      ))}
                    </span>
                  </td>
                  <td data-label="Participation">
                    <span className="pc-speaker-meta">
                      {session.roles.map((role) => (
                        <span className="pc-record-stack" key={role.role}>
                          <span
                            className={`status ${role.participationStatus === "confirmed" ? "success" : role.participationStatus === "declined" ? "danger" : session.status === "cancelled" ? "" : "warning"}`}
                          >
                            {role.label}:{" "}
                            {role.participationStatus === "confirmed"
                              ? "Accepted"
                              : role.participationStatus === "declined"
                                ? "Declined"
                                : session.status === "cancelled"
                                  ? "Not required"
                                  : "Awaiting response"}
                          </span>
                          {role.participationDeclineReason ? (
                            <small>
                              Private reason: {role.participationDeclineReason}
                            </small>
                          ) : null}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td data-label="Status">
                    <DomainStatusBadge
                      domain="session"
                      status={session.status}
                    />
                  </td>
                  <td data-label="Placement">
                    {session.startsAt ? (
                      <div className="pc-record-stack">
                        <span>
                          {formatTimestamp(session.startsAt, event.timezone)}
                        </span>
                        <span className="subtle">
                          {session.roomName ?? "Room to be assigned"}
                        </span>
                      </div>
                    ) : (
                      <span className="subtle">
                        Not placed in the published schedule
                      </span>
                    )}
                  </td>
                  <td data-label="Action">
                    {session.status === "cancelled" ? (
                      <span className="subtle">Session cancelled</span>
                    ) : (
                      <div className="stack">
                        {session.roles.map((role) =>
                          role.participationStatus === "pending" ? (
                            <Form
                              method="post"
                              className="stack"
                              key={`confirm:${role.role}`}
                            >
                              <input
                                type="hidden"
                                name="_intent"
                                value="confirm_external_participation"
                              />
                              <input
                                type="hidden"
                                name="sessionId"
                                value={session.id}
                              />
                              <input
                                type="hidden"
                                name="role"
                                value={role.role}
                              />
                              <input
                                type="hidden"
                                name="roleRevision"
                                value={role.participationRevision}
                              />
                              <label className="check-row">
                                <input
                                  type="checkbox"
                                  name="externalConfirmation"
                                  value="confirmed"
                                  required
                                />
                                <span>
                                  I confirm {profile.name} accepted the{" "}
                                  {role.label.toLowerCase()} role outside
                                  Program Cue.
                                </span>
                              </label>
                              <Button
                                size="small"
                                type="submit"
                                disabled={busy}
                              >
                                Record {role.label.toLowerCase()} acceptance
                              </Button>
                            </Form>
                          ) : role.participationStatus === "declined" ? (
                            <Form
                              method="post"
                              className="stack"
                              key={`reset:${role.role}`}
                            >
                              <input
                                type="hidden"
                                name="_intent"
                                value="reset_declined_participation"
                              />
                              <input
                                type="hidden"
                                name="sessionId"
                                value={session.id}
                              />
                              <input
                                type="hidden"
                                name="role"
                                value={role.role}
                              />
                              <input
                                type="hidden"
                                name="roleRevision"
                                value={role.participationRevision}
                              />
                              <input
                                type="hidden"
                                name="resetConfirmation"
                                value="pending"
                              />
                              <Button
                                size="small"
                                type="button"
                                disabled={busy}
                                onClick={(event) => {
                                  const form = event.currentTarget.form;
                                  if (!form) return;
                                  confirmAction(
                                    {
                                      title: `Reset the ${role.label.toLowerCase()} role?`,
                                      description:
                                        "This clears the private decline reason and lets the participant respond again. No message is sent.",
                                      records: [
                                        session.title,
                                        profile.name,
                                        role.label,
                                      ],
                                      confirmLabel: "Reset role",
                                      tone: "primary",
                                    },
                                    () => form.requestSubmit(),
                                  );
                                }}
                              >
                                Reset {role.label.toLowerCase()}
                              </Button>
                            </Form>
                          ) : null,
                        )}
                        {(["speaker", "moderator", "chair"] as const)
                          .filter(
                            (role) =>
                              !session.roles.some(
                                (assigned) => assigned.role === role,
                              ),
                          )
                          .map((role) => (
                            <Form method="post" key={`add:${role}`}>
                              <input
                                type="hidden"
                                name="_intent"
                                value="add_participant_role"
                              />
                              <input
                                type="hidden"
                                name="sessionId"
                                value={session.id}
                              />
                              <input type="hidden" name="role" value={role} />
                              <input
                                type="hidden"
                                name="confirmation"
                                value="add"
                              />
                              <Button
                                size="small"
                                type="button"
                                disabled={busy}
                                onClick={(event) => {
                                  const form = event.currentTarget.form;
                                  if (!form) return;
                                  const label =
                                    role === "chair"
                                      ? "Chair"
                                      : role === "moderator"
                                        ? "Moderator"
                                        : "Speaker";
                                  confirmAction(
                                    {
                                      title: `Assign the ${label.toLowerCase()} role?`,
                                      description:
                                        "The participant will respond to this role independently from any other role in the session.",
                                      records: [
                                        session.title,
                                        profile.name,
                                        label,
                                      ],
                                      confirmLabel: "Assign role",
                                      tone: "primary",
                                    },
                                    () => form.requestSubmit(),
                                  );
                                }}
                              >
                                Add {role}
                              </Button>
                            </Form>
                          ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <EmptyState
          icon={CalendarClock}
          title="No linked sessions"
          description="Link this speaker from a session in the schedule planner."
        />
      )}
    </section>
  );
}
