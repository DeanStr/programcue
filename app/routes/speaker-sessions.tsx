import { Mic2 } from "lucide-react";
import { data, Form, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
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
import {
  notifyRouteChange,
  recordRouteChange,
} from "~/platform/realtime/route-realtime.server";
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
    const result =
      intent === "confirm-participation"
        ? await service.confirmOwnParticipation(viewer, {
            sessionId: form.get("sessionId"),
            participationRevision: form.get("participationRevision"),
            confirmation: form.get("confirmation"),
          })
        : await service.declineOwnParticipation(viewer, {
            sessionId: form.get("sessionId"),
            participationRevision: form.get("participationRevision"),
            declineConfirmation: form.get("declineConfirmation"),
            reason: form.get("reason") ?? "",
          });
    const realtimeFailure =
      result.changeSequence != null
        ? await notifyRouteChange(
            env,
            viewer,
            result.changeSequence,
            result.sessionId,
          )
        : result.changed
          ? await recordRouteChange(env, viewer, {
              entityType: "session",
              entityId: result.sessionId,
              changeType: "updated",
            })
          : null;
    if (realtimeFailure) return data(realtimeFailure, { status: 207 });
    return data({
      ok: true,
      message:
        intent === "confirm-participation"
          ? `Participation confirmed for “${result.title}”.`
          : `You declined “${result.title}”.`,
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
      session.participationStatus === "pending" &&
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
              const needsConfirm =
                session.participationStatus === "pending" &&
                session.status !== "cancelled";
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
                        <span>{session.roleLabel ?? "Speaker"}</span>
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
                      {session.participants.length ? (
                        <div className="speaker-session-participants">
                          <strong>Other session participants</strong>
                          <ul>
                            {session.participants.map((participant) => (
                              <li key={`${session.id}:${participant.position}`}>
                                <span>{participant.name}</span>
                                <small>
                                  {participant.roleLabel ?? "Speaker"} ·{" "}
                                  {participant.participationStatus ===
                                  "confirmed"
                                    ? "Confirmed"
                                    : "Awaiting response"}
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
                        {session.participationStatus === "confirmed"
                          ? "Confirmed"
                          : session.participationStatus === "declined"
                            ? "Declined by you"
                            : session.status === "cancelled"
                              ? "Not required"
                              : "Confirmation needed"}
                      </span>
                      {needsConfirm ? (
                        <div className="speaker-session-confirm">
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
                              name="participationRevision"
                              value={session.participationRevision}
                            />
                            <input
                              type="hidden"
                              name="confirmation"
                              value="confirmed"
                            />
                            <Button
                              variant="primary"
                              type="button"
                              disabled={busy}
                              aria-label={`Accept participation in ${session.title}`}
                              onClick={(event) => {
                                const form = event.currentTarget.form;
                                if (!form) return;
                                confirm(
                                  {
                                    title: "Accept this session?",
                                    description:
                                      "This tells the event team you will take part. There is no self-service undo after you confirm.",
                                    records: [session.title],
                                    confirmLabel: "Accept session",
                                    tone: "primary",
                                  },
                                  () => form.requestSubmit(),
                                );
                              }}
                            >
                              Accept session
                            </Button>
                          </Form>
                          <details className="speaker-task-comment">
                            <summary>Decline this session</summary>
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
                                name="participationRevision"
                                value={session.participationRevision}
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
                              <input
                                type="hidden"
                                name="declineConfirmation"
                                value="declined"
                              />
                              <Button
                                variant="danger"
                                type="button"
                                disabled={busy}
                                onClick={(event) => {
                                  const form = event.currentTarget.form;
                                  if (!form) return;
                                  confirm(
                                    {
                                      title: "Decline this session?",
                                      description:
                                        "The event team will be told that you cannot take part. Your optional reason remains private.",
                                      records: [session.title],
                                      confirmLabel: "Decline session",
                                      tone: "danger",
                                    },
                                    () => form.requestSubmit(),
                                  );
                                }}
                              >
                                Decline session
                              </Button>
                            </Form>
                          </details>
                        </div>
                      ) : session.participationStatus === "confirmed" ? (
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
                      ) : session.participationStatus === "declined" ? (
                        <p className="subtle">
                          The event team must reset this session before you can
                          respond again.
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
