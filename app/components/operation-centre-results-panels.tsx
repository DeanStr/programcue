import { Form, Link, useNavigation } from "react-router";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import {
  metadataOperationId,
  OperationDateTime,
  operationItemLink as itemLink,
  operationMetadataSummary as metadataSummary,
  operationStatusLabel as statusLabel,
  taskImportTransitionSummary,
  type OperationCentreData,
} from "./operation-centre-shared";

export function ActivityTimelinePanel({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
  return loaderData.panel === "activity" ? (
    <section className="card pad mb" aria-labelledby="activity-heading">
      <div className="card-title">
        <h2 id="activity-heading">Event activity timeline</h2>
        <span className="help right">
          Immutable audit events · newest first
        </span>
      </div>
      <Form method="get" className="grid grid-3 mb">
        <input type="hidden" name="panel" value="activity" />
        <label className="label">
          Area
          <select
            className="select"
            name="activityArea"
            defaultValue={loaderData.activityFilters.area}
          >
            <option value="">All areas</option>
            {loaderData.activityAreas.map((area) => (
              <option value={area} key={area}>
                {area.replace(/^./, (letter) => letter.toUpperCase())}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          Actor
          <select
            className="select"
            name="activityActor"
            defaultValue={loaderData.activityFilters.actorPersonId}
          >
            <option value="">All actors</option>
            {loaderData.activityActors.map((actor) => (
              <option value={actor.id} key={actor.id}>
                {actor.name}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          Action or record
          <input
            className="field"
            name="activityQuery"
            defaultValue={loaderData.activityFilters.query}
            maxLength={120}
            placeholder="schedule, decision, record id…"
          />
        </label>
        <div className="page-actions">
          <button className="btn primary" type="submit">
            Filter activity
          </button>
        </div>
      </Form>
      {loaderData.canExportData ? (
        <Form
          method="post"
          action="/admin/exports/audit.csv"
          reloadDocument
          className="page-actions mb"
        >
          <input
            type="hidden"
            name="idempotencyKey"
            value={loaderData.exportIntents.audit}
          />
          <button className="btn" type="submit">
            Download audit CSV
          </button>
        </Form>
      ) : null}
      {loaderData.activity.length ? (
        <ol className="timeline">
          {loaderData.activity.map((item) => {
            const entityHref = itemLink(item.entityType, item.entityId);
            const operationId = metadataOperationId(item.metadata);
            return (
              <li key={item.id}>
                <strong>
                  {item.action.replaceAll(".", " · ").replaceAll("_", " ")}
                </strong>
                <span>
                  {item.actorName} ·{" "}
                  <OperationDateTime
                    epoch={item.createdAt}
                    timeZone={loaderData.eventTimezone}
                  />{" "}
                  · {item.area}
                </span>
                <small className="subtle">
                  {entityHref ? (
                    <Link to={entityHref}>
                      {item.entityType}: {item.entityId}
                    </Link>
                  ) : (
                    `${item.entityType}${item.entityId ? `: ${item.entityId}` : ""}`
                  )}
                  {operationId ? (
                    <>
                      {" "}
                      ·{" "}
                      <Link
                        to={`/admin/operations?operation=${encodeURIComponent(operationId)}`}
                      >
                        operation {operationId}
                      </Link>
                    </>
                  ) : null}
                </small>
                {metadataSummary(item.metadata) ? (
                  <small className="subtle">
                    {metadataSummary(item.metadata)}
                  </small>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="empty">
          <h3>No matching activity</h3>
          <p>Adjust the activity filters or start work in this event.</p>
        </div>
      )}
    </section>
  ) : null;
}

export function OperationsListPanel({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
  const navigation = useNavigation();
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Background operations</h2>
        <span className="help right">
          Durable intent is recorded before provider work starts.
        </span>
      </div>
      {loaderData.operations.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Operation</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Initiator / scope</th>
                <th>Started (UTC)</th>
                <th>Result</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.operations.map((operation) => {
                const retryable = operation.retryable;
                return (
                  <tr key={operation.id}>
                    <td>
                      <Link
                        to={`/admin/operations?operation=${encodeURIComponent(operation.id)}`}
                      >
                        <strong>{operation.type}</strong>
                      </Link>
                      <small className="subtle" style={{ display: "block" }}>
                        {operation.id}
                      </small>
                    </td>
                    <td>
                      <DomainStatusBadge
                        domain="operation"
                        status={operation.status}
                      />
                    </td>
                    <td>
                      {operation.progressTotal
                        ? `${operation.progressCurrent} / ${operation.progressTotal}`
                        : "—"}
                    </td>
                    <td>
                      <strong>{operation.requestedByName ?? "System"}</strong>
                      <small className="subtle" style={{ display: "block" }}>
                        {operation.scope ?? "Event-wide"}
                      </small>
                    </td>
                    <td>
                      <OperationDateTime
                        epoch={operation.startedAt ?? operation.createdAt}
                        timeZone={loaderData.eventTimezone}
                      />
                    </td>
                    <td>
                      {operation.lastError ??
                        operation.warning ??
                        (operation.completedAt ? (
                          <OperationDateTime
                            epoch={operation.completedAt}
                            timeZone={loaderData.eventTimezone}
                          />
                        ) : (
                          "Pending"
                        ))}
                    </td>
                    <td>
                      {retryable ? (
                        <Form
                          method="post"
                          onSubmit={(event) => {
                            if (
                              !window.confirm(
                                `Retry ${operation.type} operation ${operation.id}? This may repeat external provider work that did not previously complete.`,
                              )
                            ) {
                              event.preventDefault();
                            }
                          }}
                        >
                          <input type="hidden" name="intent" value="retry" />
                          <input
                            type="hidden"
                            name="operationId"
                            value={operation.id}
                          />
                          <button
                            className="btn small"
                            disabled={navigation.state !== "idle"}
                          >
                            Retry
                          </button>
                        </Form>
                      ) : null}
                      {operation.cancellable &&
                      [
                        "queued",
                        "queue_failed",
                        "received",
                        "retrying",
                        "failed",
                        "partially_failed",
                      ].includes(operation.status) ? (
                        <Form
                          method="post"
                          onSubmit={(event) => {
                            if (
                              !window.confirm(
                                `Cancel ${operation.type} operation ${operation.id}? Only work that has not reached an external provider can be cancelled.`,
                              )
                            )
                              event.preventDefault();
                          }}
                        >
                          <input type="hidden" name="intent" value="cancel" />
                          <input
                            type="hidden"
                            name="operationId"
                            value={operation.id}
                          />
                          <button
                            className="btn small danger"
                            disabled={navigation.state !== "idle"}
                          >
                            Cancel
                          </button>
                        </Form>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <h2>No background operations yet</h2>
          <p>
            Imports, sends, calendar updates and publications will appear here.
          </p>
        </div>
      )}
    </section>
  );
}

export function OperationDetailPanel({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
  const navigation = useNavigation();
  return loaderData.operationDetail ? (
    <div className="grid grid-2 mt">
      <section
        className="card pad span-2"
        aria-labelledby="operation-items-heading"
      >
        <div className="card-title">
          <h2 id="operation-items-heading">Record-level results</h2>
          <span className="status info">
            {loaderData.operationDetail.items.length} item
            {loaderData.operationDetail.items.length === 1 ? "" : "s"}
          </span>
        </div>
        {loaderData.operationDetail.items.length ? (
          <>
            {loaderData.selectedOperation?.type ===
              "integration.accelevents.export" &&
            ["failed", "partially_failed"].includes(
              loaderData.selectedOperation.status,
            ) &&
            loaderData.operationDetail.items.some(
              (item) => item.status === "failed",
            ) ? (
              <p className="help table-scroll-hint">
                Failed records expose individual retry and explicit skip
                controls; successful records are not resent.
              </p>
            ) : null}
            <div className="table-wrap pc-responsive-table-wrap">
              <table className="data-table pc-responsive-table operation-record-results-table">
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Result</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loaderData.operationDetail.items.map((item) => {
                    const href = itemLink(item.entityType, item.entityId);
                    const label = item.entityId ?? item.itemKey;
                    const taskTransition =
                      loaderData.selectedOperation?.type === "data.import"
                        ? taskImportTransitionSummary(item.result)
                        : null;
                    const acceleventsFailure =
                      loaderData.selectedOperation?.type ===
                        "integration.accelevents.export" &&
                      ["failed", "partially_failed"].includes(
                        loaderData.selectedOperation.status,
                      ) &&
                      item.status === "failed";
                    return (
                      <tr key={item.id}>
                        <td
                          className="pc-record-primary-cell"
                          data-label="Record"
                        >
                          {href ? (
                            <Link to={href}>
                              <strong>{label}</strong>
                            </Link>
                          ) : (
                            <strong>{label}</strong>
                          )}
                          <small
                            className="subtle"
                            style={{ display: "block" }}
                          >
                            {item.entityType ?? "operation item"}
                          </small>
                        </td>
                        <td data-label="Status">
                          <DomainStatusBadge
                            domain="operation"
                            status={item.status}
                          />
                        </td>
                        <td data-label="Attempts">{item.attemptCount}</td>
                        <td data-label="Result">
                          {item.errorMessage ??
                            (taskTransition
                              ? `Task status: ${statusLabel(taskTransition.beforeStatus)} → ${statusLabel(taskTransition.afterStatus)} · transition: ${statusLabel(taskTransition.transition)}`
                              : metadataSummary(item.result)) ??
                            "—"}
                        </td>
                        <td
                          className="pc-record-action-cell operation-record-actions"
                          data-label="Actions"
                        >
                          {acceleventsFailure ? (
                            <div className="stack">
                              <Form
                                method="post"
                                onSubmit={(event) => {
                                  if (
                                    !window.confirm(
                                      `Retry only ${label}? Successful Accelevents records and other failed records will not be resent.`,
                                    )
                                  )
                                    event.preventDefault();
                                }}
                              >
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="retry-item"
                                />
                                <input
                                  type="hidden"
                                  name="operationId"
                                  value={loaderData.selectedOperation!.id}
                                />
                                <input
                                  type="hidden"
                                  name="itemId"
                                  value={item.id}
                                />
                                <button
                                  className="btn small"
                                  aria-label={`Retry ${label}`}
                                  disabled={navigation.state !== "idle"}
                                >
                                  Retry item
                                </button>
                              </Form>
                              <Form
                                method="post"
                                className="stack"
                                onSubmit={(event) => {
                                  if (
                                    !window.confirm(
                                      `Skip ${label}? This records an explicit omission and does not call Accelevents.`,
                                    )
                                  )
                                    event.preventDefault();
                                }}
                              >
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="skip-item"
                                />
                                <input
                                  type="hidden"
                                  name="operationId"
                                  value={loaderData.selectedOperation!.id}
                                />
                                <input
                                  type="hidden"
                                  name="itemId"
                                  value={item.id}
                                />
                                <label className="label">
                                  Skip reason
                                  <input
                                    className="field"
                                    name="reason"
                                    minLength={5}
                                    maxLength={500}
                                    required
                                  />
                                </label>
                                <button
                                  className="btn small danger"
                                  aria-label={`Skip ${label}`}
                                  disabled={navigation.state !== "idle"}
                                >
                                  Skip item
                                </button>
                              </Form>
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="empty">
            <h3>No record-level items</h3>
            <p>This operation reports progress only at job level.</p>
          </div>
        )}
      </section>
      <section
        className="card pad span-2"
        aria-labelledby="operation-audit-heading"
      >
        <div className="card-title">
          <h2 id="operation-audit-heading">Audit trail</h2>
          <span className="help right">Immutable event history</span>
        </div>
        {loaderData.operationDetail.audit.length ? (
          <ol className="timeline">
            {loaderData.operationDetail.audit.map((audit) => (
              <li key={audit.id}>
                <strong>{audit.action.replaceAll(".", " · ")}</strong>
                <span>
                  {audit.actorName} ·{" "}
                  <OperationDateTime
                    epoch={audit.createdAt}
                    timeZone={loaderData.eventTimezone}
                  />
                </span>
                {metadataSummary(audit.metadata) ? (
                  <small className="subtle">
                    {metadataSummary(audit.metadata)}
                  </small>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty">
            <h3>No linked audit events</h3>
            <p>Events linked to this operation will appear here.</p>
          </div>
        )}
      </section>
    </div>
  ) : null;
}
