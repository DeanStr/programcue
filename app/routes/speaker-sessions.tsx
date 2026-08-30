import { Mic2 } from "lucide-react";
import { data, Form, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
import { EventFieldReadOnlyValues } from "~/components/event-field-inputs";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
import { Button, ButtonAnchor, ButtonLink } from "~/components/ui/button";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import {
  SpeakerAdminStateError,
  SpeakerService,
} from "~/modules/speakers/speaker-service.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import { notifyRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/speaker-sessions";

export const meta = () => [{ title: "My Sessions · Program Cue" }];

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const form = await request.formData();
  const intent = form.get("intent");
  if (
    intent !== "confirm-participation" &&
    intent !== "decline-participation"
  ) {
    return data(
      { ok: false, message: "Unsupported session action." },
      { status: 400 },
    );
  }
  try {
    const service = new SpeakerService(env);
    const result = await service.respondOwnRole(viewer, {
      sessionId: form.get("sessionId"),
      role: form.get("role"),
      roleRevision: form.get("roleRevision"),
      response: intent === "confirm-participation" ? "confirmed" : "declined",
      reason: form.get("reason") ?? "",
    });
    const realtimeFailure = result.changed
      ? await notifyRouteChange(
          env,
          viewer,
          result.changeSequence,
          result.sessionId,
        )
      : null;
    if (realtimeFailure) return data(realtimeFailure, { status: 207 });
    return data({
      ok: true,
      message:
        intent === "confirm-participation"
          ? `${result.label} role accepted for “${result.title}”.`
          : `You declined the ${result.label.toLowerCase()} role for “${result.title}”.`,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return data(
        {
          ok: false,
          message:
            error.issues[0]?.message ?? "Confirm the selected session again.",
        },
        { status: 422 },
      );
    }
    if (error instanceof SpeakerAdminStateError) {
      return data(
        { ok: false, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function SpeakerSessions(_props: Route.ComponentProps) {
  const { portal } = useSpeakerWorkspace();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { confirm, dialog } = useConfirm();
  const busy = navigation.state !== "idle";
  const sessions = [...portal.sessions].sort((left, right) => {
    const rank = (session: (typeof portal.sessions)[number]) =>
      session.roles.some((role) => role.participationStatus === "pending") &&
      session.status !== "cancelled"
        ? 0
        : 1;
    return rank(left) - rank(right);
  });
  return (
    <>
      {dialog}
      <div className="page-head">
        <div>
          <h1>My sessions</h1>
          <p>Current session details and your role in each session.</p>
        </div>
        <p className="speaker-work-count">
          <b className="pc-num">{portal.sessions.length}</b>
          <span>{portal.sessions.length === 1 ? "session" : "sessions"}</span>
        </p>
      </div>
      <SpeakerActionNotice notice={actionData} />
      <section className="mt speaker-work" id="sessions">
        <h2 className="sr-only">Session list</h2>
        {sessions.length ? (
          <div className="speaker-work-list">
            {sessions.map((session) => {
              const pendingRoles = session.roles.filter(
                (role) => role.participationStatus === "pending",
              );
              return (
                <article
                  className="speaker-session-card"
                  data-state={
                    session.participationStatus === "confirmed"
                      ? "confirmed"
                      : session.participationStatus === "declined"
                        ? "declined"
                        : session.status === "cancelled"
                          ? "cancelled"
                          : "pending"
                  }
                  key={session.id}
                >
                  <div className="speaker-session-row">
                    <Mic2 aria-hidden className="pc-index-icon" />
                    <div className="speaker-session-copy">
                      <div className="speaker-task-title-row">
                        <h3>{session.title}</h3>
                        <DomainStatusBadge
                          domain="session"
                          status={
                            session.status === "scheduled" && !session.startsAt
                              ? "unscheduled"
                              : session.status
                          }
                        />
                      </div>
                      {session.description ? (
                        <p className="speaker-task-desc">
                          {session.description}
                        </p>
                      ) : null}
                      <p className="speaker-task-meta">
                        <span>
                          {session.roles
                            .map((role) => role.label)
                            .join(" · ") ||
                            session.roleLabel ||
                            "Speaker"}
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span>{session.format}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{session.trackName ?? "No track assigned"}</span>
                        <span aria-hidden="true"> · </span>
                        <span>
                          {session.startsAt ? (
                            <EventDateTime
                              epochSeconds={session.startsAt}
                              timeZone={portal.event.timezone}
                              showTimeZone
                            />
                          ) : (
                            "Scheduling pending"
                          )}
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span>{session.roomName ?? "To be confirmed"}</span>
                        <span aria-hidden="true"> · </span>
                        <span className="pc-num">
                          {session.durationMinutes} min
                        </span>
                      </p>
                      {session.customFields.length ? (
                        <div className="speaker-session-participants">
                          <strong>Additional session information</strong>
                          <EventFieldReadOnlyValues
                            fields={session.customFields}
                          />
                        </div>
                      ) : null}
                      {session.participants.length ? (
                        <div className="speaker-session-participants">
                          <strong>Other session participants</strong>
                          <ul>
                            {session.participants.map((participant) => (
                              <li key={`${session.id}:${participant.position}`}>
                                <span>{participant.name ?? "Participant"}</span>
                                <small>
                                  {participant.roles
                                    .map(
                                      (role) =>
                                        `${role.label}: ${
                                          role.participationStatus ===
                                          "confirmed"
                                            ? "Confirmed"
                                            : "Awaiting response"
                                        }`,
                                    )
                                    .join(" · ")}
                                </small>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                    <div className="speaker-session-measure">
                      <span
                        className={`status ${session.participationStatus === "confirmed" ? "success" : session.participationStatus === "declined" ? "danger" : session.status === "cancelled" ? "" : "warning"}`}
                      >
                        {session.status === "cancelled"
                          ? "Not required"
                          : pendingRoles.length
                            ? `${pendingRoles.length} ${pendingRoles.length === 1 ? "role" : "roles"} need a response`
                            : session.roles.some(
                                  (role) =>
                                    role.participationStatus === "confirmed",
                                )
                              ? "Responses complete"
                              : "All roles declined"}
                      </span>
                      {session.status !== "cancelled" ? (
                        <div className="speaker-session-confirm stack">
                          {session.roles.map((role) => (
                            <div
                              className="speaker-role-response"
                              key={`${session.id}:${role.role}`}
                            >
                              <strong>{role.label}</strong>
                              {role.participationStatus === "pending" ? (
                                <>
                                  <Form method="post">
                                    <input
                                      type="hidden"
                                      name="intent"
                                      value="confirm-participation"
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
                                    <Button
                                      variant="primary"
                                      type="button"
                                      disabled={busy}
                                      aria-label={`Accept ${role.label} role in ${session.title}`}
                                      onClick={(event) => {
                                        const form = event.currentTarget.form;
                                        if (!form) return;
                                        confirm(
                                          {
                                            title: `Accept the ${role.label.toLowerCase()} role?`,
                                            description:
                                              "This response applies only to this role in the session.",
                                            records: [
                                              session.title,
                                              role.label,
                                            ],
                                            confirmLabel: "Accept role",
                                            tone: "primary",
                                          },
                                          () => form.requestSubmit(),
                                        );
                                      }}
                                    >
                                      Accept role
                                    </Button>
                                  </Form>
                                  <details className="speaker-task-comment">
                                    <summary>Decline this role</summary>
                                    <Form
                                      method="post"
                                      className="speaker-task-comment-form"
                                    >
                                      <input
                                        type="hidden"
                                        name="intent"
                                        value="decline-participation"
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
                                      <label className="label">
                                        Reason (optional)
                                        <textarea
                                          className="textarea"
                                          name="reason"
                                          maxLength={500}
                                          rows={3}
                                          placeholder="Share a short private note with the event team"
                                        />
                                      </label>
                                      <Button
                                        variant="danger"
                                        type="button"
                                        disabled={busy}
                                        onClick={(event) => {
                                          const form = event.currentTarget.form;
                                          if (!form) return;
                                          confirm(
                                            {
                                              title: `Decline the ${role.label.toLowerCase()} role?`,
                                              description:
                                                "Other roles in this session are not changed.",
                                              records: [
                                                session.title,
                                                role.label,
                                              ],
                                              confirmLabel: "Decline role",
                                              tone: "danger",
                                            },
                                            () => form.requestSubmit(),
                                          );
                                        }}
                                      >
                                        Decline role
                                      </Button>
                                    </Form>
                                  </details>
                                </>
                              ) : (
                                <span
                                  className={`status ${role.participationStatus === "confirmed" ? "success" : "danger"}`}
                                >
                                  {role.participationStatus === "confirmed"
                                    ? "Accepted"
                                    : "Declined by you"}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {session.roles.some(
                        (role) => role.participationStatus === "confirmed",
                      ) ? (
                        portal.event.participantSupportUrl ? (
                          <ButtonAnchor
                            size="small"
                            href={portal.event.participantSupportUrl}
                          >
                            Contact the event team to withdraw
                          </ButtonAnchor>
                        ) : (
                          <p className="subtle">
                            Contact the event team if you need to withdraw.
                          </p>
                        )
                      ) : session.roles.every(
                          (role) => role.participationStatus === "declined",
                        ) ? (
                        <p className="subtle">
                          The event team must reset a declined role before you
                          can respond again.
                        </p>
                      ) : null}
                      {session.participationStatus !== "declined" &&
                      session.status !== "cancelled" ? (
                        session.sessionDetailsReviewTaskId ? (
                          <ButtonLink
                            size="small"
                            to={`/participant/tasks?task=${encodeURIComponent(session.sessionDetailsReviewTaskId)}&compose=comment#task-${encodeURIComponent(session.sessionDetailsReviewTaskId)}`}
                          >
                            Request a correction
                          </ButtonLink>
                        ) : portal.event.participantSupportUrl ? (
                          <ButtonAnchor
                            size="small"
                            href={portal.event.participantSupportUrl}
                          >
                            Request a correction
                          </ButtonAnchor>
                        ) : null
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="pc-empty-state">
            <Mic2 aria-hidden className="pc-state-icon" />
            <h2>No linked sessions</h2>
            <p className="subtle">
              Ask the event team to connect your accepted session to this
              speaker identity.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
