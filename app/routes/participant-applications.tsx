import { ClipboardList, ExternalLink } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/participant-applications";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { ParticipantApplicationSummaryService } from "~/modules/submissions/participant-application-summary.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";

export const meta = () => [{ title: "Applications · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  return {
    ...(await new ParticipantApplicationSummaryService(env).getWorkspace(
      viewer,
    )),
  };
}

export default function ParticipantApplications({
  loaderData,
}: Route.ComponentProps) {
  return (
    <>
      <div className="page-head">
        <div>
          <span className="pc-page-eyebrow">Participant workspace</span>
          <h1>Applications</h1>
          <p>
            Track proposals you submitted and applications that include you as a
            co-speaker.
          </p>
        </div>
      </div>
      {loaderData.availableForms.length ? (
        <section
          className="card pad mt"
          aria-labelledby="available-forms-heading"
        >
          <div className="card-title">
            <div>
              <span className="pc-section-kicker">Start something new</span>
              <h2 id="available-forms-heading">Open forms</h2>
            </div>
          </div>
          <div className="page-actions">
            {loaderData.availableForms.map((form) => (
              <Link
                className="btn"
                to={`/apply/${encodeURIComponent(form.publicSlug)}`}
                key={form.id}
              >
                {form.name} <ExternalLink aria-hidden size={14} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      <section
        className="mt"
        aria-labelledby="participant-applications-heading"
      >
        <div className="card-title">
          <h2 id="participant-applications-heading">Your applications</h2>
          <span className="pill right">{loaderData.applications.length}</span>
        </div>
        {loaderData.applications.length ? (
          <div className="speaker-task-list">
            {loaderData.applications.map((application) => (
              <article className="card pad" key={application.id}>
                <div className="card-title">
                  <DomainStatusBadge
                    domain="submission"
                    status={application.status}
                  />
                  <span className="subtle tiny right">
                    {application.publicReference}
                  </span>
                </div>
                <h3>{application.title}</h3>
                <p className="subtle">
                  {application.formName} ·{" "}
                  {application.primarySubmitter
                    ? "Submitted by you"
                    : "You are a co-speaker"}
                </p>
                <p className="tiny subtle">
                  Updated{" "}
                  {new Intl.DateTimeFormat("en", {
                    dateStyle: "medium",
                  }).format(new Date(application.updatedAt))}
                </p>
                {application.primarySubmitter ? (
                  <Link
                    className="btn small"
                    to={`/apply/${encodeURIComponent(application.formSlug)}?${new URLSearchParams({ draft: application.id })}`}
                  >
                    {application.status === "draft"
                      ? "Continue application"
                      : "View application"}{" "}
                    <ExternalLink aria-hidden size={14} />
                  </Link>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="pc-empty-state card pad">
            <ClipboardList aria-hidden className="pc-state-icon" />
            <h2>No applications yet</h2>
            <p className="subtle">
              You have not started or joined an application for this event.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
