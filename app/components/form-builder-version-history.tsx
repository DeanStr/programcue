import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import type { FormWorkspace } from "~/modules/submissions/submission-repository.server";

function publishedLabel(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

export function FormVersionHistory({
  workspace,
  eventTimezone,
}: {
  workspace: FormWorkspace;
  eventTimezone: string;
}) {
  return (
    <details className="fb-history" open>
      <summary>
        <strong>Version history</strong>
        <span>
          {workspace.versions.length}{" "}
          {workspace.versions.length === 1 ? "version" : "versions"} · times in{" "}
          {eventTimezone}
        </span>
      </summary>
      <section
        aria-label="Form version history"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable version history needs keyboard focus so arrow keys can expose overflow.
        tabIndex={0}
      >
        <ol className="fb-history-list">
          {workspace.versions.map((version) => (
            <li className="fb-history-item" key={version.id}>
              <strong>v{version.versionNumber}</strong>
              <DomainStatusBadge domain="version" status={version.status} />
              <span className="fb-history-when">
                {version.publishedAt
                  ? publishedLabel(version.publishedAt, eventTimezone)
                  : "Not published"}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </details>
  );
}
