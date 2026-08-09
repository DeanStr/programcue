import { Cable, CalendarDays, ExternalLink, PlugZap } from "lucide-react";

import type { Route } from "./+types/admin-section";
import { EmptyState } from "~/components/ui/states";
import {
  formatProgrammeDateTime,
  summarizeProgramme,
} from "~/modules/programme/programme-presentation";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

type ProgrammeRow = {
  id: string;
  title: string;
  status: string;
  visibility: string;
  room: string | null;
  startsAt: number | null;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (
    !params.section ||
    !["programme", "integrations"].includes(params.section)
  ) {
    throw new Response("Admin section not found", { status: 404 });
  }
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);

  if (params.section === "programme") {
    const [sessions, version, event] = await Promise.all([
      env.DB.prepare(
        `
        SELECT s.id, s.title, s.status, s.visibility, r.name AS room, se.starts_at AS startsAt
          FROM sessions s
          LEFT JOIN schedule_versions sv ON sv.event_id = s.event_id AND sv.status = 'published'
            AND sv.version_number = (SELECT MAX(version_number) FROM schedule_versions WHERE event_id = s.event_id AND status = 'published')
          LEFT JOIN schedule_entries se ON se.schedule_version_id = sv.id AND se.session_id = s.id
          LEFT JOIN rooms r ON r.id = se.room_id AND r.event_id = s.event_id
          JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
         WHERE s.event_id = ? AND s.status NOT IN ('archived','cancelled')
         ORDER BY se.starts_at IS NULL, se.starts_at, s.title
      `,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<ProgrammeRow>(),
      env.DB.prepare(
        `
        SELECT version_number AS versionNumber, status, published_at AS publishedAt
          FROM schedule_versions
         WHERE event_id = ? AND status = 'published'
         ORDER BY version_number DESC LIMIT 1
      `,
      )
        .bind(viewer.eventId)
        .first<{
          versionNumber: number;
          status: string;
          publishedAt: number | null;
        }>(),
      env.DB.prepare(
        `
        SELECT timezone, slug FROM events
         WHERE id = ? AND organisation_id = ?
      `,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ timezone: string; slug: string }>(),
    ]);
    if (!event) throw new Response("Event not found", { status: 404 });
    return {
      section: "programme" as const,
      sessions: sessions.results,
      version,
      timezone: event.timezone,
      publicSlug: event.slug,
    };
  }

  const [connections, runs] = await Promise.all([
    env.DB.prepare(
      `
      SELECT c.id, c.provider, c.status, c.direction, c.updated_at AS updatedAt
        FROM integration_connections c
        JOIN events e ON e.id = c.event_id AND e.organisation_id = ?
       WHERE c.event_id = ? ORDER BY c.updated_at DESC
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        id: string;
        provider: string;
        status: string;
        direction: string;
        updatedAt: number;
      }>(),
    env.DB.prepare(
      `
      SELECT r.id, r.status, r.direction, r.dry_run AS dryRun, r.created_at AS createdAt,
             c.provider
        FROM integration_runs r
        JOIN integration_connections c ON c.id = r.connection_id
        JOIN events e ON e.id = c.event_id AND e.organisation_id = ?
       WHERE c.event_id = ? ORDER BY r.created_at DESC LIMIT 20
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        id: string;
        status: string;
        direction: string;
        dryRun: number;
        createdAt: number;
        provider: string;
      }>(),
  ]);
  const attentionOnly =
    new URL(request.url).searchParams.get("filter") === "attention";
  return {
    section: "integrations" as const,
    connections: attentionOnly
      ? connections.results.filter((connection) =>
          ["failed", "needs_attention"].includes(connection.status),
        )
      : connections.results,
    runs: attentionOnly
      ? runs.results.filter((run) =>
          ["failed", "partially_failed"].includes(run.status),
        )
      : runs.results,
    attentionOnly,
    totalConnections: connections.results.length,
    totalRuns: runs.results.length,
  };
}

function statusTone(status: string) {
  if (["published", "connected", "succeeded"].includes(status))
    return "success";
  if (["failed", "needs_attention"].includes(status)) return "danger";
  return "info";
}

function operationalDateTime(epoch: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(epoch * 1_000));
}

export default function AdminSection({ loaderData }: Route.ComponentProps) {
  if (loaderData.section === "programme") {
    const summary = summarizeProgramme(loaderData.sessions);
    return (
      <>
        <div className="page-head">
          <div>
            <span className="pc-page-eyebrow">Publication overview</span>
            <h1>Programme</h1>
            <p>
              Inspect the programme that is available to attendees and continue
              editing in the schedule planner.
            </p>
          </div>
          <div className="page-actions">
            <a
              className="btn"
              href={`/public/programme/${loaderData.publicSlug}`}
              target="_blank"
              rel="noreferrer"
            >
              Public programme <ExternalLink aria-hidden size={13} />
            </a>
            <a className="btn primary" href="/admin/schedule">
              Open schedule
            </a>
          </div>
        </div>
        <div className="grid grid-4 mb">
          <section className="card metric">
            <div className="label">Sessions</div>
            <div className="value">{summary.total}</div>
          </section>
          <section className="card metric">
            <div className="label">Scheduled</div>
            <div className="value">{summary.scheduled}</div>
            <div className="helper">{summary.unscheduled} unscheduled</div>
          </section>
          <section className="card metric">
            <div className="label">Published public</div>
            <div className="value">{summary.publishedPublic}</div>
            <div className="helper">Scheduled and public</div>
          </section>
          <section className="card metric">
            <div className="label">Published version</div>
            <div className="value">
              {loaderData.version?.versionNumber ?? "—"}
            </div>
          </section>
        </div>
        <section className="card pad programme-records">
          <div className="card-title">
            <h2>Current programme records</h2>
            <span className="help right">
              Event timezone · {loaderData.timezone}
            </span>
            {loaderData.version ? (
              <span className="status success">Published</span>
            ) : (
              <span className="status warning">Not published</span>
            )}
          </div>
          {loaderData.sessions.length ? (
            <>
              <p className="programme-scroll-hint">
                <span aria-hidden>↔</span> Swipe horizontally to see all columns
              </p>
              <div
                className="table-wrap programme-table-wrap"
                tabIndex={0}
                aria-label="Programme records. Scroll horizontally to see all columns."
              >
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Time</th>
                      <th>Room</th>
                      <th>Attendee visibility</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loaderData.sessions.map((session) => (
                      <tr key={session.id}>
                        <td>
                          <strong>{session.title}</strong>
                        </td>
                        <td>
                          {session.startsAt !== null
                            ? formatProgrammeDateTime(
                                session.startsAt,
                                loaderData.timezone,
                              )
                            : "Unscheduled"}
                        </td>
                        <td>{session.room ?? "—"}</td>
                        <td>
                          {session.startsAt === null
                            ? `Not published · ${session.visibility} when scheduled`
                            : session.visibility}
                        </td>
                        <td>
                          <span
                            className={`status ${statusTone(session.status)}`}
                          >
                            {session.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <EmptyState
              title="No programme sessions"
              description="Accept a submission or create a direct session before scheduling the programme."
              icon={CalendarDays}
            />
          )}
        </section>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <span className="pc-page-eyebrow">Provider boundaries</span>
          <h1>Integrations</h1>
          <p>
            Connections appear only after a provider is explicitly configured;
            Program Cue does not simulate successful syncs.
          </p>
        </div>
        <div className="page-actions">
          <span className="status info">
            <PlugZap aria-hidden size={14} /> {loaderData.totalConnections}{" "}
            configured
          </span>
        </div>
      </div>
      {loaderData.attentionOnly ? (
        <div className="validation-item warn card pad mb" role="status">
          <strong>Needs attention</strong>
          <span>
            Showing failed connections and runs only.{" "}
            <a href="/admin/integrations">Clear filter</a>
          </span>
        </div>
      ) : null}
      <div className="grid grid-3 mb">
        <section className="card metric">
          <div className="label">Connections</div>
          <div className="value">{loaderData.totalConnections}</div>
        </section>
        <section className="card metric">
          <div className="label">Needs attention</div>
          <div className="value">
            {
              loaderData.connections.filter((connection) =>
                ["failed", "needs_attention"].includes(connection.status),
              ).length
            }
          </div>
        </section>
        <section className="card metric">
          <div className="label">Recent runs</div>
          <div className="value">{loaderData.totalRuns}</div>
        </section>
      </div>
      <section className="card pad">
        <div className="card-title">
          <h2>Configured connections</h2>
        </div>
        {loaderData.connections.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Direction</th>
                  <th>Status</th>
                  <th>Updated (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {loaderData.connections.map((connection) => (
                  <tr key={connection.id}>
                    <td>
                      <strong>{connection.provider}</strong>
                    </td>
                    <td>{connection.direction}</td>
                    <td>
                      <span
                        className={`status ${statusTone(connection.status)}`}
                      >
                        {connection.status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>{operationalDateTime(connection.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={
              loaderData.attentionOnly
                ? "No integration failures"
                : "No integrations configured"
            }
            description={
              loaderData.attentionOnly
                ? "No configured connection or recent run currently needs attention."
                : "Calendar and email providers are configured in their owning workflows. Airtable and Accelevents adapters are not implemented and will not silently replace D1."
            }
            icon={Cable}
          />
        )}
      </section>
      {loaderData.runs.length ? (
        <section className="card pad mt">
          <div className="card-title">
            <h2>Recent runs</h2>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Direction</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Started (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {loaderData.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.provider}</td>
                    <td>{run.direction}</td>
                    <td>{run.dryRun ? "Dry run" : "Live"}</td>
                    <td>
                      <span className={`status ${statusTone(run.status)}`}>
                        {run.status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>{operationalDateTime(run.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
