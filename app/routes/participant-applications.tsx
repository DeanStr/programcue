import { ClipboardList, ExternalLink } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/participant-applications";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { ParticipantApplicationSummaryService } from "~/modules/submissions/participant-application-summary.server";
import { visibleFields } from "~/modules/submissions/submission-schema";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";

export const meta = () => [{ title: "Applications · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const selectedApplicationId = new URL(request.url).searchParams.get(
    "application",
  );
  return {
    ...(await new ParticipantApplicationSummaryService(env).getWorkspace(
      viewer,
      selectedApplicationId,
    )),
  };
}

function ApplicationDetail({
  application,
}: {
  application: NonNullable<
    Route.ComponentProps["loaderData"]["selectedApplication"]
  >;
}) {
  const snapshot = application.submittedSnapshot;
  const schema = snapshot?.schema ?? application.schema;
  const answers = snapshot?.answers ?? application.answers;
  const answerRows = visibleFields(schema, answers).flatMap((field) => {
    const value = answers[field.id];
    if (value === undefined || value === "" || value.length === 0) return [];
    return [{ id: field.id, label: field.label, value }];
  });
  const canOpenForm =
    application.primarySubmitter && application.formStatus === "published";

  return (
    <section
      className="card pad mt"
      id="participant-application-detail"
      aria-labelledby="participant-application-detail-heading"
    >
      <div className="card-title">
        <div>
          <span className="pc-section-kicker">Application detail</span>
          <h2 id="participant-application-detail-heading">
            {application.title}
          </h2>
          <p className="subtle">
            {application.formName} · {application.publicReference}
          </p>
        </div>
        <DomainStatusBadge domain="submission" status={application.status} />
      </div>
      {answerRows.length ? (
        <dl className="stack mt">
          {answerRows.map((answer) => (
            <div className="card inset pad" key={answer.id}>
              <dt className="tiny subtle">{answer.label}</dt>
              <dd style={{ margin: "4px 0 0" }}>
                {Array.isArray(answer.value)
                  ? answer.value.join(", ")
                  : answer.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="subtle mt">No application answers have been saved yet.</p>
      )}
      {snapshot?.speakers.length ? (
        <div className="mt">
          <h3>Speakers</h3>
          <ul>
            {snapshot.speakers.map((speaker) => (
              <li key={speaker.email}>
                {speaker.name} · {speaker.email}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="page-actions mt">
        {canOpenForm ? (
          <Link
            className="btn primary"
            to={`/apply/${encodeURIComponent(application.formSlug)}?${new URLSearchParams({ draft: application.id })}`}
          >
            {application.status === "draft"
              ? "Continue application"
              : "Open application workflow"}{" "}
            <ExternalLink aria-hidden size={14} />
          </Link>
        ) : null}
        <Link className="btn" to="/participant/applications">
          Close detail
        </Link>
      </div>
      {!canOpenForm && application.primarySubmitter ? (
        <p className="help mt">
          This form is no longer published. The saved application remains
          available here as a read-only record.
        </p>
      ) : null}
    </section>
  );
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
      {loaderData.selectedApplication ? (
        <ApplicationDetail application={loaderData.selectedApplication} />
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
                <Link
                  className="btn small"
                  to={`?${new URLSearchParams({ application: application.id })}#participant-application-detail`}
                >
                  View application
                </Link>
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
