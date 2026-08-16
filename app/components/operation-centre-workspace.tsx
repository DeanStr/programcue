import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useActionData, useRevalidator } from "react-router";

import {
  type RealtimeTransportStatus,
  subscribeToEventChanges,
} from "~/platform/realtime/realtime-client";
import type { action } from "~/routes/operation-centre.server";
import {
  AirtableRecoveryPanel,
  DataExportPanel,
  DataImportPanel,
  OperationFiltersPanel,
} from "./operation-centre-data-panels";
import {
  ActivityTimelinePanel,
  OperationDetailPanel,
  OperationsListPanel,
} from "./operation-centre-results-panels";
import type { OperationCentreData } from "./operation-centre-shared";

export { taskImportTransitionSummary } from "./operation-centre-shared";

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
            {loaderData.failurePagination
              ? `${loaderData.failurePagination.from}–${loaderData.failurePagination.to} of ${loaderData.failurePagination.total} failed operations`
              : `${loaderData.operations.length} recent operations`}
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
            Showing {loaderData.operations.length} matching operations.{" "}
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
