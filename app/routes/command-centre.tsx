import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useRevalidator } from "react-router";

import type { Route } from "./+types/command-centre";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import { PageHeader } from "~/components/ui/page-header";
import { EmptyState } from "~/components/ui/states";
import { StatusBadge } from "~/components/ui/status-badge";
import {
  ReadinessSummaryAction,
  ReminderDraftAction,
} from "~/modules/ai/contextual-ai-actions";
import { AiAssistantService } from "~/modules/ai/ai-assistant-service.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { ReadinessService } from "~/modules/readiness/readiness-service.server";
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

export default function CommandCentre({ loaderData }: Route.ComponentProps) {
  const featured = loaderData.blockers.slice(0, 4);
  const hasOverdueTasks = loaderData.blockers.some(
    (blocker) => blocker.key === "overdue_tasks",
  );
  const readinessLabel =
    loaderData.readiness.status === "ready"
      ? "Ready"
      : loaderData.readiness.status === "on_track"
        ? "On track"
        : "At risk";

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

      <div className="command-grid">
        <section className="card readiness-card">
          <div
            className="gauge"
            style={
              {
                "--pct": loaderData.readiness.percentage,
              } as React.CSSProperties
            }
            role="progressbar"
            aria-label="Overall event readiness"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={loaderData.readiness.percentage}
          >
            <div className="gauge-inner">
              <strong>{loaderData.readiness.percentage}%</strong>
              <small>{readinessLabel}</small>
            </div>
          </div>
          <div>
            <div className="card-title">
              <h2>Overall readiness</h2>
            </div>
            <p className="subtle">{loaderData.readiness.explanation}</p>
            <p>
              <strong>{loaderData.readiness.declaredBlockers}</strong> declared
              blocker{loaderData.readiness.declaredBlockers === 1 ? "" : "s"}{" "}
              across this event.
            </p>
            <a className="btn" href="#action-queue">
              View exact blockers
            </a>
          </div>
        </section>

        {featured.map((blocker) => (
          <Link
            key={blocker.key}
            className={`card metric alert-${blocker.severity === "danger" ? "red" : "amber"} command-metric-link`}
            to={blocker.href}
          >
            <div className="label">
              <AlertTriangle aria-hidden size={14} /> {blocker.label}
            </div>
            <div
              className="value"
              style={{
                color: `var(--${blocker.severity === "danger" ? "red" : "amber"})`,
              }}
            >
              {blocker.count}
            </div>
            <div className="helper">{blocker.detail}</div>
          </Link>
        ))}

        {!featured.length ? (
          <section className="card metric alert-green command-clear-card">
            <div className="label">
              <CheckCircle2 aria-hidden size={14} /> No declared blockers
            </div>
            <div className="value" style={{ color: "var(--green)" }}>
              0
            </div>
            <div className="helper">
              All recorded readiness conditions are currently clear.
            </div>
          </section>
        ) : null}
      </div>

      <div className="command-mid">
        <section className="card pad">
          <div className="card-title">
            <h2>Readiness by workflow</h2>
            <span className="help right">Equal weighting</span>
          </div>
          {loaderData.workflows.map((workflow) => (
            <Link
              className="progress-row command-progress-link"
              to={workflow.href}
              key={workflow.key}
              aria-label={`${workflow.label}: ${workflow.score}% ready`}
            >
              <span>
                <strong>{workflow.label}</strong>
                <small className="subtle">{workflow.detail}</small>
              </span>
              <div className="progress" aria-hidden>
                <span style={{ width: `${workflow.score}%` }} />
              </div>
              <b>{workflow.score}%</b>
            </Link>
          ))}
        </section>

        <section className="card pad" id="action-queue">
          <div className="card-title">
            <h2>Action queue</h2>
            <StatusBadge
              tone={loaderData.blockers.length ? "warning" : "success"}
            >
              {loaderData.blockers.length} conditions
            </StatusBadge>
          </div>
          {loaderData.blockers.length ? (
            <div className="command-action-list">
              {loaderData.blockers.map((blocker) => (
                <Link
                  className="suggestion mb"
                  to={blocker.href}
                  key={blocker.key}
                >
                  <AlertTriangle aria-hidden size={17} />
                  <span>
                    <strong>
                      {blocker.count} {blocker.label.toLowerCase()}
                    </strong>
                    <small className="subtle">{blocker.action}</small>
                  </span>
                  <span className="chev" aria-hidden>
                    ›
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No readiness actions"
              description="There are no declared blockers in the current records."
              icon={CheckCircle2}
            />
          )}
        </section>

        <section className="card pad">
          <div className="card-title">
            <h2>AI readiness advisor</h2>
            <span className="status info">Advisory</span>
          </div>
          <ReadinessSummaryAction />
        </section>

        <section className="card pad">
          <div className="card-title">
            <h2>Targeted reminder assistant</h2>
            <span className="status warning">Preview first</span>
          </div>
          <ReminderDraftAction options={loaderData.reminderOptions} />
        </section>

        <section className="card pad">
          <div className="card-title">
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
                  className={
                    channel.percentage === 100 ? "tone-success" : "tone-warning"
                  }
                >
                  {channel.percentage}%
                </strong>
                <small className="subtle">
                  {channel.successful} / {channel.total}
                </small>
              </Link>
            ))
          ) : (
            <EmptyState
              title="No deliveries yet"
              description="Delivery health appears after communications are queued."
            />
          )}
        </section>
      </div>

      <div className="command-bottom">
        <section className="card pad">
          <div className="card-title">
            <h2>Upcoming published sessions</h2>
            <span className="help right">
              Times in {loaderData.eventTimezone}
            </span>
            <Link className="btn small" to="/admin/schedule">
              Open schedule
            </Link>
          </div>
          {loaderData.upcoming.length ? (
            <div className="agenda-list">
              {loaderData.upcoming.map((session) => (
                <Link
                  className="agenda-item command-agenda-link"
                  to={`/admin/schedule?session=${encodeURIComponent(session.id)}`}
                  key={session.id}
                >
                  <div className="date-chip">
                    <small>
                      {new Intl.DateTimeFormat("en", {
                        month: "short",
                        timeZone: loaderData.eventTimezone,
                      }).format(new Date(session.startsAt * 1_000))}
                    </small>
                    <strong>
                      {new Intl.DateTimeFormat("en", {
                        day: "numeric",
                        timeZone: loaderData.eventTimezone,
                      }).format(new Date(session.startsAt * 1_000))}
                    </strong>
                  </div>
                  <EventDateTime
                    epochSeconds={session.startsAt}
                    timeZone={loaderData.eventTimezone}
                    focusable={false}
                  >
                    <strong>
                      {new Intl.DateTimeFormat("en", {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: loaderData.eventTimezone,
                      }).format(new Date(session.startsAt * 1_000))}
                    </strong>
                  </EventDateTime>
                  <div>
                    <strong>{session.title}</strong>
                    <small className="subtle">{session.room}</small>
                  </div>
                  <DomainStatusBadge domain="session" status="published" />
                </Link>
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
          <div className="card-title">
            <h2>Background operations</h2>
            <Link className="btn small right" to="/admin/operations">
              View all
            </Link>
          </div>
          {loaderData.operations.length ? (
            <div className="table-wrap">
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
            <EmptyState
              title="No background operations"
              description="Bulk sends, publications and provider work will appear here."
            />
          )}
        </section>
      </div>
    </>
  );
}

function percentForOperation(completed: number, total: number) {
  return total > 0
    ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
    : 0;
}
