import { Form, Link, useNavigation, useSubmit } from "react-router";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { fieldLabel } from "~/lib/record-labels";
import { shortReference } from "~/lib/short-reference";
import {
  metadataOperationId,
  OperationDateTime,
  operationItemLink as itemLink,
  operationMetadataSummary as metadataSummary,
  operationTaskStatusLabel as statusLabel,
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
                <strong>{fieldLabel(item.action.replaceAll(".", " "))}</strong>
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
                      {fieldLabel(item.entityType)}
                      {item.entityId
                        ? ` ${shortReference(item.entityId)}`
                        : ""}
                    </Link>
                  ) : (
                    `${fieldLabel(item.entityType)}${item.entityId ? ` ${shortReference(item.entityId)}` : ""}`
                  )}
                  {operationId ? (
                    <>
                      {" "}
                      ·{" "}
                      <Link
                        to={`/admin/operations?operation=${encodeURIComponent(operationId)}`}
                      >
                        View operation
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
        <EmptyState
          title="No matching activity"
          description="Adjust the activity filters or start work in this event."
        />
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
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Background operations</h2>
        <span className="help right">
          Durable intent is recorded before provider work starts.
        </span>
      </div>
      {loaderData.operations.length ? (
        <div
          className="table-wrap"
          role="region"
          aria-label="Background operations"
          tabIndex={0}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Operation</th>
                <th scope="col">Status</th>
                <th scope="col">Progress</th>
                <th scope="col">Initiator / scope</th>
                <th scope="col">Started (UTC)</th>
                <th scope="col">Result</th>
                <th scope="col">Actions</th>
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
                        <strong>
                          {fieldLabel(operation.type.replaceAll(".", " "))}
                        </strong>
                      </Link>
                      {/* The full identifier stays here: this is the one
                          surface where an operator arrives holding one from a
                          log or a link, so it has to be matchable in full. */}
                      <small className="subtle" style={{ display: "block" }}>
                        Reference <code>{operation.id}</code>
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
                            event.preventDefault();
                            const form = event.currentTarget;
                            confirm(
                              {
                                title: "Retry this operation?",
                                description:
                                  "This may repeat external provider work that did not previously complete.",
                                records: [
                                  `${operation.type} · ${operation.id}`,
                                ],
                                confirmLabel: "Retry operation",
                                tone: "primary",
                              },
                              () => submit(form),
                            );
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
                            event.preventDefault();
                            const form = event.currentTarget;
                            confirm(
                              {
                                title: "Cancel this operation?",
                                description:
                                  "Only work that has not reached an external provider can be cancelled. Anything already sent stays in place.",
                                records: [
                                  `${operation.type} · ${operation.id}`,
                                ],
                                confirmLabel: "Cancel operation",
                              },
                              () => submit(form),
                            );
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
        <EmptyState
          title="No background operations yet"
          description="Imports, sends, calendar updates and publications will appear here."
        />
      )}
      {dialog}
    </section>
  );
}

export function OperationDetailPanel({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
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
            <div
              className="table-wrap pc-responsive-table-wrap"
              role="region"
              aria-label="Operation record results"
              tabIndex={0}
            >
              <table className="data-table pc-responsive-table operation-record-results-table">
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">Status</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Result</th>
                    <th scope="col">Actions</th>
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
                            {item.entityType
                              ? fieldLabel(item.entityType)
                              : "Operation item"}
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
                              ? `Task status: ${statusLabel(taskTransition.beforeStatus)} → ${statusLabel(taskTransition.afterStatus)} (${fieldLabel(taskTransition.transition).toLowerCase()})`
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
                                  event.preventDefault();
                                  const form = event.currentTarget;
                                  confirm(
                                    {
                                      title: "Retry only this record?",
                                      description:
                                        "Successful Accelevents records and other failed records will not be resent.",
                                      records: [label],
                                      confirmLabel: "Retry item",
                                      tone: "primary",
                                    },
                                    () => submit(form),
                                  );
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
                                  event.preventDefault();
                                  const form = event.currentTarget;
                                  confirm(
                                    {
                                      title: "Skip this record?",
                                      description:
                                        "This records an explicit omission with your reason and does not call Accelevents.",
                                      records: [label],
                                      confirmLabel: "Skip item",
                                    },
                                    () => submit(form),
                                  );
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
          <EmptyState
            title="No record-level items"
            description="This operation reports progress only at job level."
          />
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
          <EmptyState
            title="No linked audit events"
            description="Events linked to this operation will appear here."
          />
        )}
      </section>
      {dialog}
    </div>
  ) : null;
}
