import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useNavigation,
  useRevalidator,
} from "react-router";

import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import {
  EventDateTime,
  formatEventDateTime,
} from "~/components/ui/event-date-time";
import {
  subscribeToEventChanges,
  type RealtimeTransportStatus,
} from "~/platform/realtime/realtime-client";
import type { action, loader } from "~/routes/operation-centre.server";

type OperationCentreData = Awaited<ReturnType<typeof loader>>;

function OperationDateTime({
  epoch,
  timeZone,
}: {
  epoch: number;
  timeZone: string;
}) {
  return (
    <EventDateTime epochSeconds={epoch} timeZone={timeZone}>
      {formatEventDateTime(epoch, timeZone, {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </EventDateTime>
  );
}

function itemLink(entityType: string | null, entityId: string | null) {
  if (!entityType || !entityId) return null;
  if (["submission", "review", "decision"].includes(entityType))
    return `/admin/submissions/${encodeURIComponent(entityId)}`;
  if (["session", "schedule_entry"].includes(entityType))
    return `/admin/schedule?session=${encodeURIComponent(entityId)}`;
  if (["task", "task_instance"].includes(entityType))
    return `/admin/tasks?task=${encodeURIComponent(entityId)}`;
  if (["speaker", "person"].includes(entityType))
    return `/admin/speakers?person=${encodeURIComponent(entityId)}`;
  if (["communication", "communication_delivery"].includes(entityType))
    return "/admin/communications";
  if (
    ["integration", "integration_run", "integration_run_item"].includes(
      entityType,
    )
  )
    return "/admin/integrations";
  return null;
}

function metadataSummary(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value)
    .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))
    .slice(0, 4);
  return entries.length
    ? entries.map(([key, item]) => `${key}: ${String(item)}`).join(" · ")
    : null;
}

const taskImportTransitions = new Set([
  "progress",
  "complete",
  "approve",
  "waive",
  "reopen",
]);

export function taskImportTransitionSummary(value: unknown) {
  if (!value || typeof value !== "object" || !("values" in value)) return null;
  const values = value.values;
  if (!values || typeof values !== "object" || !("statusTransition" in values))
    return null;
  const fields = values as Record<string, unknown>;
  if (fields.statusTransition === "none") return null;
  if (
    typeof fields.statusTransition !== "string" ||
    !taskImportTransitions.has(fields.statusTransition) ||
    typeof fields.expectedStatus !== "string" ||
    typeof fields.status !== "string" ||
    typeof fields.id !== "string" ||
    typeof fields.title !== "string"
  ) {
    throw new Error(
      "A task import preview contains an invalid lifecycle transition.",
    );
  }
  return {
    taskId: fields.id,
    title: fields.title,
    beforeStatus: fields.expectedStatus,
    afterStatus: fields.status,
    transition: fields.statusTransition,
  };
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ");
}

function metadataOperationId(value: unknown) {
  if (!value || typeof value !== "object" || !("operationId" in value))
    return null;
  return typeof value.operationId === "string" ? value.operationId : null;
}

function OperationAutoRefresh({
  eventId,
  cursor,
}: {
  eventId: string;
  cursor: number;
}) {
  const revalidator = useRevalidator();
  const [transport, setTransport] =
    useState<RealtimeTransportStatus>("connecting");

  useEffect(() => {
    const url = `/admin/events/${encodeURIComponent(eventId)}/changes`;
    return subscribeToEventChanges({
      liveUrl: url,
      pollUrl: url,
      initialCursor: cursor,
      onInvalidate: (changes) => {
        if (
          changes.some((change) =>
            [
              "operation",
              "communication",
              "calendar_invitation",
              "integration_run",
              "file_version",
            ].includes(change.entityType),
          )
        )
          revalidator.revalidate();
      },
      onError: (error) =>
        console.warn("Operation Centre realtime transport error.", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      onStatusChange: setTransport,
    });
  }, [cursor, eventId, revalidator]);

  return (
    <span
      className={`status ${transport === "unavailable" ? "danger" : transport === "polling" ? "warning" : "info"}`}
      role="status"
      aria-live="polite"
    >
      <RefreshCw
        aria-hidden
        size={13}
        className={revalidator.state !== "idle" ? "pc-spin" : undefined}
      />
      {revalidator.state !== "idle"
        ? "Refreshing operations"
        : transport === "live"
          ? "Live operation updates"
          : transport === "polling"
            ? "Polling for operation updates"
            : transport === "unavailable"
              ? "Operation updates unavailable"
              : "Connecting operation updates"}
    </span>
  );
}

function AirtableRecoveryPanel({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
  const navigation = useNavigation();
  return loaderData.airtableRecoveries.length ? (
    <section
      className="card pad mb"
      aria-labelledby="airtable-recovery-heading"
    >
      <div className="card-title">
        <h2 id="airtable-recovery-heading">Airtable recovery</h2>
        <span className="status danger">
          {loaderData.airtableRecoveries.length} blocked projection
          {loaderData.airtableRecoveries.length === 1 ? "" : "s"}
        </span>
      </div>
      <p>
        These event-data commands committed their D1 projection but did not
        finish reconciling Airtable. Review the exact run before retrying;
        ordinary reads never recover it automatically.
      </p>
      <div className="stack">
        {loaderData.airtableRecoveries.map((run) => (
          <div className="validation-item warn" key={run.runId}>
            <div>
              <strong>{run.operation.replaceAll("_", " ")}</strong>
              <span>
                Run {run.runId} · {run.status.replaceAll("_", " ")} ·{" "}
                {run.phase.replaceAll("_", " ")} · {run.itemCount} managed
                change
                {run.itemCount === 1 ? "" : "s"}
              </span>
              {run.error ? <span>{run.error}</span> : null}
              <span>
                Projection {run.beforeHash.slice(0, 10)} →{" "}
                {run.afterHash?.slice(0, 10) ?? "pending"}
              </span>
            </div>
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="recover-airtable-projection"
              />
              <input type="hidden" name="operationId" value={run.runId} />
              <button
                className="btn danger"
                type="submit"
                disabled={navigation.state !== "idle"}
              >
                Retry this projection
              </button>
            </Form>
          </div>
        ))}
      </div>
    </section>
  ) : null;
}

function OperationFiltersPanel({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
  return (
    <section
      className="card pad mb"
      aria-labelledby="operation-filters-heading"
    >
      <div className="card-title">
        <h2 id="operation-filters-heading">Filter operations</h2>
        <span className="help right">Shareable URL filters</span>
      </div>
      <Form method="get" className="grid grid-3">
        <label className="label">
          Status
          <select
            className="select"
            name="status"
            defaultValue={loaderData.filters.status}
          >
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Needs attention</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label className="label">
          Operation type
          <select
            className="select"
            name="type"
            defaultValue={loaderData.filters.type}
          >
            <option value="">All types</option>
            {loaderData.types.map((type) => (
              <option value={type} key={type}>
                {type.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <div className="page-actions" style={{ alignItems: "end" }}>
          <button className="btn primary" type="submit">
            Apply filters
          </button>
          {loaderData.filterActive ? (
            <Link className="btn" to="/admin/operations">
              Clear
            </Link>
          ) : null}
        </div>
      </Form>
    </section>
  );
}

function DataExportPanel({ loaderData }: { loaderData: OperationCentreData }) {
  const exportResources = Object.keys(loaderData.exportIntents) as Array<
    keyof typeof loaderData.exportIntents
  >;

  return loaderData.panel === "exports" && loaderData.canExportData ? (
    <section className="card pad mb" aria-labelledby="event-exports-heading">
      <div className="card-title">
        <h2 id="event-exports-heading">Event data exports</h2>
        <span className="help right">UTF-8 CSV · current authorised event</span>
      </div>
      <p>
        Each download is recorded as a completed export operation and immutable
        audit event. Spreadsheet formula prefixes are neutralised.
      </p>
      <div className="page-actions">
        {exportResources.map((resource) => (
          <Form
            method="post"
            action={`/admin/exports/${resource}.csv`}
            reloadDocument
            key={resource}
          >
            <input
              type="hidden"
              name="idempotencyKey"
              value={loaderData.exportIntents[resource]}
            />
            <button className="btn" type="submit">
              {resource.replace(/^./, (letter) => letter.toUpperCase())} CSV
            </button>
          </Form>
        ))}
      </div>
    </section>
  ) : loaderData.panel === "exports" ? (
    <section className="card pad mb">
      <h2>Event data exports</h2>
      <p>Organisation owner access is required to export event data.</p>
    </section>
  ) : null;
}

function DataImportPanel({ loaderData }: { loaderData: OperationCentreData }) {
  const navigation = useNavigation();
  const previewedTaskTransitions =
    loaderData.selectedOperation?.type === "data.import"
      ? (loaderData.operationDetail?.items.flatMap((item) => {
          const transition = taskImportTransitionSummary(item.result);
          return transition ? [transition] : [];
        }) ?? [])
      : [];
  return loaderData.panel === "imports" ? (
    <section className="card pad mb" aria-labelledby="event-imports-heading">
      <div className="card-title">
        <h2 id="event-imports-heading">CSV import</h2>
        <span className="help right">Preview → validate → confirm</span>
      </div>
      <p>
        Upload up to 200 records. Program Cue reconciles stable email,
        reference, slug or name keys and makes no changes until every row is
        valid and you confirm the preview.
      </p>
      <Form method="post" encType="multipart/form-data" className="grid grid-3">
        <input type="hidden" name="intent" value="preview-import" />
        <label className="label">
          Record type
          <select className="select" name="resource" defaultValue="sessions">
            <option value="people">People</option>
            <option value="submissions">Submissions</option>
            <option value="sessions">Sessions</option>
            <option value="rooms">Rooms</option>
            <option value="tracks">Tracks</option>
            <option value="tasks">Tasks</option>
          </select>
        </label>
        <label className="label">
          CSV file
          <input
            className="field"
            type="file"
            name="csv"
            accept=".csv,text/csv"
            required
          />
        </label>
        <div className="page-actions" style={{ alignItems: "end" }}>
          <button
            className="btn primary"
            type="submit"
            disabled={navigation.state !== "idle"}
          >
            Preview import
          </button>
        </div>
      </Form>
      <p className="help mt">
        Submission imports create or update drafts only. New task imports always
        start not started. Existing task imports may apply only the validated
        lifecycle transition shown with its exact before and after status in the
        preview; submitted status still requires the participant evidence
        workflow.
      </p>
      <details className="mt">
        <summary>Required CSV columns</summary>
        <dl>
          <div>
            <dt>People</dt>
            <dd>
              <code>email,name,organisation,jobTitle,profileStatus,role</code>
            </dd>
          </div>
          <div>
            <dt>Submissions</dt>
            <dd>
              <code>
                publicReference,title,category,format,status,submitterEmail,submittedAt
              </code>
            </dd>
          </div>
          <div>
            <dt>Sessions</dt>
            <dd>
              <code>
                slug,title,description,trackSlug,format,durationMinutes,expectedAttendance,status,visibility
              </code>
            </dd>
          </div>
          <div>
            <dt>Rooms</dt>
            <dd>
              <code>name,building,level,capacity,position,status</code>
            </dd>
          </div>
          <div>
            <dt>Tracks</dt>
            <dd>
              <code>slug,name,colour,position,exclusive,public</code>
            </dd>
          </div>
          <div>
            <dt>Tasks</dt>
            <dd>
              <code>
                id,title,description,targetType,targetId,ownerEmail,status,statusReason,impact,dueAt
              </code>
            </dd>
          </div>
        </dl>
      </details>
      {loaderData.selectedOperation?.type === "data.import" &&
      loaderData.selectedOperation.status === "received" ? (
        <div
          className={`validation-item ${loaderData.operationDetail?.items.some((item) => item.status === "failed") ? "error" : "ok"} card pad mt`}
        >
          <strong>
            {loaderData.operationDetail?.items.some(
              (item) => item.status === "failed",
            )
              ? "Preview has invalid rows"
              : "Preview ready to commit"}
          </strong>
          <span>
            {loaderData.operationDetail?.items.length ?? 0} rows inspected.
            Review record-level results below.
          </span>
          {previewedTaskTransitions.length ? (
            <div className="card pad mt">
              <strong>
                {previewedTaskTransitions.length} task lifecycle change
                {previewedTaskTransitions.length === 1 ? "" : "s"}
              </strong>
              <span>
                Confirming this import commits every status change listed here.
              </span>
              <ul>
                {previewedTaskTransitions.map((transition) => (
                  <li key={transition.taskId}>
                    <strong>{transition.title}</strong>{" "}
                    {`(${transition.taskId}): ${statusLabel(transition.beforeStatus)} → ${statusLabel(transition.afterStatus)} (${statusLabel(transition.transition)})`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {!loaderData.operationDetail?.items.some(
            (item) => item.status === "failed",
          ) ? (
            <Form
              method="post"
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    previewedTaskTransitions.length
                      ? `Commit every create, update and membership link shown in this import preview, including ${previewedTaskTransitions.length} listed task lifecycle change${previewedTaskTransitions.length === 1 ? "" : "s"}?`
                      : "Commit every create, update and membership link shown in this import preview?",
                  )
                )
                  event.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="confirm-import" />
              <input
                type="hidden"
                name="operationId"
                value={loaderData.selectedOperation.id}
              />
              <button
                className="btn primary"
                type="submit"
                disabled={navigation.state !== "idle"}
              >
                Confirm import
              </button>
            </Form>
          ) : null}
        </div>
      ) : null}
    </section>
  ) : null;
}

function ActivityTimelinePanel({
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

function OperationsListPanel({
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

function OperationDetailPanel({
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

export function OperationCentreWorkspace({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
  const actionData = useActionData<typeof action>();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Operation Centre</h1>
          <p>Inspect background work, provider failures and safe retries.</p>
        </div>
        <div className="page-actions">
          <OperationAutoRefresh
            eventId={loaderData.eventId}
            cursor={loaderData.cursor}
          />
          <Link className="btn" to="/admin/sessions/bulk">
            Bulk sessions
          </Link>
          <Link className="btn" to="/admin/operations?panel=activity">
            Activity timeline
          </Link>
          <span className="status info">
            {loaderData.operations.length} recent operations
          </span>
        </div>
      </div>
      {actionData ? (
        <div
          className={`validation-item ${actionData.ok ? "ok" : "error"} card pad mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>
            {actionData.ok ? "Operation updated" : "Operation not updated"}
          </strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      {loaderData.filterActive ? (
        <div className="validation-item warn card pad mb" role="status">
          <strong>Filtered</strong>
          <span>
            Showing {loaderData.operations.length} of{" "}
            {loaderData.totalOperations} operations.{" "}
            <Link to="/admin/operations">Clear filters</Link>
          </span>
        </div>
      ) : null}
      <AirtableRecoveryPanel loaderData={loaderData} />
      <OperationFiltersPanel loaderData={loaderData} />
      <DataExportPanel loaderData={loaderData} />
      <DataImportPanel loaderData={loaderData} />
      <ActivityTimelinePanel loaderData={loaderData} />
      <OperationsListPanel loaderData={loaderData} />
      <OperationDetailPanel loaderData={loaderData} />
    </>
  );
}
