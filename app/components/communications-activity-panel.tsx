import { Send } from "lucide-react";
import { Form, Link, useSubmit } from "react-router";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { requireValue } from "~/lib/required-value";
import type { CommunicationsCentreLoaderData } from "~/routes/communications-centre";
import {
  communicationCategoryLabel,
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
        <section
          className="table-wrap"
          aria-label="Recent communications"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
        >
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
                      <div className="page-actions">
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
                          <button
                            type="submit"
                            className="btn small"
                            disabled={working}
                          >
                            {working && pendingIntent === "cancel"
                              ? "Cancelling…"
                              : "Cancel"}
                          </button>
                        </Form>
                        {item.status === "failed" && item.operationId ? (
                          <Link
                            className="btn small"
                            to={`/admin/operations?operation=${encodeURIComponent(item.operationId)}`}
                          >
                            Retry in Operations
                          </Link>
                        ) : null}
                      </div>
                    ) : item.operationId ? (
                      <Link
                        className="btn small"
                        to={`/admin/operations?operation=${encodeURIComponent(item.operationId)}`}
                      >
                        Details
                      </Link>
                    ) : null}
                    <Link
                      className="btn small"
                      to={`/admin/communications?deliveryCommunication=${encodeURIComponent(item.id)}#communications-health`}
                    >
                      Deliveries
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <EmptyState
          className="comms-empty"
          icon={Send}
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

function DeliveryReason({
  code,
  message,
}: {
  code: string | null;
  message: string | null;
}) {
  if (!code && !message)
    return <span className="subtle">No provider reason recorded</span>;
  return (
    <span>
      {message ?? code}
      {message && code ? <small>{code}</small> : null}
    </span>
  );
}

export function CommunicationDeliveryHealth({
  loaderData,
}: {
  loaderData: CommunicationsCentreLoaderData;
}) {
  const health = loaderData.deliveryHealth;
  const selected =
    health.scope.kind === "communication" ? health.scope.communication : null;
  const eventPeriod =
    health.scope.kind === "event" ? health.scope.period : "recent";
  const pageQuery = (offset: number) =>
    `/admin/communications?${new URLSearchParams({
      deliveryCommunication: requireValue(
        selected,
        "Required selected is unavailable.",
      ).id,
      deliveryOffset: String(offset),
    })}#communications-health`;
  return (
    <section
      className="card pad mb"
      id="communications-health"
      aria-labelledby="communications-health-title"
    >
      <div className="card-title">
        <div>
          <h2 id="communications-health-title">Delivery health</h2>
          <p className="subtle">
            {selected
              ? `Selected communication · ${selected.id} · created ${formatDate(selected.createdAt, loaderData.eventTimezone)}`
              : eventPeriod === "lifetime"
                ? "Current event · event lifetime"
                : "Current event · last 90 days"}
          </p>
        </div>
        <div className="page-actions right">
          <span className="status info">
            {health.summary.total} deliver
            {health.summary.total === 1 ? "y" : "ies"}
          </span>
          {selected ? (
            <>
              {selected.operationId ? (
                <Link
                  className="btn small"
                  to={`/admin/operations?operation=${encodeURIComponent(selected.operationId)}`}
                >
                  Exact operation
                </Link>
              ) : null}
              <Link
                className="btn small"
                to="/admin/communications#communications-health"
              >
                Event summary
              </Link>
            </>
          ) : eventPeriod === "lifetime" ? (
            <Link
              className="btn small"
              to="/admin/communications#communications-health"
            >
              Last 90 days
            </Link>
          ) : (
            <Link
              className="btn small"
              to="/admin/communications?deliveryPeriod=lifetime#communications-health"
            >
              Event lifetime
            </Link>
          )}
        </div>
      </div>
      <div className="grid grid-5 is-equal">
        {[
          ["Pending", health.summary.pending],
          ["Sent", health.summary.sent],
          ["Delivered", health.summary.delivered],
          ["Problems", health.summary.problems],
          ["Cancelled", health.summary.cancelled],
        ].map(([label, value]) => (
          <div className="metric card" key={String(label)}>
            <div className="label">{label}</div>
            <div className="value">{value}</div>
          </div>
        ))}
      </div>
      <p className="help mt">
        Each delivery is counted once from its current stored state. Opened and
        clicked are included under Delivered; Sent means the provider accepted
        the message but delivery has not been confirmed.
      </p>

      {selected ? (
        <div className="mt">
          <h3>Recipient deliveries</h3>
          {health.deliveryPage.rows.length ? (
            <section
              className="table-wrap"
              aria-label="Selected communication recipient deliveries"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
              tabIndex={0}
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Recipient</th>
                    <th scope="col">Current state</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Recorded reason</th>
                    <th scope="col">Updated ({loaderData.eventTimezone})</th>
                  </tr>
                </thead>
                <tbody>
                  {health.deliveryPage.rows.map((delivery) => (
                    <tr key={delivery.id}>
                      <td>
                        {delivery.recipientName ? (
                          <strong>{delivery.recipientName}</strong>
                        ) : null}
                        <span>{delivery.recipientAddress}</span>
                      </td>
                      <td>
                        <DomainStatusBadge
                          domain="communication"
                          status={delivery.status}
                        />
                      </td>
                      <td>{delivery.attemptCount}</td>
                      <td>
                        <DeliveryReason
                          code={delivery.failureCode}
                          message={delivery.failureMessage}
                        />
                      </td>
                      <td>
                        {formatDate(
                          delivery.updatedAt,
                          loaderData.eventTimezone,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : (
            <p className="subtle">This communication has no delivery rows.</p>
          )}
          {health.deliveryPage.hasPrevious || health.deliveryPage.hasNext ? (
            <nav
              className="page-actions mt"
              aria-label="Recipient delivery pages"
            >
              {health.deliveryPage.hasPrevious ? (
                <Link
                  className="btn small"
                  to={pageQuery(Math.max(0, health.deliveryPage.offset - 50))}
                >
                  Previous 50
                </Link>
              ) : null}
              {health.deliveryPage.hasNext ? (
                <Link
                  className="btn small"
                  to={pageQuery(health.deliveryPage.offset + 50)}
                >
                  Next 50
                </Link>
              ) : null}
            </nav>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-2 mt">
        <section>
          <h3>Latest recorded problems</h3>
          {health.recentProblems.length ? (
            <ul className="list-clean stack">
              {health.recentProblems.map((problem) => (
                <li className="card pad" key={problem.id}>
                  <div className="card-title">
                    <strong>
                      {problem.recipientName ?? problem.recipientAddress}
                    </strong>
                    <DomainStatusBadge
                      className="right"
                      domain="communication"
                      status={problem.status}
                    />
                  </div>
                  {problem.recipientName ? (
                    <p>{problem.recipientAddress}</p>
                  ) : null}
                  <DeliveryReason
                    code={problem.failureCode}
                    message={problem.failureMessage}
                  />
                  {problem.operationId ? (
                    <p>
                      <Link
                        to={`/admin/operations?operation=${encodeURIComponent(problem.operationId)}`}
                      >
                        Open exact operation
                      </Link>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="subtle">
              No bounced, suppressed or failed deliveries in scope.
            </p>
          )}
        </section>
        <section>
          <h3>Latest active exclusions</h3>
          <p className="subtle">Current event · up to 30 in each category</p>
          <h4>Latest recipient unsubscribes</h4>
          {health.suppressions.recipient.length ? (
            <ul className="list-clean">
              {health.suppressions.recipient.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.address}</strong>
                  <small>
                    {communicationCategoryLabel(entry.category)} · recipient
                    unsubscribe
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="subtle">No active recipient unsubscribes.</p>
          )}
          <h4>Latest provider suppressions and complaints</h4>
          {health.suppressions.provider.length ? (
            <ul className="list-clean">
              {health.suppressions.provider.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.address}</strong>
                  <small>{entry.reason?.replace("email.", "")}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="subtle">
              No active provider suppressions or complaints.
            </p>
          )}
          <p className="help mt">
            Bounces remain delivery outcomes above; they are not presented as
            recipient unsubscribe choices.
          </p>
        </section>
      </div>
    </section>
  );
}
