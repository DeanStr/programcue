import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  RefreshCw,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Link, useRevalidator } from "react-router";

import type { Route } from "./+types/command-centre";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import { PageHeader } from "~/components/ui/page-header";
import {
  AdminPageSection,
  AdminPageSectionNavigation,
} from "~/components/ui/admin-page-sections";
import { EmptyState } from "~/components/ui/states";
import { StatusBadge } from "~/components/ui/status-badge";
import {
  ReadinessSummaryAction,
  ReminderDraftAction,
} from "~/modules/ai/contextual-ai-actions";
import { AiAssistantService } from "~/modules/ai/ai-assistant-service.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { ReadinessService } from "~/modules/readiness/readiness-service.server";
import { groupProgrammeSetupSteps } from "~/modules/readiness/programme-workflow-phases";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  subscribeToEventChanges,
  type RealtimeTransportStatus,
} from "~/platform/realtime/realtime-client";

export const meta: Route.MetaFunction = () => [
  { title: "Command Centre · Program Cue" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  await ensureDemoEvaluationData(env);
  const [snapshot, reminderOptions] = await Promise.all([
    new ReadinessService(env).getCommandCentre(viewer),
    new AiAssistantService(env).reminderDeliveryOptions(viewer),
  ]);
  return { ...snapshot, reminderOptions };
}

function AutoRefresh({ eventId, cursor }: { eventId: string; cursor: number }) {
  const revalidator = useRevalidator();
  const [transport, setTransport] =
    useState<RealtimeTransportStatus>("connecting");
  useEffect(() => {
    const url = `/admin/events/${encodeURIComponent(eventId)}/changes`;
    return subscribeToEventChanges({
      liveUrl: url,
      pollUrl: url,
      initialCursor: cursor,
      onInvalidate: () => revalidator.revalidate(),
      onError: (error) =>
        console.warn("Command Centre realtime transport error.", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      onStatusChange: setTransport,
    });
  }, [cursor, eventId, revalidator]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [revalidator]);

  return (
    <span
      className={`status ${transport === "unavailable" ? "danger" : transport === "polling" ? "warning" : "info"}`}
      role="status"
      aria-live="polite"
    >
      <RefreshCw
        aria-hidden
        size={13}
        className={revalidator.state !== "idle" ? "pc-spin" : undefined}
      />
      {revalidator.state !== "idle"
        ? "Refreshing"
        : transport === "live"
          ? "Live"
          : transport === "polling"
            ? "Polling"
            : transport === "unavailable"
              ? "Updates unavailable"
              : "Connecting"}
    </span>
  );
}

/* A measured value carries its own reading. Without this the two 0% workflows
   rendered as the faintest thing on the page and the three 100% ones got the
   most saturated fill. */
function progressTone(score: number) {
  if (score >= 90) return "green";
  if (score >= 50) return "";
  return score > 0 ? "amber" : "red";
}

/* Sessions arrive in start order, so a day break is simply the point where the
   event-local calendar date changes. Grouping is what stops the same date
   being restated on every row. */
function groupUpcomingByDay(
  sessions: Route.ComponentProps["loaderData"]["upcoming"],
  timeZone: string,
) {
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  });
  const dayLabel = new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  });
  const days: Array<{
    key: string;
    label: string;
    sessions: typeof sessions;
  }> = [];
  for (const session of sessions) {
    const startsAt = new Date(session.startsAt * 1_000);
    const key = dayKey.format(startsAt);
    const current = days.at(-1);
    if (current?.key === key) current.sessions.push(session);
    else
      days.push({ key, label: dayLabel.format(startsAt), sessions: [session] });
  }
  return days;
}

export default function CommandCentre({ loaderData }: Route.ComponentProps) {
  const completedSetupSteps = loaderData.setupGuide.filter(
    (step) => step.complete,
  ).length;
  const workflowPhases = groupProgrammeSetupSteps(loaderData.setupGuide);
  const completedWorkflowPhases = workflowPhases.filter(
    (phase) => phase.complete,
  ).length;
  const hasOverdueTasks = loaderData.blockers.some(
    (blocker) => blocker.key === "overdue_tasks",
  );
  const readinessLabel =
    loaderData.readiness.status === "ready"
      ? "Ready"
      : loaderData.readiness.status === "on_track"
        ? "On track"
        : "At risk";
  /* The panel exists to expose the workflows that are not ready. In domain
     order the two zeros landed in the middle of six rows and had to be hunted
     for. */
  const workflows = [...loaderData.workflows].sort((a, b) => a.score - b.score);
  const upcomingDays = groupUpcomingByDay(
    loaderData.upcoming,
    loaderData.eventTimezone,
  );

  return (
    <>
      <PageHeader
        title="Command Centre"
        description="Live operational readiness calculated from the current event records."
        actions={
          <>
            <AutoRefresh
              eventId={loaderData.eventId}
              cursor={loaderData.cursor}
            />
            {hasOverdueTasks ? (
              <Link
                className="btn primary"
                to="/admin/communications?audience=overdue_speakers&category=task_reminder"
              >
                Prepare overdue reminder
              </Link>
            ) : null}
            <Link className="btn" to="/admin/event">
              Event settings
            </Link>
          </>
        }
      />

      <AdminPageSectionNavigation
        label="Command Centre sections"
        links={[
          ...(completedSetupSteps < loaderData.setupGuide.length
            ? [{ id: "command-setup", label: "Programme setup" }]
            : []),
          { id: "command-readiness", label: "Readiness" },
          { id: "command-workflows", label: "Workflow actions" },
          { id: "command-assistants", label: "Assistants" },
          { id: "command-activity", label: "Schedule and operations" },
        ]}
      />

      {completedSetupSteps < loaderData.setupGuide.length ? (
        <AdminPageSection
          id="command-setup"
          label="Programme setup"
          description={`${completedWorkflowPhases} of ${workflowPhases.length} phases ready. Every step reads the event's current records — there is no separate checklist.`}
        >
          <div className="command-workflow-phases">
            {workflowPhases.map((phase, index) => (
              <section className="card command-workflow-phase" key={phase.key}>
                <div className="command-workflow-phase-heading">
                  <StatusBadge tone={phase.complete ? "success" : "info"}>
                    <span aria-hidden>{index + 1}</span>
                    <span className="sr-only">
                      Phase {index + 1} {phase.complete ? "ready" : "not ready"}
                    </span>
                  </StatusBadge>
                  <h3>{phase.label}</h3>
                </div>
                <div className="command-workflow-steps">
                  {phase.steps.map((step) => (
                    <Link
                      className="command-workflow-step"
                      to={step.href}
                      key={step.key}
                    >
                      {step.complete ? (
                        <CheckCircle2
                          aria-label="Complete"
                          className="tone-success"
                          size={16}
                        />
                      ) : (
                        <Clock3 aria-label="Not complete" size={16} />
                      )}
                      <span>{step.label}</span>
                      <span className="chev" aria-hidden>
                        ›
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </AdminPageSection>
      ) : null}

      <AdminPageSection
        id="command-readiness"
        label="Readiness"
        description="The overall score and the exact conditions holding it back"
        defaultExpandedOnMobile
      >
        <div className="command-readiness-row">
          {/* The queue is the only place a blocker is stated. It used to be
              restated as a tile row, a count sentence and a badge, so two
              conditions read as eight. */}
          <section className="card pad" id="action-queue">
            <div className="card-title">
              <h2>Action queue</h2>
              <StatusBadge
                tone={loaderData.blockers.length ? "warning" : "success"}
              >
                {loaderData.blockers.length} declared
                {loaderData.blockers.length === 1
                  ? " condition"
                  : " conditions"}
              </StatusBadge>
            </div>
            {loaderData.blockers.length ? (
              <div className="command-blockers">
                {loaderData.blockers.map((blocker) => (
                  <Link
                    className={`command-blocker rail-left ${blocker.severity === "danger" ? "is-danger" : "is-warning"}`}
                    to={blocker.href}
                    key={blocker.key}
                  >
                    {blocker.severity === "danger" ? (
                      <AlertTriangle aria-label="Critical" size={17} />
                    ) : (
                      <AlertCircle aria-label="Needs attention" size={17} />
                    )}
                    <span className="command-blocker-copy">
                      {/* Count and label are separated by rank, not by
                          grammar: "1 critical tasks incomplete" was the old
                          reading. */}
                      <strong>{blocker.label}</strong>
                      <small>{blocker.action}</small>
                    </span>
                    <b className="pc-num">{blocker.count}</b>
                    <span className="chev" aria-hidden>
                      ›
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="command-quiet">
                No declared blockers in the current records.
              </p>
            )}
          </section>

          <section
            className="card pad command-score"
            data-state={loaderData.readiness.status}
          >
            <div className="card-title">
              <h2>Overall readiness</h2>
            </div>
            {/* A scalar is a numeral, a state word and at most a flat bar. The
                donut spent 150px encoding an angle nobody measures around the
                number it already printed. */}
            <p className="command-score-reading">
              <strong className="pc-num">
                {loaderData.readiness.percentage}%
              </strong>
              <span>{readinessLabel}</span>
            </p>
            <div
              className={`progress ${loaderData.readiness.status === "ready" ? "green" : loaderData.readiness.status === "at_risk" ? "amber" : ""}`}
              aria-hidden
            >
              <span style={{ width: `${loaderData.readiness.percentage}%` }} />
            </div>
            <p className="command-score-note">
              <span title={loaderData.readiness.explanation}>
                Equal weighting across {loaderData.workflows.length} workflows
              </span>
            </p>
          </section>
        </div>
      </AdminPageSection>

      <AdminPageSection
        id="command-workflows"
        label="Workflow actions"
        description="Where the score comes from, least ready first"
      >
        <section className="card pad">
          <div className="card-title">
            <h2>Readiness by workflow</h2>
          </div>
          <div className="command-workflow-list">
            {workflows.map((workflow) => (
              <Link
                className="command-workflow-row"
                to={workflow.href}
                key={workflow.key}
                aria-label={`${workflow.label}: ${workflow.score}% ready`}
              >
                <strong>{workflow.label}</strong>
                <small className="command-workflow-detail">
                  {workflow.detail}
                </small>
                <div
                  className={`progress ${progressTone(workflow.score)}${workflow.score === 0 ? " is-zero" : ""}`}
                  aria-hidden
                >
                  <span style={{ width: `${workflow.score}%` }} />
                </div>
                <b className="pc-num">{workflow.score}%</b>
                <span className="chev" aria-hidden>
                  ›
                </span>
              </Link>
            ))}
          </div>
        </section>
      </AdminPageSection>

      <AdminPageSection
        id="command-assistants"
        label="Assistants and delivery"
        description="Advisory drafting and the outcome of what has been sent"
      >
        <div className="command-assist">
          <section className="card pad">
            <div className="card-title">
              <h2>Targeted reminder assistant</h2>
              <span className="status warning">Preview first</span>
            </div>
            <ReminderDraftAction options={loaderData.reminderOptions} />
          </section>

          {/* The advisor and delivery health are short panels; pairing them in
              one column stops a 200px card being stretched to the height of
              the reminder form beside it. */}
          <div className="command-assist-side">
            <section className="card pad">
              <div className="card-title">
                <h2>AI readiness advisor</h2>
                <span className="status info">Advisory</span>
              </div>
              <ReadinessSummaryAction />
            </section>

            <section className="card pad">
              <div className="card-title command-subhead">
                <h2>Delivery health</h2>
              </div>
              {loaderData.deliveryHealth.length ? (
                loaderData.deliveryHealth.map((channel) => (
                  <Link
                    to="/admin/communications"
                    key={channel.channel}
                    className="command-health-row"
                  >
                    <span>{channel.channel}</span>
                    <strong
                      className={`pc-num ${
                        channel.percentage === 100
                          ? "tone-success"
                          : "tone-warning"
                      }`}
                    >
                      {channel.percentage}%
                    </strong>
                    <small className="subtle">
                      {channel.successful} / {channel.total}
                    </small>
                  </Link>
                ))
              ) : (
                <p className="command-quiet">
                  Nothing queued yet, so there is no delivery outcome to report.
                </p>
              )}
            </section>
          </div>
        </div>
      </AdminPageSection>

      <AdminPageSection
        id="command-activity"
        label="Schedule and operations"
        description="Upcoming sessions and background work"
      >
        <div className="command-activity">
          <section className="card pad">
            <div className="card-title">
              <h2>Upcoming published sessions</h2>
              <Link className="btn small right" to="/admin/schedule">
                Open schedule
              </Link>
            </div>
            {upcomingDays.length ? (
              <div className="command-session-list">
                {upcomingDays.map((day, index) => (
                  <Fragment key={day.key}>
                    <p className="command-session-day">
                      <span>{day.label}</span>
                      {/* The zone qualifies the times below it, so it sits at
                          the head of the column it applies to rather than
                          competing with the card heading. */}
                      {index === 0 ? (
                        <span className="command-session-zone">
                          Times in {loaderData.eventTimezone}
                        </span>
                      ) : null}
                    </p>
                    {day.sessions.map((session) => (
                      <Link
                        className="command-session-row command-agenda-link"
                        to={`/admin/schedule?session=${encodeURIComponent(session.id)}`}
                        key={session.id}
                      >
                        <EventDateTime
                          epochSeconds={session.startsAt}
                          timeZone={loaderData.eventTimezone}
                          focusable={false}
                        >
                          <span className="command-session-time pc-num">
                            {new Intl.DateTimeFormat("en", {
                              hour: "numeric",
                              minute: "2-digit",
                              timeZone: loaderData.eventTimezone,
                            }).format(new Date(session.startsAt * 1_000))}
                          </span>
                        </EventDateTime>
                        <span className="command-session-title">
                          {session.title}
                        </span>
                        {/* Every row here is published by definition of the
                            heading, so a status column would repeat it five
                            times. The room is the fact that varies. */}
                        <small className="command-session-room">
                          {session.room}
                        </small>
                        <span className="chev" aria-hidden>
                          ›
                        </span>
                      </Link>
                    ))}
                  </Fragment>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No upcoming sessions"
                description="No future sessions exist in the current published schedule."
                icon={Clock3}
              />
            )}
          </section>

          <section className="card pad">
            <div className="card-title command-subhead">
              <h2>Background operations</h2>
              <Link className="btn small right" to="/admin/operations">
                View all
              </Link>
            </div>
            {loaderData.operations.length ? (
              <div
                className="table-wrap"
                role="region"
                aria-label="Background operations"
                tabIndex={0}
              >
                <table className="jobs">
                  <thead>
                    <tr>
                      <th>Operation</th>
                      <th>Status</th>
                      <th>Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loaderData.operations.map((operation) => (
                      <tr key={operation.id}>
                        <td>
                          <Link
                            to={`/admin/operations?operation=${encodeURIComponent(operation.id)}`}
                          >
                            {operation.type.replaceAll("_", " ")}
                          </Link>
                        </td>
                        <td>
                          <DomainStatusBadge
                            domain="operation"
                            status={operation.status}
                          />
                        </td>
                        <td>
                          {operation.total > 0 ? (
                            <>
                              <div className="progress">
                                <span
                                  style={{
                                    width: `${percentForOperation(operation.completed, operation.total)}%`,
                                  }}
                                />
                              </div>
                              <small className="subtle">
                                {operation.completed} / {operation.total}
                              </small>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              /* Nothing running is this panel's healthy state, so it gets a
                 line rather than an illustrated placeholder. */
              <p className="command-quiet">
                Nothing running. Bulk sends, publications and provider work
                appear here while they are in progress.
              </p>
            )}
          </section>
        </div>
      </AdminPageSection>
    </>
  );
}

function percentForOperation(completed: number, total: number) {
  return total > 0
    ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
    : 0;
}
