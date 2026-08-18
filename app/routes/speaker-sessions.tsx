import { Mic2 } from "lucide-react";
import { data, Form, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
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
  if (form.get("intent") !== "confirm-participation") {
    return data(
      { ok: false, message: "Unsupported session action." },
      { status: 400 },
    );
  }
  try {
    const result = await new SpeakerService(env).confirmOwnParticipation(
      viewer,
      {
        sessionId: form.get("sessionId"),
        confirmation: form.get("confirmation"),
      },
    );
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
      message: result.changed
        ? `Participation confirmed for “${result.title}”.`
        : `Participation for “${result.title}” was already confirmed.`,
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
          <p>Published schedule details and your role in each session.</p>
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
                    </div>
                    <div className="speaker-session-measure">
                      <span
                        className={`status ${session.participationStatus === "confirmed" ? "success" : session.status === "cancelled" ? "" : "warning"}`}
                      >
                        {session.participationStatus === "confirmed"
                          ? "Confirmed"
                          : session.status === "cancelled"
                            ? "Not required"
                            : "Confirmation needed"}
                      </span>
                      {needsConfirm ? (
                        <Form method="post" className="speaker-session-confirm">
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
                            name="confirmation"
                            value="confirmed"
                          />
                          <button
                            className="btn primary"
                            type="button"
                            disabled={busy}
                            aria-label={`Confirm participation in ${session.title}`}
                            onClick={(event) => {
                              const form = event.currentTarget.form;
                              if (!form) return;
                              confirm(
                                {
                                  title: "Confirm participation?",
                                  description:
                                    "This tells the event team you will take part. There is no self-service undo after you confirm.",
                                  records: [session.title],
                                  confirmLabel: "Confirm participation",
                                  tone: "primary",
                                },
                                () => form.requestSubmit(),
                              );
                            }}
                          >
                            Confirm participation
                          </button>
                        </Form>
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
