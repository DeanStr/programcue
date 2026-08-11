import { Form, Link } from "react-router";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import type { CommunicationsCentreLoaderData } from "~/routes/communications-centre";
import {
  formatCommunicationDate as formatDate,
  type PendingIntent,
} from "./communications-panel-shared";

export function RecentCommunications({
  loaderData,
  working,
  pendingIntent,
}: {
  loaderData: CommunicationsCentreLoaderData;
  working: boolean;
  pendingIntent: PendingIntent;
}) {
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Recent communications</h2>
        <span className="status info right">
          {loaderData.communications.length}
        </span>
      </div>
      {loaderData.communications.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Created ({loaderData.eventTimezone})</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.communications.map((item) => (
                <tr key={item.id}>
                  <td>
                    {formatDate(item.createdAt, loaderData.eventTimezone)}
                    {item.scheduledAt ? (
                      <small>
                        Scheduled{" "}
                        {formatDate(item.scheduledAt, loaderData.eventTimezone)}
                      </small>
                    ) : null}
                    <small>{item.id}</small>
                  </td>
                  <td>
                    <DomainStatusBadge
                      domain="communication"
                      status={item.status}
                    />
                  </td>
                  <td>
                    {item.sentCount}/{item.recipientCount} sent
                    {item.failedCount ? ` · ${item.failedCount} failed` : ""}
                  </td>
                  <td>
                    {item.status === "draft" ? (
                      <Link
                        className="btn small"
                        to={`/admin/communications/compose/${item.id}`}
                      >
                        Resume
                      </Link>
                    ) : ["scheduled", "queued", "failed"].includes(
                        item.status,
                      ) ? (
                      <Form
                        method="post"
                        onSubmit={(event) => {
                          if (
                            !window.confirm(
                              `Cancel communication ${item.id}? Unsent deliveries will not be sent.`,
                            )
                          )
                            event.preventDefault();
                        }}
                      >
                        <input type="hidden" name="intent" value="cancel" />
                        <input
                          type="hidden"
                          name="communicationId"
                          value={item.id}
                        />
                        <button className="btn small" disabled={working}>
                          {working && pendingIntent === "cancel"
                            ? "Cancelling…"
                            : "Cancel"}
                        </button>
                      </Form>
                    ) : item.operationId ? (
                      <Link className="btn small" to="/admin/operations">
                        Details
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty compact">
          <p>No sends have been confirmed.</p>
        </div>
      )}
    </section>
  );
}
