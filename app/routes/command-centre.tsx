import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";

import type { Route } from "./+types/command-centre";
import { PageHeader } from "~/components/ui/page-header";
import { EmptyState } from "~/components/ui/states";
import { StatusBadge } from "~/components/ui/status-badge";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { ReadinessService } from "~/modules/readiness/readiness-service.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
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
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
  await ensureDemoEvaluationData(env);
  return new ReadinessService(env).getCommandCentre(viewer);
}

function operationTone(
  status: string,
): "success" | "danger" | "info" | "warning" {
  if (status === "completed") return "success";
  if (["failed", "queue_failed", "partially_failed"].includes(status))
    return "danger";
  if (["queued", "received"].includes(status)) return "warning";
  return "info";
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
        console.warn("Command Centre realtime transport error.", error),
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
            <a className="btn" href="/admin/event">
              Event settings
            </a>
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
          <a
            key={blocker.key}
            className={`card metric alert-${blocker.severity === "danger" ? "red" : "amber"} command-metric-link`}
            href={blocker.href}
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
          </a>
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
            <a
              className="progress-row command-progress-link"
              href={workflow.href}
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
            </a>
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
                <a
                  className="suggestion mb"
                  href={blocker.href}
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
                </a>
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
            <h2>Delivery health</h2>
          </div>
          {loaderData.deliveryHealth.length ? (
            loaderData.deliveryHealth.map((channel) => (
              <a
                href="/admin/communications"
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
              </a>
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
            <a className="btn small right" href="/admin/schedule">
              Open schedule
            </a>
          </div>
          {loaderData.upcoming.length ? (
            <div className="agenda-list">
              {loaderData.upcoming.map((session) => (
                <a
                  className="agenda-item command-agenda-link"
                  href={`/admin/schedule?session=${encodeURIComponent(session.id)}`}
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
                  <strong>
                    {new Intl.DateTimeFormat("en", {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: loaderData.eventTimezone,
                    }).format(new Date(session.startsAt * 1_000))}
                  </strong>
                  <div>
                    <strong>{session.title}</strong>
                    <small className="subtle">{session.room}</small>
                  </div>
                  <span className="status success">Published</span>
                </a>
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
            <a className="btn small right" href="/admin/operations">
              View all
            </a>
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
                        <a
                          href={`/admin/operations?operation=${encodeURIComponent(operation.id)}`}
                        >
                          {operation.type.replaceAll("_", " ")}
                        </a>
                      </td>
                      <td>
                        <StatusBadge tone={operationTone(operation.status)}>
                          {operation.status.replaceAll("_", " ")}
                        </StatusBadge>
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
