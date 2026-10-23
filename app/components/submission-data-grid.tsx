import {
  columnVisibilityFeature,
  createColumnHelper,
  rowSelectionFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Check, ClipboardCopy, Columns3, X } from "lucide-react";
import {
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { toast } from "sonner";
import { submissionReferenceClipboard } from "~/components/operational-ui-rules";
import { Button, ButtonSummary } from "~/components/ui/button";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import {
  ADMIN_SUBMISSION_OPTIONAL_COLUMNS,
  type AdminSubmissionDensity,
  type AdminSubmissionOptionalColumn,
  adminSubmissionViewControls,
  withAdminSubmissionColumn,
} from "~/modules/submissions/submission-admin-view";
import type {
  AdminSubmission,
  AdminSubmissionSort,
} from "~/modules/submissions/submission-repository-shared";

const gridFeatures = tableFeatures({
  columnVisibilityFeature,
  rowSelectionFeature,
});

const columnHelper = createColumnHelper<typeof gridFeatures, AdminSubmission>();

const columnLabels: Record<string, string> = {
  select: "Select",
  application: "Application",
  submitter: "Submitter",
  route: "Category route",
  speakers: "Speakers",
  status: "Status",
  action: "Action",
};

const routingStateLabels = {
  draft: "Not routed yet",
  automatic: "Automatically routed",
  missing_automatic: "No automatic team route",
  manual_override: "Manual routing override",
  manual_unassigned: "No manual team override",
} as const;

// Automatic routing to a team is the expected case, so it shows only the
// team. Without a team, the routing state alone explains why.
function routeSummary(submission: AdminSubmission) {
  const state = routingStateLabels[submission.routingState];
  if (!submission.routedTeamIds.length) return state;
  return submission.routingState === "automatic"
    ? submission.routedTo
    : `${submission.routedTo} · ${state}`;
}

function columnLabel(columnId: string) {
  const label = columnLabels[columnId];
  if (!label) throw new Error(`Missing data-grid label for ${columnId}.`);
  return label;
}

function IndeterminateCheckbox({
  indeterminate,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { indeterminate?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = Boolean(indeterminate && !props.checked);
    }
  }, [indeterminate, props.checked]);

  return <input ref={inputRef} type="checkbox" {...props} />;
}

function submissionDetailHref(id: string, detailSearchParams: string) {
  return `/admin/submissions/${encodeURIComponent(id)}${detailSearchParams ? `?${detailSearchParams}` : ""}`;
}

function submissionColumns(detailSearchParams: string) {
  return columnHelper.columns([
    columnHelper.display({
      id: "select",
      enableHiding: false,
      header: ({ table }) => (
        <IndeterminateCheckbox
          aria-label="Select every application on this page"
          checked={table.getIsAllPageRowsSelected()}
          disabled={!table.getRowModel().rows.some((row) => row.getCanSelect())}
          indeterminate={table.getIsSomePageRowsSelected()}
          onChange={(event) =>
            table.getToggleAllPageRowsSelectedHandler()(event)
          }
        />
      ),
      cell: ({ row }) => (
        <IndeterminateCheckbox
          aria-label={`Select ${row.original.title}`}
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onChange={(event) => row.getToggleSelectedHandler()(event)}
        />
      ),
    }),
    columnHelper.accessor((submission) => submission.title, {
      id: "application",
      header: "Application",
      enableHiding: false,
      cell: ({ row }) => (
        <div className="pc-record-stack">
          <Link
            className="pc-record-title"
            to={submissionDetailHref(row.original.id, detailSearchParams)}
          >
            {row.original.title}
          </Link>
          <small className="pc-record-meta">
            {`${row.original.publicReference} · ${
              row.original.versionNumber
                ? `Form v${row.original.versionNumber}`
                : "Manual entry"
            }`}
          </small>
        </div>
      ),
    }),
    columnHelper.accessor((submission) => submission.submitterName, {
      id: "submitter",
      header: "Submitter",
      cell: ({ row }) => (
        <div className="pc-record-stack">
          <span className="pc-record-person">{row.original.submitterName}</span>
          <small className="pc-record-email">
            {row.original.submitterEmail}
          </small>
        </div>
      ),
    }),
    columnHelper.accessor((submission) => submission.category, {
      id: "route",
      header: "Category route",
      cell: ({ row }) => (
        <div className="pc-record-stack">
          <span className="pc-record-route">
            {row.original.category || "Uncategorised"}
          </span>
          <small className="pc-record-meta">{routeSummary(row.original)}</small>
        </div>
      ),
    }),
    columnHelper.accessor((submission) => submission.speakerCount, {
      id: "speakers",
      header: "Speakers",
    }),
    columnHelper.accessor((submission) => submission.status, {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <DomainStatusBadge domain="submission" status={row.original.status} />
      ),
    }),
  ]);
}

type ClipboardFeedback = { ok: boolean; message: string };

type PendingView = ReturnType<typeof adminSubmissionViewControls> & {
  locationKey: string;
  search: URLSearchParams;
};

export const SUBMISSION_FILTER_FORM_ID = "submission-filters";

export function SubmissionDataGrid({
  submissions,
  filters,
  columns: visibleOptionalColumns,
  density,
  sort: _sort,
  detailSearchParams = "",
}: {
  submissions: AdminSubmission[];
  filters: ReactNode;
  columns: AdminSubmissionOptionalColumn[];
  density: AdminSubmissionDensity;
  sort: AdminSubmissionSort;
  detailSearchParams?: string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  // A view change shows at once, but the URL changes only when its loader
  // finishes. Until then, further changes and the filter form build on the
  // pending request, or they would drop it. Any committed navigation — this
  // request, or one that replaced it such as Clear — moves to another location
  // key, which discards the pending view in favour of what actually loaded.
  // It is discarded rather than ignored because Back returns to the old key.
  const [pendingView, setPendingView] = useState<PendingView | null>(null);
  if (pendingView && pendingView.locationKey !== location.key) {
    setPendingView(null);
  }
  const pending =
    pendingView?.locationKey === location.key ? pendingView : null;
  const viewSearch = pending?.search ?? searchParams;
  const shownColumns = pending?.columns ?? visibleOptionalColumns;
  const shownDensity = pending?.density ?? density;
  const [clipboardFeedback, setClipboardFeedback] =
    useState<ClipboardFeedback | null>(null);
  const columnVisibility = useMemo(
    () =>
      Object.fromEntries(
        ADMIN_SUBMISSION_OPTIONAL_COLUMNS.map((column) => [
          column,
          shownColumns.includes(column),
        ]),
      ),
    [shownColumns],
  );
  const columns = useMemo(
    () => submissionColumns(detailSearchParams),
    [detailSearchParams],
  );
  const table = useTable({
    features: gridFeatures,
    columns,
    data: submissions,
    getRowId: (submission) => submission.id,
    state: { columnVisibility },
  });

  function requestView(next: URLSearchParams) {
    setPendingView({
      locationKey: location.key,
      search: next,
      ...adminSubmissionViewControls(next),
    });
    setSearchParams(next);
  }

  function setViewParameter(name: string, value: string, defaultValue: string) {
    const next = new URLSearchParams(viewSearch);
    if (value === defaultValue) next.delete(name);
    else next.set(name, value);
    requestView(next);
  }

  function setColumnVisible(
    column: AdminSubmissionOptionalColumn,
    visible: boolean,
  ) {
    requestView(withAdminSubmissionColumn(viewSearch, column, visible));
  }

  const selectedRows = table
    .getSelectedRowModel()
    .rows.map((row) => row.original);

  async function copySelectedReferences() {
    try {
      if (!navigator.clipboard) {
        throw new Error(
          "Clipboard access is unavailable. Use a secure browser context and try again.",
        );
      }
      const text = submissionReferenceClipboard(selectedRows);
      await navigator.clipboard.writeText(text);
      const message = `${selectedRows.length} application reference${selectedRows.length === 1 ? "" : "s"} copied.`;
      setClipboardFeedback({ ok: true, message });
      toast.success("References copied", { description: message });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The selected references could not be copied.";
      setClipboardFeedback({ ok: false, message });
      toast.error("Copy failed", { description: message });
    }
  }

  return (
    <>
      <div className="pc-data-grid-toolbar">
        <label className="pc-data-grid-density">
          <span>Density</span>
          <select
            className="select"
            name="density"
            value={shownDensity}
            onChange={(event) =>
              setViewParameter("density", event.target.value, "comfortable")
            }
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <details className="pc-data-grid-columns">
          <ButtonSummary size="small">
            <Columns3 aria-hidden size={14} /> Columns
          </ButtonSummary>
          <fieldset>
            <legend>Visible columns</legend>
            {table
              .getAllLeafColumns()
              .filter((column) => column.getCanHide())
              .map((column) => (
                <label key={column.id}>
                  <input
                    type="checkbox"
                    checked={column.getIsVisible()}
                    onChange={(event) => {
                      setColumnVisible(
                        column.id as AdminSubmissionOptionalColumn,
                        event.target.checked,
                      );
                    }}
                  />
                  <span>{columnLabel(column.id)}</span>
                </label>
              ))}
          </fieldset>
        </details>
        <div className="pc-data-grid-selection" aria-live="polite">
          {selectedRows.length ? (
            <>
              <strong>
                {selectedRows.length} of {submissions.length} selected
              </strong>
              <Button
                size="small"
                type="button"
                onClick={copySelectedReferences}
              >
                <ClipboardCopy aria-hidden size={14} /> Copy references
              </Button>
              <Button
                size="small"
                type="button"
                onClick={() => {
                  table.resetRowSelection(true);
                  setClipboardFeedback(null);
                }}
              >
                <X aria-hidden size={14} /> Clear selection
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* The filter form submits the view as last requested, not as last
          loaded, so Apply during a pending view change keeps that change. */}
      <input
        type="hidden"
        form={SUBMISSION_FILTER_FORM_ID}
        name="columns"
        value={shownColumns.join(",")}
      />
      <input
        type="hidden"
        form={SUBMISSION_FILTER_FORM_ID}
        name="density"
        value={shownDensity}
      />
      {filters}

      {clipboardFeedback ? (
        <div
          className={`validation-item ${clipboardFeedback.ok ? "ok" : "error"} mb`}
          role={clipboardFeedback.ok ? "status" : "alert"}
        >
          {clipboardFeedback.ok ? (
            <Check aria-hidden size={15} />
          ) : (
            <X aria-hidden size={15} />
          )}
          <span>{clipboardFeedback.message}</span>
        </div>
      ) : null}

      <section
        className="table-wrap pc-responsive-table-wrap pc-data-grid-wrap"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
        tabIndex={0}
        aria-label="Application queue table; scroll to view more records or columns"
      >
        <table
          className={`data-table pc-responsive-table pc-data-grid is-${shownDensity}`}
        >
          <caption className="sr-only">
            Server-filtered applications on the current result page
          </caption>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} colSpan={header.colSpan} scope="col">
                    {header.isPlaceholder ? null : (
                      <table.FlexRender header={header} />
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <tr
                  className={row.getIsSelected() ? "is-selected" : undefined}
                  key={row.id}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      className={
                        cell.column.id === "application"
                          ? "pc-record-primary-cell"
                          : cell.column.id === "select"
                            ? "pc-record-select-cell"
                            : undefined
                      }
                      data-label={columnLabel(cell.column.id)}
                      key={cell.id}
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr className="pc-table-empty-row">
                <td
                  className="pc-table-empty-cell"
                  colSpan={table.getVisibleLeafColumns().length}
                >
                  <div className="pc-empty-state">
                    <h2>No matching applications</h2>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
