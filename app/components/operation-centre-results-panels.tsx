import {
  Form,
  Link,
  useLocation,
  useNavigation,
  useSubmit,
} from "react-router";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { fieldLabel } from "~/lib/record-labels";
import { shortReference } from "~/lib/short-reference";
import {
  operationItemLink as itemLink,
  operationMetadataSummary as metadataSummary,
  type OperationCentreData,
  OperationDateTime,
  operationTaskStatusLabel as statusLabel,
  taskImportTransitionSummary,
} from "./operation-centre-shared";

export function ActivityTimelinePanel({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
  const location = useLocation();
  const olderActivityHref = loaderData.activityNextCursor
    ? (() => {
        const search = new URLSearchParams(location.search);
        search.set("activityCursor", loaderData.activityNextCursor);
        return `${location.pathname}?${search}`;
      })()
    : null;
  return loaderData.panel === "activity" ? (
    <section className="card pad mb" aria-labelledby="activity-heading">
      <div className="card-title">
        <h2 id="activity-heading">
          {loaderData.activityScope === "organisation"
            ? "Organisation activity timeline"
            : "Event activity timeline"}
        </h2>
        <span className="help right">
          Immutable audit events · newest first
        </span>
      </div>
      <Form method="get" className="grid grid-3 mb">
        <input type="hidden" name="panel" value="activity" />
        {loaderData.canViewOrganisationActivity ? (
          <label className="label">
            Scope
            <select
              className="select"
              name="activityScope"
              defaultValue={loaderData.activityScope}
            >
              <option value="event">Current event</option>
              <option value="organisation">All organisation events</option>
            </select>
          </label>
        ) : (
          <input type="hidden" name="activityScope" value="event" />
        )}
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
          Find actors
          <input
            className="field"
            name="activityActorQuery"
            defaultValue={loaderData.activityFilters.actorSearch}
            maxLength={80}
            placeholder="Name or role…"
          />
        </label>
        <label className="label">
          Actor result
          <select
            className="select"
            name="activityActor"
            defaultValue={loaderData.activityFilters.actorKey}
          >
            <option value="">All actors</option>
            {loaderData.activityActors.map((actor) => (
              <option value={actor.key} key={actor.key}>
                {actor.name} · {fieldLabel(actor.kind)}
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
      {loaderData.canExportData && loaderData.activityScope === "event" ? (
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
            return (
              <li key={item.id}>
                <strong>{fieldLabel(item.action.replaceAll(".", " "))}</strong>
                <span>
                  {item.actorName} ·{" "}
                  <OperationDateTime
                    epoch={item.createdAt}
                    timeZone={loaderData.eventTimezone}
                  />{" "}
                  · {item.area} · {fieldLabel(item.origin)}
                </span>
                <small className="subtle">
                  {loaderData.activityScope === "organisation" ? (
                    <>
                      {item.eventName ?? "Removed event"}
                      {item.eventId ? ` ${shortReference(item.eventId)}` : ""} ·{" "}
                    </>
                  ) : null}
                  {entityHref ? (
                    <Link to={entityHref}>
                      {fieldLabel(item.entityType)}
                      {item.entityId ? ` ${shortReference(item.entityId)}` : ""}
                    </Link>
                  ) : (
                    `${fieldLabel(item.entityType)}${item.entityId ? ` ${shortReference(item.entityId)}` : ""}`
                  )}
                  {item.operationId ? (
                    <>
                      {" "}
                      ·{" "}
                      <Link
                        to={`/admin/operations?operation=${encodeURIComponent(item.operationId)}`}
                      >
                        View operation
                      </Link>
                    </>
                  ) : null}
                </small>
                {item.summary ? (
                  <small className="subtle">{item.summary}</small>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState
          title="No matching activity"
          description={`Adjust the activity filters or start work in this ${loaderData.activityScope}.`}
        />
      )}
      {olderActivityHref ? (
        <div className="page-actions mt">
          <Link className="btn" to={olderActivityHref}>
            Older activity
          </Link>
        </div>
      ) : null}
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
  const location = useLocation();
  const { confirm, dialog } = useConfirm();
  const failurePageHref = (page: number) => {
    const search = new URLSearchParams(location.search);
    search.set("status", "failed");
    search.set("page", String(page));
    search.delete("operation");
    return `${location.pathname}?${search}`;
  };
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
                      <div>
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
                      </div>
                      {operation.alertAcknowledgedAt !== null ? (
                        <small className="subtle" style={{ display: "block" }}>
                          Alert archived by {operation.alertAcknowledgedByName}{" "}
                          ·{" "}
                          <OperationDateTime
                            epoch={operation.alertAcknowledgedAt}
                            timeZone={loaderData.eventTimezone}
                          />
                        </small>
                      ) : null}
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
                            type="submit"
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
                            type="submit"
                            className="btn small danger"
                            disabled={navigation.state !== "idle"}
                          >
                            Cancel
                          </button>
                        </Form>
                      ) : null}
                      {operation.canAcknowledgeFailure ? (
                        <Form
                          method="post"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            confirm(
                              {
                                title: "Archive this failure alert?",
                                description:
                                  "This removes the failure from active notifications and readiness blockers. The failed operation, recorded error and audit history remain available.",
                                records: [
                                  `${operation.type} · ${operation.id}`,
                                ],
                                confirmLabel: "Archive alert",
                                tone: "primary",
                              },
                              () => submit(form),
                            );
                          }}
                        >
                          <input
                            type="hidden"
                            name="intent"
                            value="acknowledge-failure"
                          />
                          <input
                            type="hidden"
                            name="operationId"
                            value={operation.id}
                          />
                          <button
                            type="submit"
                            className="btn small"
                            disabled={navigation.state !== "idle"}
                          >
                            Archive alert
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
      {loaderData.failurePagination &&
      !loaderData.selectedOperationId &&
      (loaderData.failurePagination.hasPrevious ||
        loaderData.failurePagination.hasNext) ? (
        <nav className="page-actions mt" aria-label="Failed operation pages">
          {loaderData.failurePagination.hasPrevious ? (
            <Link
              className="btn"
              to={failurePageHref(loaderData.failurePagination.page - 1)}
            >
              Previous page
            </Link>
          ) : null}
          <span className="help">
            Showing {loaderData.failurePagination.from}–
            {loaderData.failurePagination.to} of{" "}
            {loaderData.failurePagination.total} failed operations
          </span>
          {loaderData.failurePagination.hasNext ? (
            <Link
              className="btn"
              to={failurePageHref(loaderData.failurePagination.page + 1)}
            >
              Next page
            </Link>
          ) : null}
        </nav>
      ) : loaderData.failurePagination && !loaderData.selectedOperationId ? (
        <p className="help mt" role="status">
          Showing {loaderData.failurePagination.total} failed operation
          {loaderData.failurePagination.total === 1 ? "" : "s"}.
        </p>
      ) : null}
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
                                  type="submit"
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
                                  type="submit"
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
                {audit.summary ? (
                  <small className="subtle">{audit.summary}</small>
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
