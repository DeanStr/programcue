import { History } from "lucide-react";
import { EventDateTime } from "~/components/ui/event-date-time";
import type { StoredSchedulePublicationDigest } from "~/modules/schedule/schedule-publication-digest.server";
import { scheduleDateTimeLabel } from "./schedule-planner-workspace-helpers";

const categoryLabels = {
  added: "Added",
  removed: "Removed",
  moved: "Moved or resized",
  visibility: "Visibility",
  content: "Public content",
} as const;

export function SchedulePublicationDigestPanel({
  publication,
  timeZone,
}: {
  publication: StoredSchedulePublicationDigest | null;
  timeZone: string;
}) {
  if (!publication) return null;
  const { counts, highlights } = publication.digest;
  return (
    <section
      className="schedule-publication-digest"
      aria-labelledby="schedule-publication-digest-title"
    >
      <div className="schedule-publication-digest-head">
        <History aria-hidden size={19} />
        <div>
          <p className="eyebrow">Latest publication</p>
          <h2 id="schedule-publication-digest-title">
            Version {publication.versionNumber} change digest
          </h2>
          <p className="help">
            {publication.previousVersionNumber
              ? `Compared with published version ${publication.previousVersionNumber}. `
              : "Initial published baseline. "}
            Published{" "}
            <EventDateTime
              epochSeconds={publication.publishedAt}
              timeZone={timeZone}
              focusable={false}
            />
            .
          </p>
        </div>
      </div>
      <dl className="schedule-publication-digest-counts">
        {(
          Object.keys(categoryLabels) as Array<keyof typeof categoryLabels>
        ).map((key) => (
          <div key={key}>
            <dt>{categoryLabels[key]}</dt>
            <dd>{counts[key]}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>
          Review affected records · {counts.total} material change
          {counts.total === 1 ? "" : "s"}
        </summary>
        <div className="schedule-publication-digest-details">
          {highlights.added.length ? (
            <section>
              <h3>Added</h3>
              <ul>
                {highlights.added.map((item) => (
                  <li key={item.sessionId}>{item.title}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {highlights.removed.length ? (
            <section>
              <h3>Removed</h3>
              <ul>
                {highlights.removed.map((item) => (
                  <li key={item.sessionId}>{item.title}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {highlights.moved.length ? (
            <section>
              <h3>Moved or resized</h3>
              <ul>
                {highlights.moved.map((item) => (
                  <li key={item.sessionId}>
                    <strong>{item.title}</strong> · {item.from.room},{" "}
                    {scheduleDateTimeLabel(item.from.startsAt, timeZone)} →{" "}
                    {item.to.room},{" "}
                    {scheduleDateTimeLabel(item.to.startsAt, timeZone)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {highlights.visibility.length ? (
            <section>
              <h3>Visibility</h3>
              <ul>
                {highlights.visibility.map((item) => (
                  <li key={item.sessionId}>
                    {item.title} · {item.from} → {item.to}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {highlights.content.length ? (
            <section>
              <h3>Public content</h3>
              <ul>
                {highlights.content.map((item) => (
                  <li key={item.sessionId}>
                    {item.title} · {item.fields.join(", ")}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {counts.total === 0 ? (
            <p className="help">
              No placement, visibility or public content changes were detected.
            </p>
          ) : null}
          {(
            Object.keys(categoryLabels) as Array<keyof typeof categoryLabels>
          ).some((key) => counts[key] > highlights[key].length) ? (
            <p className="help">
              Counts are exact. This digest shows up to 20 affected records per
              category; the publication confirmation remains the full diff.
            </p>
          ) : null}
        </div>
      </details>
    </section>
  );
}
