import { CheckCircle2, Circle, CircleDot, Megaphone, Mic2 } from "lucide-react";
import type { CSSProperties } from "react";
import { Form, Link } from "react-router";
import {
  type SpeakerPortal,
  type SpeakerTask,
  speakerStatusClass,
} from "~/components/speaker-dashboard-panel-shared";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";

export type SpeakerMilestone = {
  key: string;
  label: string;
  detail: string;
  state: "complete" | "in_progress" | "not_started";
  href: string;
};

export function speakerMilestones({
  portal,
  completedCount,
  requirementCount,
  requiredResourceCount,
  acknowledgedResourceCount,
}: {
  portal: SpeakerPortal;
  completedCount: number;
  requirementCount: number;
  requiredResourceCount: number;
  acknowledgedResourceCount: number;
}): SpeakerMilestone[] {
  const profilePublished = portal.profile.profileStatus === "published";
  const liveSessions = portal.sessions.filter(
    (session) => session.status !== "cancelled",
  );
  const confirmedSessions = liveSessions.filter(
    (session) => session.participationStatus === "confirmed",
  ).length;
  return [
    {
      key: "profile",
      label: "Profile",
      detail: profilePublished
        ? "Profile marked published"
        : "Profile not marked published",
      state: profilePublished ? "complete" : "in_progress",
      href: "/participant/profile",
    },
    {
      key: "sessions",
      label: "Sessions",
      detail: liveSessions.length
        ? `${confirmedSessions} of ${liveSessions.length} confirmed`
        : "No sessions linked yet",
      state: !liveSessions.length
        ? "not_started"
        : confirmedSessions === liveSessions.length
          ? "complete"
          : confirmedSessions > 0
            ? "in_progress"
            : "not_started",
      href: "/participant/sessions",
    },
    {
      key: "requirements",
      label: "Requirements",
      detail: requirementCount
        ? `${completedCount} of ${requirementCount} complete`
        : "Nothing requested",
      state: !requirementCount
        ? "complete"
        : completedCount === requirementCount
          ? "complete"
          : completedCount > 0
            ? "in_progress"
            : "not_started",
      href: "/participant/tasks",
    },
    {
      key: "resources",
      label: "Resources",
      detail: requiredResourceCount
        ? `${acknowledgedResourceCount} of ${requiredResourceCount} acknowledged`
        : "Nothing requested",
      state: !requiredResourceCount
        ? "complete"
        : acknowledgedResourceCount === requiredResourceCount
          ? "complete"
          : acknowledgedResourceCount > 0
            ? "in_progress"
            : "not_started",
      href: "/participant/resources",
    },
  ];
}

const MILESTONE_STATE_LABEL: Record<SpeakerMilestone["state"], string> = {
  complete: "Complete",
  in_progress: "In progress",
  not_started: "Not started",
};

export type SpeakerOutstandingResource = {
  id: string;
  title: string;
  href: string;
};

function taskResourcePageId(task: SpeakerTask) {
  try {
    const parsed: unknown = JSON.parse(task.configurationJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    if (
      !("resourcePageId" in parsed) ||
      typeof parsed.resourcePageId !== "string"
    ) {
      return null;
    }
    const resourcePageId = parsed.resourcePageId.trim();
    return resourcePageId || null;
  } catch {
    return null;
  }
}

export function speakerHeroActions(
  next: SpeakerTask | undefined,
  outstandingResource: SpeakerOutstandingResource | null,
) {
  const resourceMatchesNext = Boolean(
    next &&
      outstandingResource &&
      taskResourcePageId(next) === outstandingResource.id,
  );
  const resourceAction =
    outstandingResource && (!next || resourceMatchesNext)
      ? outstandingResource
      : null;
  return {
    resourceAction,
    taskAction: resourceAction ? null : (next ?? null),
  };
}

export function SpeakerDashboardOverview({
  portal,
  next,
  completedCount,
  requirementCount,
  outstandingResource = null,
  requiredResourceCount,
  acknowledgedResourceCount,
}: {
  portal: SpeakerPortal;
  next: SpeakerTask | undefined;
  completedCount: number;
  requirementCount: number;
  outstandingResource?: SpeakerOutstandingResource | null;
  requiredResourceCount: number;
  acknowledgedResourceCount: number;
}) {
  const milestones = speakerMilestones({
    portal,
    completedCount,
    requirementCount,
    requiredResourceCount,
    acknowledgedResourceCount,
  });
  const completedStages = milestones.filter(
    (milestone) => milestone.state === "complete",
  ).length;
  const preparationComplete = completedStages === milestones.length;
  const { resourceAction, taskAction } = speakerHeroActions(
    next,
    outstandingResource,
  );
  const waitingOnTeam = taskAction
    ? ["submitted", "blocked"].includes(taskAction.status)
    : false;
  return (
    <>
      <div className="speaker-portal-head">
        <div>
          <h1>Welcome back, {portal.profile.name.split(/\s+/)[0]}</h1>
          <p className="subtle">
            Everything the event team needs from you, with clear privacy and
            review states.
          </p>
        </div>
      </div>
      <section className="card next-action speaker-next-hero mt">
        <div className="speaker-next-copy">
          <span
            className={`status ${taskAction ? speakerStatusClass(taskAction.status) : resourceAction ? "warning" : "success"}`}
          >
            {taskAction
              ? waitingOnTeam
                ? "Waiting"
                : "Next action"
              : resourceAction
                ? "Next action"
                : preparationComplete
                  ? "Preparation complete"
                  : "Tasks complete"}
          </span>
          <h2>
            {taskAction?.title ??
              resourceAction?.title ??
              (preparationComplete
                ? "You are ready for the event"
                : "No outstanding requirements")}
          </h2>
          <p className="subtle">
            {taskAction
              ? waitingOnTeam
                ? taskAction.status === "submitted"
                  ? "Submitted for administrator review. No further action is required until the event team responds."
                  : "This requirement is waiting for its prerequisites to be completed."
                : taskAction.description
              : resourceAction
                ? "Read and acknowledge the current published resource."
                : preparationComplete
                  ? "There are no outstanding requirements right now."
                  : "Your task list is clear. Check the preparation stages below for remaining profile, session or resource status."}
          </p>
          {taskAction ? (
            <Link
              className="btn primary"
              to={`/participant/tasks#task-${taskAction.id}`}
            >
              Open task
            </Link>
          ) : resourceAction ? (
            <Link className="btn primary" to={resourceAction.href}>
              Open resource
            </Link>
          ) : null}
          <p className="speaker-next-facts">
            {completedStages} of {milestones.length} stages complete
            <span aria-hidden="true"> · </span>
            {requirementCount
              ? `${completedCount} of ${requirementCount} requirements complete`
              : requiredResourceCount
                ? `${acknowledgedResourceCount} of ${requiredResourceCount} resources acknowledged`
                : "No task requirements"}
          </p>
        </div>
      </section>
      <section
        className="card pad speaker-stepper-card mt"
        aria-labelledby="speaker-stepper-heading"
      >
        <div className="card-title">
          <h2 id="speaker-stepper-heading">Your preparation</h2>
          <span className="subtle right pc-num">
            {completedStages} of {milestones.length} stages complete
          </span>
        </div>
        <div
          className="speaker-stepper-meter"
          aria-hidden
          style={
            {
              "--speaker-progress": `${(completedStages / milestones.length) * 100}%`,
            } as CSSProperties
          }
        />
        <ol className="speaker-stepper">
          {milestones.map((milestone) => (
            <li
              className="speaker-stage"
              key={milestone.key}
              data-state={milestone.state}
            >
              <Link to={milestone.href} className="speaker-stage-link">
                <span className="speaker-stage-marker" aria-hidden>
                  {milestone.state === "complete" ? (
                    <CheckCircle2 size={16} />
                  ) : milestone.state === "in_progress" ? (
                    <CircleDot size={16} />
                  ) : (
                    <Circle size={16} />
                  )}
                </span>
                <span className="speaker-stage-copy">
                  <strong>{milestone.label}</strong>
                  <small className="subtle">{milestone.detail}</small>
                </span>
                <span className="sr-only">
                  {MILESTONE_STATE_LABEL[milestone.state]}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

export function SpeakerUpdatesRail({
  tasks,
  timezone,
}: {
  tasks: SpeakerTask[];
  timezone: string;
}) {
  const updates = tasks
    .flatMap((task) =>
      task.comments.map((comment) => ({
        ...comment,
        taskTitle: task.title,
      })),
    )
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 4);
  if (!updates.length) return null;
  return (
    <div className="speaker-rail">
      <section className="card pad" aria-labelledby="speaker-rail-updates">
        <div className="card-title">
          <h2 id="speaker-rail-updates">Recent updates</h2>
        </div>
        <ul className="speaker-rail-list">
          {updates.map((update) => (
            <li key={update.id}>
              <div className="speaker-rail-update">
                <Megaphone aria-hidden size={15} className="subtle" />
                <div>
                  <strong>{update.taskTitle}</strong>
                  <p>{update.body}</p>
                  <small className="subtle">
                    {update.authorName}
                    {" · "}
                    <EventDateTime
                      epochSeconds={update.createdAt}
                      timeZone={timezone}
                    />
                  </small>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function SpeakerSessionsPanel({
  portal,
  busy,
}: {
  portal: SpeakerPortal;
  busy: boolean;
}) {
  return (
    <section className="mt" id="sessions">
      <div className="card-title">
        <h2 className="sr-only">Session list</h2>
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
                  <dt>Participation</dt>
                  <dd>
                    <span
                      className={`status ${session.participationStatus === "confirmed" ? "success" : session.status === "cancelled" ? "" : "warning"}`}
                    >
                      {session.participationStatus === "confirmed"
                        ? "Confirmed"
                        : session.status === "cancelled"
                          ? "Not required"
                          : "Confirmation needed"}
                    </span>
                  </dd>
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
              {session.participationStatus === "pending" &&
              session.status !== "cancelled" ? (
                <Form method="post" className="stack mt">
                  <input
                    type="hidden"
                    name="intent"
                    value="confirm-participation"
                  />
                  <input type="hidden" name="sessionId" value={session.id} />
                  <input type="hidden" name="confirmation" value="confirmed" />
                  <p className="subtle">
                    Confirm that you agree to participate in this session and be
                    listed according to its programme visibility.
                  </p>
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={busy}
                    aria-label={`Confirm participation in ${session.title}`}
                  >
                    Confirm participation
                  </button>
                </Form>
              ) : null}
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
