import { CalendarDays, ExternalLink } from "lucide-react";
import { useState } from "react";
import { data, Link } from "react-router";
import { ProgrammeEmbedBuilder } from "~/components/programme-embed-builder";
import { AdminWorkspaceTabs } from "~/components/ui/admin-workspace-tabs";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import { EmptyState } from "~/components/ui/states";
import { ProgrammeAdminService } from "~/modules/programme/programme-admin-service.server";
import { ProgrammeEmbedConfigurationError } from "~/modules/programme/programme-embed-configuration";
import {
  ProgrammeEmbedService,
  ProgrammeEmbedStateError,
} from "~/modules/programme/programme-embed-service.server";
import {
  formatProgrammeDateTime,
  summarizeProgramme,
} from "~/modules/programme/programme-presentation";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-section";

export const meta: Route.MetaFunction = () => [
  { title: "Programme publishing · Program Cue" },
];

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (params.section !== "programme") {
    throw new Response("Admin section not found", { status: 404 });
  }
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);

  const [overview, managedEmbeds] = await Promise.all([
    new ProgrammeAdminService(env).getOverview(viewer),
    new ProgrammeEmbedService(env).list(viewer),
  ]);
  const searchParams = new URL(request.url).searchParams;
  const createdSessionValues = searchParams.getAll("createdSession");
  const attentionValues = searchParams.getAll("attention");
  if (createdSessionValues.length > 1 || attentionValues.length > 1) {
    throw new Response("Invalid direct-session creation result", {
      status: 400,
    });
  }
  const createdSessionId = createdSessionValues[0] ?? null;
  const attention = attentionValues[0] ?? null;
  if (attention !== null && attention !== "1") {
    throw new Response("Invalid direct-session creation result", {
      status: 400,
    });
  }
  if (
    createdSessionId &&
    !overview.sessions.some((session) => session.id === createdSessionId)
  ) {
    throw new Response("Created session not found in this event", {
      status: 404,
    });
  }
  if (attention === "1" && !createdSessionId) {
    throw new Response("Invalid direct-session creation result", {
      status: 400,
    });
  }
  return {
    section: "programme" as const,
    ...overview,
    publicOrigin: new URL(request.url).origin,
    managedEmbeds,
    createdSessionId,
    createdSessionNeedsAttention: attention === "1",
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (params.section !== "programme") {
    throw new Response("Admin section not found", { status: 404 });
  }
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const service = new ProgrammeEmbedService(env);
  try {
    if (intent === "create-managed-embed") {
      await service.create(viewer, {
        name: form.get("name"),
        slug: form.get("slug"),
        installationNote: form.get("installationNote"),
        configurationJson: form.get("configurationJson"),
      });
      return data({ ok: true, message: "Managed embed saved as a draft." });
    }
    if (intent === "update-managed-embed") {
      await service.update(viewer, {
        id: form.get("id"),
        revision: form.get("revision"),
        name: form.get("name"),
        installationNote: form.get("installationNote"),
        configurationJson: form.get("configurationJson"),
        confirmed: form.get("confirmed"),
      });
      return data({
        ok: true,
        message: "Managed embed configuration updated.",
      });
    }
    if (intent === "transition-managed-embed") {
      const nextStatus = String(form.get("nextStatus") ?? "");
      await service.transition(viewer, {
        id: form.get("id"),
        revision: form.get("revision"),
        nextStatus,
        confirmed: form.get("confirmed"),
      });
      const labels: Record<string, string> = {
        active: "activated",
        paused: "paused",
        revoked: "permanently revoked",
      };
      const label = labels[nextStatus];
      if (!label) {
        throw new Error(
          "The managed embed service accepted an unsupported lifecycle state.",
        );
      }
      return data({
        ok: true,
        message: `Managed embed ${label}.`,
      });
    }
    return data(
      { ok: false, message: "Unsupported managed embed action." },
      { status: 400 },
    );
  } catch (error) {
    if (
      error instanceof ProgrammeEmbedStateError ||
      error instanceof ProgrammeEmbedConfigurationError
    ) {
      return data(
        { ok: false, message: error.message },
        {
          status:
            error instanceof ProgrammeEmbedStateError ? error.status : 422,
        },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function programmePulse(
  summary: ReturnType<typeof summarizeProgramme>,
  versionNumber: number | null,
  speakerCount: number,
) {
  const parts = [
    `${summary.total} ${summary.total === 1 ? "session" : "sessions"}`,
    `${summary.scheduled} scheduled`,
  ];
  if (summary.unscheduled > 0) {
    parts.push(`${summary.unscheduled} unscheduled`);
  }
  parts.push(`${summary.publishedPublic} public`);
  parts.push(
    versionNumber === null ? "not published" : `Version ${versionNumber}`,
  );
  parts.push(`${speakerCount} public speaker${speakerCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

type ProgrammeWorkspacePanel = "programme" | "builder" | "managed";

export default function AdminSection({ loaderData }: Route.ComponentProps) {
  const summary = summarizeProgramme(loaderData.sessions);
  const [activePanel, setActivePanel] =
    useState<ProgrammeWorkspacePanel>("programme");
  return (
    <div className="programme-publishing">
      <div className="page-head pc-page-header">
        <div>
          <h1>Programme publishing</h1>
          <p>
            Inspect the programme that is available to attendees and continue
            editing in the schedule planner.
          </p>
          <nav className="programme-header-links" aria-label="Related">
            <Link to="/admin/sessions/new?from=programme">
              Create direct session
            </Link>
            <Link
              to={`/public/programme/${loaderData.publicSlug}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Public programme <ExternalLink aria-hidden size={13} />
              <span className="sr-only">(opens in a new tab)</span>
            </Link>
            <Link
              to={`/public/programme/${loaderData.publicSlug}#speakers`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Speaker gallery <ExternalLink aria-hidden size={13} />
              <span className="sr-only">(opens in a new tab)</span>
            </Link>
            <Link to="/admin/content#content-review-title">Content review</Link>
            <Link to="/admin/content#content-files-title">File library</Link>
          </nav>
        </div>
        <div className="page-actions">
          <Link className="btn primary" to="/admin/schedule">
            Open schedule
          </Link>
        </div>
      </div>
      {loaderData.createdSessionId ? (
        <div
          className={`validation-item ${loaderData.createdSessionNeedsAttention ? "warn" : "ok"} card pad mb`}
          role="status"
        >
          <strong>Direct session created</strong>
          <span>
            The session is in the unscheduled programme.
            <Link
              to={`/admin/schedule?session=${encodeURIComponent(loaderData.createdSessionId)}&created=1${loaderData.createdSessionNeedsAttention ? "&attention=1" : ""}`}
            >
              Open the new session in Schedule Planner
            </Link>
            .
          </span>
        </div>
      ) : null}
      <p className="programme-pulse">
        {programmePulse(
          summary,
          loaderData.version?.versionNumber ?? null,
          loaderData.speakerCount,
        )}
      </p>
      <AdminWorkspaceTabs<ProgrammeWorkspacePanel>
        className="programme-workspace-tabs"
        label="Programme publishing views"
        panels={[
          { id: "programme", label: "Programme", meta: summary.total },
          { id: "builder", label: "Embed builder" },
          {
            id: "managed",
            label: "Managed embeds",
            meta: loaderData.managedEmbeds.length,
          },
        ]}
        activePanel={activePanel}
        onChange={setActivePanel}
      />
      <section
        className="programme-records programme-workspace-panel"
        hidden={activePanel !== "programme"}
      >
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
            <ul className="programme-record-list">
              {loaderData.sessions.map((session) => (
                <li className="programme-record-row" key={session.id}>
                  <strong className="programme-record-title">
                    {session.title}
                  </strong>
                  <span className="programme-record-time">
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
                  </span>
                  <DomainStatusBadge domain="session" status={session.status} />
                </li>
              ))}
            </ul>
            <section
              className="table-wrap programme-table-wrap"
              aria-label="Programme records"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
              tabIndex={0}
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
            </section>
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
        <div
          className="programme-workspace-panel"
          hidden={activePanel === "programme"}
        >
          <ProgrammeEmbedBuilder
            key={`${loaderData.publicSlug}:${loaderData.version.versionNumber}:${loaderData.version.publishedAt ?? "pending"}:${loaderData.brandAccent}:${loaderData.timezone}`}
            publicOrigin={loaderData.publicOrigin}
            publicSlug={loaderData.publicSlug}
            eventName={loaderData.eventName}
            eventAccent={loaderData.brandAccent}
            timezone={loaderData.timezone}
            sessions={loaderData.sessions}
            managedEmbeds={loaderData.managedEmbeds}
            activePanel={activePanel === "managed" ? "managed" : "builder"}
            onOpenBuilder={() => setActivePanel("builder")}
          />
        </div>
      ) : (
        <section
          className="programme-embed-unavailable programme-workspace-panel"
          hidden={activePanel === "programme"}
        >
          <h2>Embed unavailable</h2>
          <p>
            Publish a schedule before configuring or installing its public
            programme embed.
          </p>
        </section>
      )}
    </div>
  );
}
