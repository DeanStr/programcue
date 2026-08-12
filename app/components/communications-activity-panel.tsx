import { Form, Link, useSubmit } from "react-router";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
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
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
  return (
    <section className="card pad">
      {dialog}
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
                <th scope="col">Created ({loaderData.eventTimezone})</th>
                <th scope="col">Status</th>
                <th scope="col">Progress</th>
                <th scope="col">Actions</th>
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
                          event.preventDefault();
                          const form = event.currentTarget;
                          confirm(
                            {
                              title: "Cancel this communication?",
                              description: `${item.recipientCount - item.sentCount} of ${item.recipientCount} deliveries have not been sent and never will be. Deliveries already sent cannot be recalled.`,
                              records: [item.id],
                              confirmLabel: "Cancel communication",
                              cancelLabel: "Keep communication",
                            },
                            () => submit(form),
                          );
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
        <EmptyState
          title="No sends have been confirmed"
          description="Confirmed and scheduled communications appear here with their delivery progress."
          action={
            <Link className="btn primary" to="/admin/communications/compose">
              Compose a communication
            </Link>
          }
        />
      )}
    </section>
  );
}
