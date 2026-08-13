import { CalendarDays, ExternalLink } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/admin-section";
import { ProgrammeEmbedBuilder } from "~/components/programme-embed-builder";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import { EmptyState } from "~/components/ui/states";
import {
  formatProgrammeDateTime,
  summarizeProgramme,
} from "~/modules/programme/programme-presentation";
import { ProgrammeAdminService } from "~/modules/programme/programme-admin-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (params.section !== "programme") {
    throw new Response("Admin section not found", { status: 404 });
  }
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);

  const overview = await new ProgrammeAdminService(env).getOverview(viewer);
  return {
    section: "programme" as const,
    ...overview,
    publicOrigin: new URL(request.url).origin,
  };
}

export default function AdminSection({ loaderData }: Route.ComponentProps) {
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
          <Link
            className="btn"
            to={`/public/programme/${loaderData.publicSlug}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Public programme <ExternalLink aria-hidden size={13} />
            <span className="sr-only">(opens in a new tab)</span>
          </Link>
          <Link
            className="btn"
            to={`/public/programme/${loaderData.publicSlug}#speakers`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Speaker gallery <ExternalLink aria-hidden size={13} />
            <span className="sr-only">(opens in a new tab)</span>
          </Link>
          <Link className="btn primary" to="/admin/schedule">
            Open schedule
          </Link>
          <Link className="btn" to="/admin/content#content-review-title">
            Content review
          </Link>
          <Link className="btn" to="/admin/content#content-files-title">
            File library
          </Link>
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
          <div className="helper">
            {loaderData.speakerCount} public speaker
            {loaderData.speakerCount === 1 ? "" : "s"}
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
                        {session.startsAt !== null ? (
                          <EventDateTime
                            epochSeconds={session.startsAt}
                            timeZone={loaderData.timezone}
                          >
                            {formatProgrammeDateTime(
                              session.startsAt,
                              loaderData.timezone,
                            )}
                          </EventDateTime>
                        ) : (
                          "Unscheduled"
                        )}
                      </td>
                      <td>{session.room ?? "—"}</td>
                      <td>
                        {session.startsAt === null
                          ? `Not published · ${session.visibility} when scheduled`
                          : session.visibility}
                      </td>
                      <td>
                        <DomainStatusBadge
                          domain="session"
                          status={session.status}
                        />
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
      {loaderData.version ? (
        <ProgrammeEmbedBuilder
          key={`${loaderData.publicSlug}:${loaderData.version.versionNumber}:${loaderData.version.publishedAt ?? "pending"}:${loaderData.brandAccent}:${loaderData.timezone}`}
          publicOrigin={loaderData.publicOrigin}
          publicSlug={loaderData.publicSlug}
          eventName={loaderData.eventName}
          eventAccent={loaderData.brandAccent}
          timezone={loaderData.timezone}
          sessions={loaderData.sessions}
        />
      ) : (
        <section className="card pad mt">
          <span className="pc-page-eyebrow">Published programme</span>
          <h2>Embed unavailable</h2>
          <p className="help">
            Publish a schedule before configuring or installing its public
            programme embed.
          </p>
        </section>
      )}
    </>
  );
}
