import { CheckCircle2, Circle, CircleDot, Megaphone, Mic2 } from "lucide-react";
import type { CSSProperties } from "react";
import { Link } from "react-router";
import {
  type SpeakerPortal,
  type SpeakerTask,
  speakerStatusClass,
} from "~/components/speaker-dashboard-panel-shared";
import { ButtonLink } from "~/components/ui/button";
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
  const liveRoles = liveSessions.flatMap((session) =>
    session.roles?.length
      ? session.roles
      : [{ participationStatus: session.participationStatus }],
  );
  const confirmedRoles = liveRoles.filter(
    (role) => role.participationStatus === "confirmed",
  ).length;
  const declinedRoles = liveRoles.filter(
    (role) => role.participationStatus === "declined",
  ).length;
  const decidedRoles = confirmedRoles + declinedRoles;
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
      detail: liveRoles.length
        ? declinedRoles > 0
          ? `${decidedRoles} of ${liveRoles.length} roles responded · ${confirmedRoles} accepted · ${declinedRoles} declined`
          : `${confirmedRoles} of ${liveRoles.length} roles accepted`
        : "No sessions linked yet",
      state: !liveRoles.length
        ? "not_started"
        : decidedRoles === liveRoles.length
          ? "complete"
          : decidedRoles > 0
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

export function speakerParticipationBadge(
  session: Pick<
    SpeakerPortal["sessions"][number],
    "participationStatus" | "status"
  > & { roles?: SpeakerPortal["sessions"][number]["roles"] },
) {
  if (session.status === "cancelled")
    return { className: "", label: "Not required" };
  const pendingRoles = (session.roles ?? []).filter(
    (role) => role.participationStatus === "pending",
  ).length;
  if (pendingRoles)
    return {
      className: "warning",
      label: `${pendingRoles} ${pendingRoles === 1 ? "role" : "roles"} need a response`,
    };
  if (session.participationStatus === "confirmed")
    return { className: "success", label: "Confirmed" };
  if (session.participationStatus === "declined")
    return { className: "danger", label: "Declined by you" };
  return { className: "warning", label: "Confirmation needed" };
}

function SpeakerParticipationBadge({
  session,
}: {
  session: SpeakerPortal["sessions"][number];
}) {
  const status = speakerParticipationBadge(session);
  return <span className={`status ${status.className}`}>{status.label}</span>;
}

export function speakerHeroActions(
  next: SpeakerTask | undefined,
  outstandingResources: readonly SpeakerOutstandingResource[] = [],
) {
  const resourceById = new Map(
    outstandingResources.map((resource) => [resource.id, resource]),
  );
  const resourceAction = next?.resourcePageId
    ? (resourceById.get(next.resourcePageId) ?? null)
    : next
      ? null
      : (outstandingResources[0] ?? null);
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
  outstandingResources = [],
  requiredResourceCount,
  acknowledgedResourceCount,
}: {
  portal: SpeakerPortal;
  next: SpeakerTask | undefined;
  completedCount: number;
  requirementCount: number;
  outstandingResources?: readonly SpeakerOutstandingResource[];
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
    outstandingResources,
  );
  const waitingOnTeam = taskAction
    ? ["submitted", "blocked"].includes(taskAction.status)
    : false;
  return (
    <>
      <div className="speaker-portal-head">
        <div>
          <h1>
            Welcome back, {portal.profile.name?.split(/\s+/)[0] || "there"}
          </h1>
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
            <ButtonLink
              variant="primary"
              to={`/participant/tasks#task-${taskAction.id}`}
            >
              Open task
            </ButtonLink>
          ) : resourceAction ? (
            <ButtonLink variant="primary" to={resourceAction.href}>
              Open resource
            </ButtonLink>
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
  busy: _busy,
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
                  <dd>
                    {session.roles.map((role) => role.label).join(", ") ||
                      session.roleLabel ||
                      "Speaker"}
                  </dd>
                </div>
                <div>
                  <dt>Participation</dt>
                  <dd>
                    <SpeakerParticipationBadge session={session} />
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
              {session.roles.some(
                (role) => role.participationStatus === "pending",
              ) && session.status !== "cancelled" ? (
                <ButtonLink to="/participant/sessions" size="small">
                  Respond to roles
                </ButtonLink>
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
