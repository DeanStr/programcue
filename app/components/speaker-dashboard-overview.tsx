import { Mic2 } from "lucide-react";
import { Link } from "react-router";

import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import {
  speakerStatusClass,
  type SpeakerPortal,
  type SpeakerTask,
} from "~/components/speaker-dashboard-panel-shared";

export function SpeakerDashboardOverview({
  portal,
  next,
  progress,
}: {
  portal: SpeakerPortal;
  next: SpeakerTask | undefined;
  progress: number;
}) {
  const waitingOnTeam = next
    ? ["submitted", "blocked"].includes(next.status)
    : false;
  return (
    <>
      <div className="speaker-portal-head">
        <div>
          <span className="pc-page-eyebrow">Speaker workspace</span>
          <h1>Welcome back, {portal.profile.name.split(/\s+/)[0]}</h1>
          <p className="subtle">
            Everything the event team needs from you, with clear privacy and
            review states.
          </p>
        </div>
        <div className="speaker-readiness">
          <strong>{progress}%</strong>
          <span>onboarding complete</span>
        </div>
      </div>
      <section className="card next-action mt">
        <div>
          <span
            className={`status ${next ? speakerStatusClass(next.status) : "success"}`}
          >
            {next
              ? waitingOnTeam
                ? "Waiting"
                : "Next action"
              : "Onboarding complete"}
          </span>
          <h2>{next?.title ?? "You are ready for the event"}</h2>
          <p className="subtle">
            {next
              ? waitingOnTeam
                ? next.status === "submitted"
                  ? "Submitted for administrator review. No further action is required until the event team responds."
                  : "This requirement is waiting for its prerequisites to be completed."
                : next.description
              : "There are no outstanding requirements right now."}
          </p>
          {next ? (
            <Link
              className="btn primary"
              to={`/participant/tasks#task-${next.id}`}
            >
              Open task
            </Link>
          ) : null}
        </div>
        <div
          className="speaker-progress-visual"
          role="progressbar"
          aria-label={`${progress}% complete`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="gauge compact"
            style={{ "--pct": progress } as React.CSSProperties}
          >
            <div className="gauge-inner">
              <strong>{progress}%</strong>
              <small>Complete</small>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export function SpeakerSessionsPanel({ portal }: { portal: SpeakerPortal }) {
  return (
    <section className="mt" id="sessions">
      <div className="card-title">
        <div>
          <span className="pc-section-kicker">Programme</span>
          <h2>My sessions</h2>
        </div>
        <span className="pill right">{portal.sessions.length}</span>
      </div>
      <div className="grid grid-2">
        {portal.sessions.length ? (
          portal.sessions.map((session) => (
            <article className="card pad speaker-session-card" key={session.id}>
              <div className="card-title">
                <DomainStatusBadge domain="session" status={session.status} />
                <span className="pill right">
                  {session.durationMinutes} min
                </span>
              </div>
              <h3>{session.title}</h3>
              <p className="subtle">{session.description}</p>
              <dl className="speaker-session-meta">
                <div>
                  <dt>Role</dt>
                  <dd>{session.roleLabel ?? "Speaker"}</dd>
                </div>
                <div>
                  <dt>When</dt>
                  <dd>
                    {session.startsAt ? (
                      <EventDateTime
                        epochSeconds={session.startsAt}
                        timeZone={portal.event.timezone}
                        showTimeZone
                      />
                    ) : (
                      "Scheduling pending"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Room</dt>
                  <dd>{session.roomName ?? "To be confirmed"}</dd>
                </div>
              </dl>
            </article>
          ))
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
      </div>
    </section>
  );
}
