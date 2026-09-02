import { Form, useNavigation, useSubmit } from "react-router";
import { Button, ButtonLink } from "~/components/ui/button";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { fieldLabel } from "~/lib/record-labels";
import { shortReference } from "~/lib/short-reference";
import {
  type OperationCentreData,
  operationTaskStatusLabel as statusLabel,
  taskImportTransitionSummary,
} from "./operation-centre-shared";

export function AirtableRecoveryPanel({
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
          {loaderData.airtableRecoveries.length} change
          {loaderData.airtableRecoveries.length === 1 ? "" : "s"} not in
          Airtable
        </span>
      </div>
      <p>
        These changes were saved in Program Cue but did not finish reaching
        Airtable. Review each one before retrying; nothing repairs them
        automatically.
      </p>
      <div className="stack">
        {loaderData.airtableRecoveries.map((run) => (
          <div className="validation-item warn" key={run.runId}>
            <div>
              <strong>{fieldLabel(run.operation)}</strong>
              <span>
                Run {shortReference(run.runId)} · {fieldLabel(run.status)} ·{" "}
                {fieldLabel(run.phase)} · {run.itemCount} managed change
                {run.itemCount === 1 ? "" : "s"}
              </span>
              {run.error ? <span>{run.error}</span> : null}
            </div>
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="recover-airtable-projection"
              />
              <input type="hidden" name="operationId" value={run.runId} />
              <Button
                variant="danger"
                type="submit"
                disabled={navigation.state !== "idle"}
              >
                Retry this Airtable update
              </Button>
            </Form>
          </div>
        ))}
      </div>
    </section>
  ) : null;
}

export function OperationFiltersPanel({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
  return (
    <section
      className="ops-filters mb"
      aria-labelledby="operation-filters-heading"
    >
      <h2 id="operation-filters-heading" className="sr-only">
        Filter operations
      </h2>
      <Form method="get" className="ops-filters-form">
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
                {fieldLabel(type.replaceAll(".", " "))}
              </option>
            ))}
          </select>
        </label>
        <div className="page-actions">
          <Button type="submit">Apply filters</Button>
          {loaderData.filterActive ? (
            <ButtonLink to="/admin/operations">Clear</ButtonLink>
          ) : null}
        </div>
      </Form>
    </section>
  );
}

export function DataExportPanel({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
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
            <Button type="submit">
              {resource
                .replaceAll("-", " ")
                .replace(/^./, (letter) => letter.toUpperCase())}{" "}
              CSV
            </Button>
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

export function DataImportPanel({
  loaderData,
}: {
  loaderData: OperationCentreData;
}) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
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
          <Button
            variant="primary"
            type="submit"
            disabled={navigation.state !== "idle"}
          >
            Preview import
          </Button>
        </div>
      </Form>
      <p className="help mt">
        Submission imports create or update drafts only. New task imports always
        start not started. Existing task imports may apply only the validated
        lifecycle transition shown with its exact before and after status in the
        preview; submitted status still requires the participant evidence
        workflow.
      </p>
      <details className="pc-disclosure mt">
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
                    {`${statusLabel(transition.beforeStatus)} → ${statusLabel(transition.afterStatus)} (${fieldLabel(transition.transition).toLowerCase()})`}
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
                event.preventDefault();
                const form = event.currentTarget;
                confirm(
                  {
                    title: "Commit this import preview?",
                    description: previewedTaskTransitions.length
                      ? `Every create, update and membership link shown in the preview is applied, including ${previewedTaskTransitions.length} listed task lifecycle change${previewedTaskTransitions.length === 1 ? "" : "s"}.`
                      : "Every create, update and membership link shown in the preview is applied.",
                    records: previewedTaskTransitions.length
                      ? previewedTaskTransitions.map(
                          (transition) =>
                            `${transition.title}: ${statusLabel(transition.beforeStatus)} → ${statusLabel(transition.afterStatus)}`,
                        )
                      : loaderData.operationDetail?.items.map(
                          (item) => item.entityId ?? item.itemKey,
                        ),
                    confirmLabel: "Commit import",
                    tone: "primary",
                  },
                  () => submit(form),
                );
              }}
            >
              <input type="hidden" name="intent" value="confirm-import" />
              <input
                type="hidden"
                name="operationId"
                value={loaderData.selectedOperation.id}
              />
              <Button
                variant="primary"
                type="submit"
                disabled={navigation.state !== "idle"}
              >
                Confirm import
              </Button>
            </Form>
          ) : null}
        </div>
      ) : null}
      {dialog}
    </section>
  ) : null;
}
