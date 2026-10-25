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

/* Views of one page share its URL. Each view replaces the tool above the
   operation list instead of a header button stacking a panel over it. */
const OPERATION_VIEWS = [
  { panel: "", label: "Operations" },
  { panel: "activity", label: "Activity timeline" },
  { panel: "exports", label: "Data exports" },
  { panel: "imports", label: "Data imports" },
] as const;

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
        console.warn("Operation centre realtime transport error.", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      onStatusChange: setTransport,
    });
  }, [cursor, eventId, revalidator]);

  return (
    <span
      className={`help ops-live ${transport === "unavailable" ? "danger" : transport === "polling" ? "warning" : ""}`}
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
          <h1>Operation centre</h1>
        </div>
        <div className="page-actions">
          <OperationAutoRefresh
            eventId={loaderData.eventId}
            cursor={loaderData.cursor}
          />
        </div>
      </div>
      <nav className="pc-workspace-tabs ops-views" aria-label="Operation views">
        <ul>
          {OPERATION_VIEWS.filter(
            (view) => view.panel !== "exports" || loaderData.canExportData,
          ).map((view) => (
            <li key={view.panel}>
              <Link
                to={
                  view.panel
                    ? `/admin/operations?panel=${view.panel}`
                    : "/admin/operations"
                }
                aria-current={
                  loaderData.panel === view.panel ? "page" : undefined
                }
              >
                {view.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
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
      {loaderData.panel === "" ? (
        <>
          <AirtableRecoveryPanel loaderData={loaderData} />
          <OperationFiltersPanel loaderData={loaderData} />
        </>
      ) : null}
      <DataExportPanel loaderData={loaderData} />
      <DataImportPanel loaderData={loaderData} />
      <ActivityTimelinePanel loaderData={loaderData} />
      {/* Exports and imports create operations, so their list stays in view
          with its retry and cancel controls; the timeline replaces it. */}
      {loaderData.panel === "activity" ? null : (
        <OperationsListPanel loaderData={loaderData} />
      )}
      <OperationDetailPanel loaderData={loaderData} />
    </>
  );
}
