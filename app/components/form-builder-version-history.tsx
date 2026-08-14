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
    <section className="card pad mt">
      <div className="card-title">
        <h2>Version history</h2>
        <span className="subtle right">
          Published submissions retain their original form version.
        </span>
      </div>
      <div
        className="table-wrap"
        role="region"
        aria-label="Form version history"
        tabIndex={0}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Published ({eventTimezone})</th>
            </tr>
          </thead>
          <tbody>
            {workspace.versions.map((version) => (
              <tr key={version.id}>
                <td>
                  <strong>v{version.versionNumber}</strong>
                </td>
                <td>
                  <DomainStatusBadge
                    domain="version"
                    status={version.status}
                  />
                </td>
                <td>
                  {version.publishedAt
                    ? publishedLabel(version.publishedAt, eventTimezone)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
