import type { ReactNode } from "react";
import { Link } from "react-router";

import { eventBoundaryCalendarDate } from "~/modules/schedule/schedule-time";
import type { SubmissionFormSchema } from "~/modules/submissions/submission-schema";

type LandingForm = {
  name: string;
  eventName: string;
  eventSlug: string;
  eventTimezone: string;
  eventStartsAt: number;
  eventEndsAt: number;
  eventVenue: string | null;
  eventCity: string | null;
  eventDescription: string | null;
  participantWelcomeText: string | null;
  closesAt: number | null;
  minSpeakers: number;
  maxSpeakers: number | null;
  accessMode: "email_verified" | "account_required" | "password_protected";
  allowAnonymousDrafts: boolean;
  version: { schema: SubmissionFormSchema; versionNumber: number };
};

type FeaturedSpeaker = {
  id: string;
  displayName: string;
  imageUrl: string | null;
  organisationName: string | null;
  jobTitle: string | null;
};

function eventDateRange(form: LandingForm) {
  const formatter = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  const formatBoundary = (boundaryEpoch: number) =>
    formatter.format(
      new Date(`${eventBoundaryCalendarDate(boundaryEpoch)}T00:00:00Z`),
    );
  const start = formatBoundary(form.eventStartsAt);
  const end = formatBoundary(form.eventEndsAt);
  return start === end ? start : `${start} – ${end}`;
}

function closingDate(form: LandingForm) {
  if (form.closesAt === null) return "No closing date announced";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: form.eventTimezone,
  }).format(new Date(form.closesAt * 1_000));
}

function initials(value: string) {
  return value
    .split(/\s+/u)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("");
}

function speakerLimit(form: LandingForm) {
  if (form.maxSpeakers === null) {
    return `At least ${form.minSpeakers} speaker${form.minSpeakers === 1 ? "" : "s"} per proposal.`;
  }
  if (form.minSpeakers === form.maxSpeakers) {
    return `${form.minSpeakers} speaker${form.minSpeakers === 1 ? "" : "s"} per proposal.`;
  }
  return `${form.minSpeakers}–${form.maxSpeakers} speakers per proposal.`;
}

export function PublicApplicationLanding({
  form,
  accepting,
  availabilityReason,
  featuredSpeakers,
  programmeUrl,
  accessPanel,
}: {
  form: LandingForm;
  accepting: boolean;
  availabilityReason: string | null;
  featuredSpeakers: FeaturedSpeaker[];
  programmeUrl: string | null;
  accessPanel: ReactNode;
}) {
  const presentation = form.version.schema.presentation;
  const location = [form.eventVenue, form.eventCity].filter(Boolean).join(", ");
  const applicationFields = form.version.schema.fields;
  const hasConditionalFields = applicationFields.some(
    (field) => field.condition !== null,
  );
  const hasInvitation = Boolean(
    presentation.invitationHeading ||
    presentation.invitationText ||
    form.eventDescription ||
    presentation.organizerName ||
    presentation.organizerRole,
  );

  return (
    <div className="cfp-landing">
      <section
        className={`cfp-masthead${presentation.heroImagePath ? " has-image" : ""}`}
        style={
          presentation.heroImagePath
            ? {
                backgroundImage: `linear-gradient(90deg, rgba(8, 15, 38, .94), rgba(8, 15, 38, .3)), url(${JSON.stringify(presentation.heroImagePath).slice(1, -1)})`,
              }
            : undefined
        }
      >
        <div className="cfp-masthead-copy">
          <span className={`cfp-open-state ${accepting ? "open" : "closed"}`}>
            {accepting ? "Submissions open" : "Submissions unavailable"}
          </span>
          <h1>{form.eventName}</h1>
          <p className="cfp-thesis">{form.version.schema.introduction}</p>
          <dl className="cfp-event-facts">
            <div>
              <dt>Event</dt>
              <dd>{eventDateRange(form)}</dd>
            </div>
            {location ? (
              <div>
                <dt>Where</dt>
                <dd>{location}</dd>
              </div>
            ) : null}
            <div>
              <dt>Applications close</dt>
              <dd>
                {closingDate(form)} · {form.eventTimezone}
              </dd>
            </div>
          </dl>
          <div className="cfp-hero-actions">
            <a className="btn primary" href="#apply">
              {accepting
                ? "Continue to application"
                : "View application status"}
            </a>
            {programmeUrl ? (
              <Link className="btn cfp-on-dark" to={programmeUrl}>
                View programme
              </Link>
            ) : null}
            {presentation.eventWebsiteUrl ? (
              <a
                className="btn cfp-on-dark"
                href={presentation.eventWebsiteUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Event website
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : null}
          </div>
        </div>
      </section>

      <main id="main" className="cfp-main">
        {form.participantWelcomeText ? (
          <section className="card pad participant-welcome cfp-wide-notice">
            <span className="pc-page-eyebrow">From the event team</span>
            <p>{form.participantWelcomeText}</p>
          </section>
        ) : null}

        {!accepting && availabilityReason ? (
          <div className="validation-item warn card pad cfp-wide-notice">
            <strong>Notice</strong>
            <span>{availabilityReason}</span>
          </div>
        ) : null}

        <div
          className={`cfp-content-grid${hasInvitation ? "" : " without-invitation"}`}
        >
          {hasInvitation ? (
            <section className="cfp-editorial-section cfp-invitation">
              <h2>{presentation.invitationHeading || "About the event"}</h2>
              {form.eventDescription ? <p>{form.eventDescription}</p> : null}
              {presentation.invitationText ? (
                <p>{presentation.invitationText}</p>
              ) : null}
              {presentation.organizerName ? (
                <div className="cfp-organizer">
                  <span className="avatar" aria-hidden>
                    {initials(presentation.organizerName)}
                  </span>
                  <span>
                    <small>Organised by</small>
                    <strong>{presentation.organizerName}</strong>
                    {presentation.organizerRole ? (
                      <span>{presentation.organizerRole}</span>
                    ) : null}
                  </span>
                </div>
              ) : null}
            </section>
          ) : null}

          <aside className="cfp-entry" id="apply" aria-label="Apply">
            {accessPanel}
            <ul className="cfp-entry-assurances">
              <li>
                {form.allowAnonymousDrafts &&
                form.accessMode !== "account_required"
                  ? "Start privately; verify your email only before submission."
                  : form.accessMode === "account_required"
                    ? "A verified Program Cue account protects every saved draft."
                    : "Your verified email protects every saved draft."}
              </li>
              <li>
                Maintain multiple applications and return without losing work.
              </li>
              <li>{speakerLimit(form)}</li>
            </ul>
          </aside>

          <section
            className="cfp-editorial-section cfp-outline"
            aria-labelledby="outline-heading"
          >
            <div className="cfp-section-heading">
              <div>
                <h2 id="outline-heading">Preview the application</h2>
                <p>
                  {hasConditionalFields ? "Up to " : ""}
                  {applicationFields.length} proposal question
                  {applicationFields.length === 1 ? "" : "s"} · about{" "}
                  {presentation.estimatedMinutes} minutes
                </p>
              </div>
              <span className="pill">Form v{form.version.versionNumber}</span>
            </div>
            <ol className="cfp-question-outline">
              {applicationFields.map((field) => {
                const dependency = field.condition
                  ? applicationFields.find(
                      (candidate) => candidate.id === field.condition?.fieldId,
                    )
                  : null;
                return (
                  <li key={field.id}>
                    <div>
                      <strong>{field.label}</strong>
                      {field.required ? (
                        <span className="cfp-required">Required</span>
                      ) : (
                        <span className="subtle">Optional</span>
                      )}
                    </div>
                    {field.help ? <p>{field.help}</p> : null}
                    {field.condition && dependency ? (
                      <p className="cfp-condition">
                        Shown when {dependency.label}{" "}
                        {dependency.type === "multi_select" ? "includes" : "is"}{" "}
                        “{field.condition.equals}”.
                      </p>
                    ) : null}
                    {field.example ? (
                      <p className="cfp-example">
                        <span>Example</span> {field.example}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        {featuredSpeakers.length ? (
          <section className="cfp-featured" aria-labelledby="featured-heading">
            <div className="cfp-section-heading">
              <div>
                <h2 id="featured-heading">Meet speakers on the programme</h2>
                <p>Published speakers only—never private application data.</p>
              </div>
              {programmeUrl ? (
                <Link to={programmeUrl}>See full programme →</Link>
              ) : null}
            </div>
            <div className="cfp-featured-grid">
              {featuredSpeakers.map((speaker) => (
                <article className="cfp-speaker-card" key={speaker.id}>
                  {speaker.imageUrl ? (
                    <img
                      src={speaker.imageUrl}
                      alt=""
                      width={80}
                      height={80}
                      loading="lazy"
                    />
                  ) : (
                    <span className="cfp-speaker-avatar" aria-hidden>
                      {initials(speaker.displayName)}
                    </span>
                  )}
                  <h3>{speaker.displayName}</h3>
                  <p>
                    {[speaker.jobTitle, speaker.organisationName]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
