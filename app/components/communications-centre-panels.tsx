import { Form, Link } from "react-router";
import type {
  ActionResult,
  CommunicationsCentreLoaderData,
} from "~/routes/communications-centre";

type PendingIntent = FormDataEntryValue | null | undefined;
type SelectedTemplate = CommunicationsCentreLoaderData["selected"];

function formatDate(epoch: number | null) {
  return epoch
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(epoch * 1_000))
    : "—";
}

function categoryLabel(category: string) {
  return category
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

export function TemplateVersionList({
  loaderData,
  selected,
}: {
  loaderData: CommunicationsCentreLoaderData;
  selected: SelectedTemplate;
}) {
  return (
    <aside className="card pad template-column">
      <div className="card-title">
        <h2>Template versions</h2>
        <span className="status info right">{loaderData.templates.length}</span>
      </div>
      <div className="template-list">
        {loaderData.templates.length ? (
          loaderData.templates.map((template) => (
            <Link
              key={template.id}
              to={`?template=${template.id}`}
              className={`template-item${selected?.id === template.id ? " active" : ""}`}
            >
              <strong>{template.name}</strong>
              <small>
                {categoryLabel(template.category)} · v{template.versionNumber}
              </small>
              <span
                className={`status ${template.versionStatus === "published" ? "success" : template.versionStatus === "draft" ? "warning" : "info"}`}
              >
                {template.versionStatus}
              </span>
            </Link>
          ))
        ) : (
          <div className="empty compact">
            <p>Create the first versioned email template.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

export function TemplateEditor({
  selected,
  working,
  pendingIntent,
  templateDirty,
  onDirty,
}: {
  selected: SelectedTemplate;
  working: boolean;
  pendingIntent: PendingIntent;
  templateDirty: boolean;
  onDirty: () => void;
}) {
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>{selected ? `Edit ${selected.name}` : "New email template"}</h2>
        {selected ? (
          <span
            className={`status ${selected.versionStatus === "published" ? "success" : "warning"} right`}
          >
            v{selected.versionNumber} · {selected.versionStatus}
          </span>
        ) : null}
      </div>
      <Form
        key={selected?.id ?? "new-template"}
        method="post"
        className="stack"
        onChange={() => onDirty()}
      >
        {selected ? (
          <input type="hidden" name="templateId" value={selected.templateId} />
        ) : null}
        <div className="form-row">
          <label className="label">
            Template name
            <input
              className="field"
              name="name"
              defaultValue={selected?.name ?? ""}
              required
            />
          </label>
          <label className="label">
            Type
            <select
              className="select"
              name="category"
              defaultValue={selected?.category ?? "ad_hoc"}
            >
              <option value="submission_confirmation">
                Submission confirmation
              </option>
              <option value="decision">Decision</option>
              <option value="task_reminder">Task reminder</option>
              <option value="schedule">Schedule update</option>
              <option value="calendar">Calendar</option>
              <option value="ad_hoc">Ad hoc</option>
            </select>
          </label>
        </div>
        <label className="label">
          Subject
          <input
            className="field"
            name="subject"
            defaultValue={
              selected?.subject ??
              "Hi {{recipient.firstName}} — an update from {{event.name}}"
            }
            required
          />
        </label>
        <label className="label">
          Message
          <textarea
            className="textarea comms-body"
            name="body"
            defaultValue={
              selected?.content.body ??
              "Hi {{recipient.firstName}},\n\nHere is an update from {{event.name}}."
            }
            required
          />
        </label>
        <label className="label">
          Physical address
          <input
            className="field"
            name="physicalAddress"
            defaultValue={
              selected?.content.physicalAddress ??
              "Program Cue event operations"
            }
            required
          />
          <span className="help">Required in the rendered footer.</span>
        </label>
        <div className="form-row">
          <label className="label">
            Optional button text
            <input
              className="field"
              name="buttonText"
              defaultValue={selected?.content.buttonText ?? ""}
            />
          </label>
          <label className="label">
            Optional button URL
            <input
              className="field"
              name="buttonUrl"
              type="url"
              defaultValue={selected?.content.buttonUrl ?? ""}
            />
          </label>
        </div>
        <div className="row-actions">
          <button
            className="btn"
            name="intent"
            value="save-template"
            disabled={working}
          >
            {working && pendingIntent === "save-template"
              ? "Saving…"
              : "Save as new draft version"}
          </button>
          {selected?.versionStatus === "draft" ? (
            <button
              className="btn primary"
              name="intent"
              value="publish-template"
              formNoValidate
              disabled={working || templateDirty}
            >
              {templateDirty
                ? "Save changes before publishing"
                : working && pendingIntent === "publish-template"
                  ? "Publishing…"
                  : "Publish this saved version"}
            </button>
          ) : null}
          {selected?.versionStatus === "draft" ? (
            <input type="hidden" name="templateVersionId" value={selected.id} />
          ) : null}
        </div>
      </Form>
    </section>
  );
}

export function AudienceComposer({
  actionData,
  selected,
  publishedTemplates,
  working,
  pendingIntent,
}: {
  actionData: ActionResult | undefined;
  selected: SelectedTemplate;
  publishedTemplates: CommunicationsCentreLoaderData["templates"];
  working: boolean;
  pendingIntent: PendingIntent;
}) {
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>1. Configure audience</h2>
        <span className="help right">
          Preview re-runs the tenant-scoped query.
        </span>
      </div>
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="preview" />
        <label className="label">
          Published template
          <select
            className="select"
            name="templateVersionId"
            defaultValue={
              actionData?.fields?.templateVersionId ??
              (selected?.versionStatus === "published" ? selected.id : "")
            }
            required
          >
            <option value="" disabled>
              Select a published version
            </option>
            {publishedTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} · v{template.versionNumber}
              </option>
            ))}
          </select>
        </label>
        <div className="form-row">
          <label className="label">
            Audience
            <select
              className="select"
              name="audienceType"
              defaultValue={
                actionData?.fields?.audienceType ?? "incomplete_speakers"
              }
            >
              <option value="submitted_applicants">Submitted applicants</option>
              <option value="decision_recipients">
                Applicants with decisions
              </option>
              <option value="accepted_speakers">Accepted speakers</option>
              <option value="incomplete_speakers">
                Speakers with incomplete tasks
              </option>
              <option value="manual">Manual addresses</option>
            </select>
          </label>
          <label className="label">
            Message policy
            <select
              className="select"
              name="kind"
              defaultValue={actionData?.fields?.kind ?? "transactional"}
            >
              <option value="transactional">
                Transactional · required operational message
              </option>
              <option value="optional">
                Optional · honour category unsubscribes
              </option>
            </select>
          </label>
        </div>
        <label className="label">
          Manual addresses
          <textarea
            className="textarea"
            name="manualRecipients"
            defaultValue={actionData?.fields?.manualRecipients ?? ""}
            placeholder="Alex Morgan <alex@example.com>, priya@example.com"
          />
          <span className="help">
            Only used when Manual addresses is selected.
          </span>
        </label>
        <button
          className="btn primary"
          disabled={working || !publishedTemplates.length}
        >
          {working && pendingIntent === "preview"
            ? "Querying…"
            : "Preview recipients and content"}
        </button>
      </Form>
    </section>
  );
}

export function CommunicationPreviewConfirmation({
  actionData,
  working,
  pendingIntent,
}: {
  actionData: ActionResult | undefined;
  working: boolean;
  pendingIntent: PendingIntent;
}) {
  return (
    <>
      {actionData?.preview && actionData.fields ? (
        <section className="card pad comms-confirm-panel">
          <div className="card-title">
            <h2>2. Verify preview</h2>
            <span className="status info right">Nothing queued</span>
          </div>
          <div className="grid grid-4 mb">
            <div className="metric">
              <span className="label">Selected</span>
              <strong className="value">
                {actionData.preview.recipients.selected}
              </strong>
            </div>
            <div className="metric">
              <span className="label">Deliverable</span>
              <strong className="value">
                {actionData.preview.recipients.deliverable.length}
              </strong>
            </div>
            <div className="metric">
              <span className="label">Suppressed</span>
              <strong className="value">
                {actionData.preview.recipients.suppressed.length}
              </strong>
            </div>
            <div className="metric">
              <span className="label">Invalid</span>
              <strong className="value">
                {actionData.preview.recipients.invalid.length}
              </strong>
            </div>
          </div>
          {actionData.preview.recipients.invalid.length ||
          actionData.preview.recipients.suppressed.length ? (
            <div className="validation-item warn mb">
              △ Excluded recipients will not receive this batch. Inspect the
              counts before confirming.
            </div>
          ) : (
            <div className="validation-item ok mb">
              ✓ All selected recipients are deliverable.
            </div>
          )}
          <div className="comms-preview-grid">
            <div>
              <h3>Representative email</h3>
              <iframe
                className="email-preview-frame"
                title="Representative email preview"
                srcDoc={actionData.preview.rendered.html}
              />
            </div>
            <div>
              <h3>Recipient sample</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionData.preview.recipients.deliverable
                      .slice(0, 20)
                      .map((recipient) => (
                        <tr key={recipient.address}>
                          <td>{recipient.name}</td>
                          <td>{recipient.address}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {actionData.preview.recipients.deliverable.length > 20 ? (
                <p className="help">
                  Showing 20 of{" "}
                  {actionData.preview.recipients.deliverable.length} deliverable
                  recipients.
                </p>
              ) : null}
            </div>
          </div>
          <div className="divider" />
          <div className="card-title">
            <h2>3. Confirm durable send</h2>
          </div>
          {!actionData.preview.provider.configured ||
          !actionData.preview.provider.queueConfigured ? (
            <div className="validation-item error mb">
              △ Confirm is blocked until a verified sender, RESEND_API_KEY and
              OPERATIONS_QUEUE are configured.
            </div>
          ) : null}
          <Form method="post" className="row-actions">
            <input type="hidden" name="intent" value="confirm" />
            <input
              type="hidden"
              name="templateVersionId"
              value={actionData.fields.templateVersionId}
            />
            <input
              type="hidden"
              name="audienceType"
              value={actionData.fields.audienceType}
            />
            <input
              type="hidden"
              name="manualRecipients"
              value={actionData.fields.manualRecipients}
            />
            <input type="hidden" name="kind" value={actionData.fields.kind} />
            <input
              type="hidden"
              name="idempotencyKey"
              value={actionData.idempotencyKey}
            />
            <input
              type="hidden"
              name="recipientFingerprint"
              value={actionData.preview.confirmation.recipientFingerprint}
            />
            <input
              type="hidden"
              name="deliverableFingerprint"
              value={actionData.preview.confirmation.deliverableFingerprint}
            />
            <input
              type="hidden"
              name="suppressedCount"
              value={actionData.preview.confirmation.suppressedCount}
            />
            <span className="help">
              The audience is recomputed at confirmation; saved delivery rows
              become authoritative.
            </span>
            <button
              className="btn primary"
              disabled={
                working ||
                !actionData.preview.provider.configured ||
                !actionData.preview.provider.queueConfigured ||
                !actionData.preview.recipients.deliverable.length
              }
            >
              {working && pendingIntent === "confirm"
                ? "Recording…"
                : `Confirm ${actionData.preview.recipients.deliverable.length} deliveries`}
            </button>
          </Form>
        </section>
      ) : null}
    </>
  );
}

export function RecentCommunications({
  loaderData,
  working,
  pendingIntent,
}: {
  loaderData: CommunicationsCentreLoaderData;
  working: boolean;
  pendingIntent: PendingIntent;
}) {
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Recent communications</h2>
        <span className="status info right">
          {loaderData.communications.length}
        </span>
      </div>
      {loaderData.communications.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Created (UTC)</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.communications.map((item) => (
                <tr key={item.id}>
                  <td>
                    {formatDate(item.createdAt)}
                    <small>{item.id}</small>
                  </td>
                  <td>
                    <span
                      className={`status ${item.status === "sent" ? "success" : ["failed", "partially_failed"].includes(item.status) ? "danger" : "info"}`}
                    >
                      {item.status.replaceAll("_", " ")}
                    </span>
                  </td>
                  <td>
                    {item.sentCount}/{item.recipientCount} sent
                    {item.failedCount ? ` · ${item.failedCount} failed` : ""}
                  </td>
                  <td>
                    {["draft", "scheduled", "queued", "failed"].includes(
                      item.status,
                    ) ? (
                      <Form
                        method="post"
                        onSubmit={(event) => {
                          if (
                            !window.confirm(
                              `Cancel communication ${item.id}? Unsent deliveries will not be sent.`,
                            )
                          )
                            event.preventDefault();
                        }}
                      >
                        <input type="hidden" name="intent" value="cancel" />
                        <input
                          type="hidden"
                          name="communicationId"
                          value={item.id}
                        />
                        <button className="btn small" disabled={working}>
                          {working && pendingIntent === "cancel"
                            ? "Cancelling…"
                            : "Cancel"}
                        </button>
                      </Form>
                    ) : item.operationId ? (
                      <Link className="btn small" to="/admin/operations">
                        Details
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty compact">
          <p>No sends have been confirmed.</p>
        </div>
      )}
    </section>
  );
}

export function CalendarLifecycleTable({
  loaderData,
}: {
  loaderData: CommunicationsCentreLoaderData;
}) {
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Calendar lifecycle</h2>
        <span className="status info right">
          {loaderData.invitations.length}
        </span>
      </div>
      {loaderData.invitations.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Speaker</th>
                <th>Provider</th>
                <th>Lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.invitations.map((invitation) => (
                <tr key={invitation.id}>
                  <td>
                    {invitation.sessionTitle}
                    <small>{invitation.icalUid}</small>
                  </td>
                  <td>
                    {invitation.personName}
                    <small>{invitation.email}</small>
                  </td>
                  <td>{invitation.provider ?? "Pending"}</td>
                  <td>
                    <span
                      className={`status ${invitation.status === "sent" || invitation.status === "confirmed" ? "success" : invitation.status === "failed" ? "danger" : "info"}`}
                    >
                      {invitation.method} · seq {invitation.sequenceNumber} ·{" "}
                      {invitation.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty compact">
          <p>
            Published schedule updates will create stable-UID calendar
            operations here.
          </p>
        </div>
      )}
    </section>
  );
}
