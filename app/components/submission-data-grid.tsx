import {
  columnVisibilityFeature,
  createColumnHelper,
  rowSelectionFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Check, ClipboardCopy, Columns3, Rows3, X } from "lucide-react";
import {
  type InputHTMLAttributes,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { submissionReferenceClipboard } from "~/components/operational-ui-rules";
import type { AdminSubmission } from "~/modules/submissions/submission-repository-shared";

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
            to={submissionDetailHref(row.original.id, detailSearchParams)}
          >
            <strong>{row.original.title}</strong>
          </Link>
          <small className="subtle">
            Reference {row.original.publicReference}
          </small>
          <small className="subtle">
            {row.original.versionNumber
              ? `Form v${row.original.versionNumber}`
              : "Manual entry"}
          </small>
        </div>
      ),
    }),
    columnHelper.accessor((submission) => submission.submitterName, {
      id: "submitter",
      header: "Submitter",
      cell: ({ row }) => (
        <div className="pc-record-stack">
          <strong>{row.original.submitterName}</strong>
          <small className="subtle pc-record-email">
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
          <span>{row.original.category || "Uncategorised"}</span>
          <small className="subtle">{row.original.routedTo}</small>
          <small className="subtle">
            {routingStateLabels[row.original.routingState]}
          </small>
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
    columnHelper.display({
      id: "action",
      header: "Action",
      enableHiding: false,
      cell: ({ row }) => (
        <Link
          className="btn small"
          to={submissionDetailHref(row.original.id, detailSearchParams)}
        >
          Open
        </Link>
      ),
    }),
  ]);
}

type ClipboardFeedback = { ok: boolean; message: string };

export function SubmissionDataGrid({
  submissions,
  detailSearchParams = "",
}: {
  submissions: AdminSubmission[];
  detailSearchParams?: string;
}) {
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  );
  const [clipboardFeedback, setClipboardFeedback] =
    useState<ClipboardFeedback | null>(null);
  const columns = useMemo(
    () => submissionColumns(detailSearchParams),
    [detailSearchParams],
  );
  const table = useTable({
    features: gridFeatures,
    columns,
    data: submissions,
    getRowId: (submission) => submission.id,
  });

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
        <div className="pc-data-grid-selection" aria-live="polite">
          {selectedRows.length ? (
            <>
              <strong>
                {selectedRows.length} of {submissions.length} selected
              </strong>
              <button
                className="btn small"
                type="button"
                onClick={copySelectedReferences}
              >
                <ClipboardCopy aria-hidden size={14} /> Copy references
              </button>
              <button
                className="btn small"
                type="button"
                onClick={() => {
                  table.resetRowSelection(true);
                  setClipboardFeedback(null);
                }}
              >
                <X aria-hidden size={14} /> Clear selection
              </button>
            </>
          ) : (
            <span className="help">
              Select applications to copy a reference working set.
            </span>
          )}
        </div>
        <label className="label pc-data-grid-density">
          <Rows3 aria-hidden size={14} /> Density
          <select
            className="select"
            value={density}
            onChange={(event) =>
              setDensity(event.target.value as "comfortable" | "compact")
            }
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <details className="pc-data-grid-columns">
          <summary className="btn small">
            <Columns3 aria-hidden size={14} /> Columns
          </summary>
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
                    onChange={(event) =>
                      column.getToggleVisibilityHandler()(event)
                    }
                  />
                  <span>{columnLabel(column.id)}</span>
                </label>
              ))}
          </fieldset>
        </details>
      </div>

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

      <div
        className="table-wrap pc-responsive-table-wrap pc-data-grid-wrap"
        tabIndex={0}
        role="region"
        aria-label="Application queue table; scroll to view more records or columns"
      >
        <table
          className={`data-table pc-responsive-table pc-data-grid is-${density}`}
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
                          : cell.column.id === "action"
                            ? "pc-record-action-cell"
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
                    <p className="subtle">
                      Publish a form and submit an application, or clear the
                      filters.
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
