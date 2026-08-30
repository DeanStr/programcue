import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import type { SpeakerProfileRevision } from "~/modules/speakers/speaker-profile-revision.server";

type ParticipantVisibleRevision = Omit<
  SpeakerProfileRevision,
  | "displayName"
  | "biography"
  | "pronunciation"
  | "organisationName"
  | "jobTitle"
> &
  Partial<
    Pick<
      SpeakerProfileRevision,
      | "displayName"
      | "biography"
      | "pronunciation"
      | "organisationName"
      | "jobTitle"
    >
  >;

export function SpeakerProfileHistory({
  revisions,
  timeZone,
}: {
  revisions: ParticipantVisibleRevision[];
  timeZone: string;
}) {
  return (
    <section
      className="card inset pad mt"
      aria-labelledby="profile-history-title"
    >
      <div className="card-title">
        <div>
          <h3 id="profile-history-title">Public profile history</h3>
          <p className="subtle">
            Read-only evidence. Restoring an old identity or headshot is not
            available yet.
          </p>
        </div>
        <span className="pill right">{revisions.length}</span>
      </div>
      {revisions.length ? (
        <ol className="timeline">
          {revisions.map((revision) => (
            <li key={revision.id}>
              <div className="card-title">
                <strong>
                  {revision.displayName ?? "Profile"} · revision{" "}
                  {revision.profileRevision}
                </strong>
                <DomainStatusBadge
                  domain="content"
                  status={revision.publicationStatus}
                />
              </div>
              <span>
                {revision.source === "canonical_person"
                  ? "Participant-owned identity"
                  : "Organisation-owned profile"}
                {revision.recordedByName
                  ? ` · recorded by ${revision.recordedByName}`
                  : ""}{" "}
                ·{" "}
                <EventDateTime
                  epochSeconds={revision.createdAt}
                  timeZone={timeZone}
                  showTimeZone
                />
              </span>
              <small className="subtle">
                {[revision.jobTitle, revision.organisationName]
                  .filter(Boolean)
                  .join(" · ") || "No title or organisation"}
                {revision.pronunciation
                  ? ` · pronunciation: ${revision.pronunciation}`
                  : ""}
                {revision.headshotFileVersionId
                  ? " · released headshot recorded"
                  : " · no released headshot"}
              </small>
              {revision.biography ? (
                <details>
                  <summary>Biography at this revision</summary>
                  <p className="mt">{revision.biography}</p>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="subtle">
          No profile revisions have been recorded since history was enabled.
        </p>
      )}
    </section>
  );
}
