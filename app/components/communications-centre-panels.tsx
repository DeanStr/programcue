import { Form, Link } from "react-router";
import { useState } from "react";
import { DraftRecoveryStatus } from "~/components/draft-recovery-feedback";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import type { DraftRecoveryState } from "~/platform/drafts/draft-recovery";
import type {
  ActionResult,
  CommunicationsCentreLoaderData,
} from "~/routes/communications-centre";

type PendingIntent = FormDataEntryValue | null | undefined;
type SelectedTemplate = CommunicationsCentreLoaderData["selected"];

export type TemplateDraftFields = {
  name: string;
  category: string;
  subject: string;
  body: string;
  physicalAddress: string;
  buttonText: string;
  buttonUrl: string;
};

function formatDate(epoch: number | null, timezone: string) {
  return epoch
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "long",
        timeZone: timezone,
      }).format(new Date(epoch * 1_000)) + ` (${timezone})`
    : "—";
}

function categoryLabel(category: string) {
  return category
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

export function deliveryActionLabel(
  action: "Schedule" | "Confirm",
  deliveryCount: number,
) {
  return `${action} ${deliveryCount} ${deliveryCount === 1 ? "delivery" : "deliveries"}`;
}

export function CommunicationRecipientIdentity({
  name,
  email,
}: {
  name: string;
  email: string;
}) {
  return (
    <div className="comms-recipient-identity">
      <div className="comms-recipient-name">
        <strong>{name}</strong>
      </div>
      <div className="comms-recipient-email">
        <small>{email}</small>
      </div>
    </div>
  );
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
  draft,
  recoveryState,
  onChange,
}: {
  selected: SelectedTemplate;
  working: boolean;
  pendingIntent: PendingIntent;
  templateDirty: boolean;
  draft: TemplateDraftFields;
  recoveryState: DraftRecoveryState;
  onChange: (draft: TemplateDraftFields) => void;
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
              value={draft.name}
              onChange={(event) =>
                onChange({ ...draft, name: event.target.value })
              }
              required
            />
          </label>
          <label className="label">
            Type
            <select
              className="select"
              name="category"
              value={draft.category}
              onChange={(event) =>
                onChange({ ...draft, category: event.target.value })
              }
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
            value={draft.subject}
            onChange={(event) =>
              onChange({ ...draft, subject: event.target.value })
            }
            required
          />
        </label>
        <label className="label">
          Message
          <textarea
            className="textarea comms-body"
            name="body"
            value={draft.body}
            onChange={(event) =>
              onChange({ ...draft, body: event.target.value })
            }
            required
          />
        </label>
        <label className="label">
          Physical address
          <input
            className="field"
            name="physicalAddress"
            value={draft.physicalAddress}
            onChange={(event) =>
              onChange({ ...draft, physicalAddress: event.target.value })
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
              value={draft.buttonText}
              onChange={(event) =>
                onChange({ ...draft, buttonText: event.target.value })
              }
            />
          </label>
          <label className="label">
            Optional button URL
            <input
              className="field"
              name="buttonUrl"
              type="url"
              value={draft.buttonUrl}
              onChange={(event) =>
                onChange({ ...draft, buttonUrl: event.target.value })
              }
            />
          </label>
        </div>
        <div className="row-actions">
          <DraftRecoveryStatus state={recoveryState} />
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
  audiencePreset,
  eventTimezone,
  working,
  pendingIntent,
}: {
  actionData: ActionResult | undefined;
  selected: SelectedTemplate;
  publishedTemplates: CommunicationsCentreLoaderData["templates"];
  audiencePreset: CommunicationsCentreLoaderData["audiencePreset"];
  eventTimezone: string;
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
                actionData?.fields?.audienceType ??
                audiencePreset ??
                "incomplete_speakers"
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
              <option value="due_speakers">Speakers due within 24 hours</option>
              <option value="overdue_speakers">Overdue speakers</option>
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
        <label className="label">
          Schedule for later (optional, {eventTimezone})
          <input
            className="field"
            name="scheduledAt"
            type="datetime-local"
            defaultValue={actionData?.fields?.scheduledAt ?? ""}
          />
          <span className="help">
            Leave blank to queue immediately. Scheduled recipients and content
            become durable only after preview and confirmation.
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
  eventTimezone,
  working,
  pendingIntent,
}: {
  actionData: ActionResult | undefined;
  eventTimezone: string;
  working: boolean;
  pendingIntent: PendingIntent;
}) {
  if (actionData?.fields?.scheduledAt && actionData.scheduledAt === undefined) {
    throw new Error(
      "A scheduled communication preview is missing its exact event timestamp.",
    );
  }
  const [viewport, setViewport] = useState<"mobile" | "desktop">("desktop");
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
              <div className="card-title">
                <h3>Representative merged email</h3>
                <span
                  className="preview-viewport-controls right"
                  role="group"
                  aria-label="Email preview size"
                >
                  <button
                    className="btn small"
                    type="button"
                    aria-pressed={viewport === "mobile"}
                    onClick={() => setViewport("mobile")}
                  >
                    Mobile
                  </button>
                  <button
                    className="btn small"
                    type="button"
                    aria-pressed={viewport === "desktop"}
                    onClick={() => setViewport("desktop")}
                  >
                    Desktop
                  </button>
                </span>
              </div>
              <div className="email-preview-shell">
                <iframe
                  className={`email-preview-frame${viewport === "mobile" ? " is-mobile" : ""}`}
                  title={`Representative merged email · ${viewport} preview`}
                  srcDoc={actionData.preview.rendered.html}
                  sandbox=""
                  referrerPolicy="no-referrer"
                />
              </div>
            </div>
            <div>
              <h3>Recipient sample</h3>
              <div className="table-wrap pc-responsive-table-wrap">
                <table
                  className="data-table pc-responsive-table comms-recipient-sample"
                  aria-label="Deliverable recipient sample"
                >
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionData.preview.recipients.deliverable
                      .slice(0, 20)
                      .map((recipient) => (
                        <tr key={recipient.address}>
                          <td
                            className="comms-recipient-sample-name pc-record-primary-cell"
                            data-label="Name"
                          >
                            {recipient.name}
                          </td>
                          <td
                            className="comms-recipient-sample-address"
                            data-label="Address"
                          >
                            {recipient.address}
                          </td>
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
          {actionData.fields.scheduledAt ? (
            <div className="validation-item info mb">
              <span className="comms-schedule-summary">
                Scheduled for{" "}
                <EventDateTime
                  epochSeconds={actionData.scheduledAt!}
                  timeZone={eventTimezone}
                  showTimeZone
                />
                . No Queue message will be sent before that instant.
              </span>
            </div>
          ) : null}
          {!actionData.preview.provider.configured ||
          !actionData.preview.provider.queueConfigured ? (
            <div className="validation-item error mb">
              △ Confirm is blocked until a verified sender, email provider and
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
              name="scheduledAt"
              value={actionData.fields.scheduledAt}
            />
            {actionData.scheduledAt !== undefined ? (
              <input
                type="hidden"
                name="previewedScheduledAt"
                value={actionData.scheduledAt}
              />
            ) : null}
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
                : actionData.fields.scheduledAt
                  ? deliveryActionLabel(
                      "Schedule",
                      actionData.preview.recipients.deliverable.length,
                    )
                  : deliveryActionLabel(
                      "Confirm",
                      actionData.preview.recipients.deliverable.length,
                    )}
            </button>
          </Form>
        </section>
      ) : null}
    </>
  );
}

export function DeliveryConfiguration({
  loaderData,
  working,
  pendingIntent,
}: {
  loaderData: CommunicationsCentreLoaderData;
  working: boolean;
  pendingIntent: PendingIntent;
}) {
  const published = loaderData.templates.filter(
    (template) => template.versionStatus === "published",
  );
  const emailProviderLabel =
    loaderData.provider.name === "mailpit" ? "Mailpit" : "Resend";
  const localCapture = loaderData.provider.name === "mailpit";
  return (
    <section className="card pad mb">
      <div className="card-title">
        <h2>Delivery configuration</h2>
        <span className="help right">
          Provider verification is authoritative
        </span>
      </div>
      <div className="grid grid-2">
        <div className="stack">
          <h3>{emailProviderLabel} sender profiles</h3>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="save-sender" />
            <div className="form-row">
              <label className="label">
                Profile name
                <input className="field" name="name" required />
              </label>
              <label className="label">
                From name
                <input className="field" name="fromName" required />
              </label>
            </div>
            <div className="form-row">
              <label className="label">
                From email
                <input
                  className="field"
                  name="fromEmail"
                  type="email"
                  required
                />
              </label>
              <label className="label">
                Reply-to email
                <input className="field" name="replyToEmail" type="email" />
              </label>
            </div>
            <button className="btn" disabled={working}>
              {working && pendingIntent === "save-sender"
                ? "Saving…"
                : localCapture
                  ? "Save verified local sender"
                  : "Save unverified sender"}
            </button>
          </Form>
          {loaderData.senders.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Sender</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loaderData.senders.map((sender) => (
                    <tr key={sender.id}>
                      <td>
                        {sender.fromName}
                        <small>
                          {sender.name} · {sender.fromEmail}
                        </small>
                      </td>
                      <td>
                        <span
                          className={`status ${sender.status === "verified" ? "success" : sender.status === "disabled" ? "info" : "warning"}`}
                        >
                          {sender.status}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          {sender.status !== "disabled" && !localCapture ? (
                            <Form method="post">
                              <input
                                type="hidden"
                                name="intent"
                                value="provision-sender"
                              />
                              <input
                                type="hidden"
                                name="senderProfileId"
                                value={sender.id}
                              />
                              <button className="btn small" disabled={working}>
                                Check Resend
                              </button>
                            </Form>
                          ) : null}
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value={
                                sender.status === "disabled"
                                  ? "enable-sender"
                                  : "disable-sender"
                              }
                            />
                            <input
                              type="hidden"
                              name="senderProfileId"
                              value={sender.id}
                            />
                            <button className="btn small" disabled={working}>
                              {sender.status === "disabled"
                                ? "Enable"
                                : "Disable"}
                            </button>
                          </Form>
                          <details>
                            <summary className="btn small">Edit</summary>
                            <Form method="post" className="stack mt">
                              <input
                                type="hidden"
                                name="intent"
                                value="save-sender"
                              />
                              <input
                                type="hidden"
                                name="senderProfileId"
                                value={sender.id}
                              />
                              <label className="label">
                                Profile name
                                <input
                                  className="field"
                                  name="name"
                                  defaultValue={sender.name}
                                  required
                                />
                              </label>
                              <label className="label">
                                From name
                                <input
                                  className="field"
                                  name="fromName"
                                  defaultValue={sender.fromName}
                                  required
                                />
                              </label>
                              <label className="label">
                                From email
                                <input
                                  className="field"
                                  name="fromEmail"
                                  type="email"
                                  defaultValue={sender.fromEmail}
                                  required
                                />
                              </label>
                              <label className="label">
                                Reply-to email
                                <input
                                  className="field"
                                  name="replyToEmail"
                                  type="email"
                                  defaultValue={sender.replyToEmail ?? ""}
                                />
                              </label>
                              <button className="btn small" disabled={working}>
                                Save changes
                              </button>
                            </Form>
                          </details>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="help">No sender profile has been configured.</p>
          )}
        </div>
        <div className="stack">
          <h3>Real test send</h3>
          <p className="help">
            Sends through {emailProviderLabel} and the durable Queue.
            Source-bound fields use clearly representative merge data; this is
            not a delivery simulation.
          </p>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="test-send" />
            <input
              type="hidden"
              name="idempotencyKey"
              value={loaderData.testSendKey}
            />
            <label className="label">
              Published template
              <select
                className="select"
                name="templateVersionId"
                defaultValue=""
                required
              >
                <option value="" disabled>
                  Select a published version
                </option>
                {published.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} · v{template.versionNumber}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Test recipient
              <input className="field" name="recipient" type="email" required />
            </label>
            <button
              className="btn primary"
              disabled={
                working ||
                !published.length ||
                !loaderData.provider.configured ||
                !loaderData.provider.queueConfigured
              }
            >
              {working && pendingIntent === "test-send"
                ? "Queueing…"
                : "Send real test email"}
            </button>
          </Form>
        </div>
      </div>
    </section>
  );
}

export function CommunicationAutomation({
  loaderData,
  working,
  pendingIntent,
}: {
  loaderData: CommunicationsCentreLoaderData;
  working: boolean;
  pendingIntent: PendingIntent;
}) {
  const reminderTemplates = loaderData.templates.filter(
    (template) =>
      template.category === "task_reminder" &&
      template.versionStatus === "published",
  );
  return (
    <section className="card pad mt">
      <div className="card-title">
        <h2>Automatic reminders and escalation</h2>
        <span className="status info right">{loaderData.triggers.length}</span>
      </div>
      <p className="help">
        The scheduled Worker marks expired tasks overdue, evaluates each trigger
        once per UTC day and records every resulting send durably before Queue
        dispatch.
      </p>
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="save-trigger" />
        <div className="form-row">
          <label className="label">
            Reminder template
            <select
              className="select"
              name="templateId"
              defaultValue=""
              required
            >
              <option value="" disabled>
                Select a published task-reminder template
              </option>
              {reminderTemplates.map((template) => (
                <option key={template.templateId} value={template.templateId}>
                  {template.name} · v{template.versionNumber}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Trigger
            <select
              className="select"
              name="triggerType"
              defaultValue="task_due"
            >
              <option value="task_due">Due within 24 hours</option>
              <option value="task_overdue">Overdue</option>
            </select>
          </label>
        </div>
        <div className="form-row">
          <label className="label">
            Audience
            <select
              className="select"
              name="triggerAudience"
              defaultValue="due_speakers"
            >
              <option value="due_speakers">Speakers due within 24 hours</option>
              <option value="overdue_speakers">Overdue speakers</option>
              <option value="event_administrators">Event administrators</option>
            </select>
          </label>
          <label className="label">
            Send hour (UTC)
            <input
              className="field"
              name="sendHourUtc"
              type="number"
              min={0}
              max={23}
              defaultValue={14}
              required
            />
          </label>
          <label className="label">
            Policy
            <select className="select" name="kind" defaultValue="transactional">
              <option value="transactional">Transactional</option>
              <option value="optional">Optional / unsubscribe-aware</option>
            </select>
          </label>
        </div>
        <button className="btn" disabled={working || !reminderTemplates.length}>
          {working && pendingIntent === "save-trigger"
            ? "Saving…"
            : "Enable reminder trigger"}
        </button>
      </Form>
      {loaderData.triggers.length ? (
        <div className="table-wrap mt">
          <table className="data-table">
            <thead>
              <tr>
                <th>Template</th>
                <th>Rule</th>
                <th>Last run</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.triggers.map((trigger) => (
                <tr key={trigger.id}>
                  <td>{trigger.templateName}</td>
                  <td>
                    {categoryLabel(trigger.triggerType)} ·{" "}
                    {trigger.configuration.sendHourUtc}:00 UTC
                    <small>
                      {categoryLabel(trigger.configuration.audienceType)}
                    </small>
                  </td>
                  <td>{trigger.configuration.lastRunBucket ?? "Not run"}</td>
                  <td>
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value={
                          trigger.enabled ? "disable-trigger" : "enable-trigger"
                        }
                      />
                      <input
                        type="hidden"
                        name="triggerId"
                        value={trigger.id}
                      />
                      <button className="btn small" disabled={working}>
                        {trigger.enabled ? "Disable" : "Enable"}
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function lifecycleKey(
  target: CommunicationsCentreLoaderData["calendarTargets"][number],
  method: "REQUEST" | "CANCEL",
  provider: "email_ics" | "google" | "microsoft",
) {
  return `calendar:${target.invitationId ?? `${target.sessionId}:${target.personId}`}:${(target.sequenceNumber ?? -1) + 1}:${method}:${provider}`;
}

function CalendarAction({
  target,
  method,
  provider,
  connectionId,
  working,
}: {
  target: CommunicationsCentreLoaderData["calendarTargets"][number];
  method: "REQUEST" | "CANCEL";
  provider: "email_ics" | "google" | "microsoft";
  connectionId?: string | null;
  working: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="calendar-lifecycle" />
      <input type="hidden" name="sessionId" value={target.sessionId} />
      <input type="hidden" name="personId" value={target.personId} />
      <input type="hidden" name="method" value={method} />
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="connectionId" value={connectionId ?? ""} />
      <input
        type="hidden"
        name="idempotencyKey"
        value={lifecycleKey(target, method, provider)}
      />
      <button className="btn small" disabled={working}>
        {method === "CANCEL"
          ? "Cancel invitation"
          : provider === "email_ics"
            ? target.invitationId
              ? "Email ICS update"
              : "Send email ICS"
            : `${target.invitationId ? "Update" : "Send to"} ${provider === "google" ? "Google" : "Microsoft"}`}
      </button>
    </Form>
  );
}

export function CalendarAdministration({
  loaderData,
  working,
  pendingIntent,
}: {
  loaderData: CommunicationsCentreLoaderData;
  working: boolean;
  pendingIntent: PendingIntent;
}) {
  return (
    <section className="card pad mt">
      <div className="card-title">
        <h2>Calendar administration</h2>
        <span className="help right">Google, Microsoft 365 and email ICS</span>
      </div>
      <div className="row-actions mb">
        <Link className="btn" to="/oauth/calendar/google">
          Connect my Google Calendar
        </Link>
        <Link className="btn" to="/oauth/calendar/microsoft">
          Connect my Microsoft 365 calendar
        </Link>
      </div>
      {loaderData.connections.length ? (
        <div className="table-wrap mb">
          <table className="data-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.connections.map((connection) => (
                <tr key={connection.id}>
                  <td>
                    {connection.personName}
                    <small>{connection.email}</small>
                  </td>
                  <td>{categoryLabel(connection.provider)}</td>
                  <td>
                    <span
                      className={`status ${connection.status === "connected" ? "success" : connection.status === "needs_attention" ? "danger" : "info"}`}
                    >
                      {categoryLabel(connection.status)}
                    </span>
                    <small>
                      Token expires{" "}
                      {formatDate(
                        connection.expiresAt,
                        loaderData.eventTimezone,
                      )}
                    </small>
                    <small>
                      Last provider sync{" "}
                      {formatDate(
                        connection.lastSyncedAt,
                        loaderData.eventTimezone,
                      )}
                    </small>
                  </td>
                  <td>
                    <div className="row-actions">
                      {connection.status === "connected" ||
                      connection.status === "needs_attention" ? (
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="refresh-calendar"
                          />
                          <input
                            type="hidden"
                            name="connectionId"
                            value={connection.id}
                          />
                          <button className="btn small" disabled={working}>
                            {working && pendingIntent === "refresh-calendar"
                              ? "Refreshing…"
                              : "Refresh token"}
                          </button>
                        </Form>
                      ) : null}
                      {connection.status === "connected" ||
                      connection.status === "needs_attention" ? (
                        <Form
                          method="post"
                          onSubmit={(event) => {
                            if (
                              !window.confirm(
                                "Disconnect this calendar account? Active direct invitations must be cancelled first.",
                              )
                            )
                              event.preventDefault();
                          }}
                        >
                          <input
                            type="hidden"
                            name="intent"
                            value="disconnect-calendar"
                          />
                          <input
                            type="hidden"
                            name="connectionId"
                            value={connection.id}
                          />
                          <button className="btn small" disabled={working}>
                            Disconnect
                          </button>
                        </Form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="help mb">No direct calendar account is connected.</p>
      )}
      <h3>Published-session invitations</h3>
      {loaderData.calendarTargets.length ? (
        <div className="table-wrap pc-responsive-table-wrap">
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Speaker</th>
                <th>Current state</th>
                <th>Explicit lifecycle actions</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.calendarTargets.map((target) => {
                const active =
                  target.invitationId &&
                  target.method !== "CANCEL" &&
                  target.invitationStatus !== "cancelled";
                const providerSelectionAvailable =
                  !target.invitationId ||
                  (target.method === "CANCEL" &&
                    target.invitationStatus === "cancelled");
                return (
                  <tr key={`${target.sessionId}:${target.personId}`}>
                    <td className="pc-record-primary-cell" data-label="Session">
                      {target.sessionTitle}
                    </td>
                    <td data-label="Speaker">
                      <CommunicationRecipientIdentity
                        name={target.personName}
                        email={target.email}
                      />
                    </td>
                    <td data-label="Current state">
                      {target.invitationStatus
                        ? `${target.invitationProvider ?? "pending"} · seq ${target.sequenceNumber} · ${target.invitationStatus}${target.rsvpStatus ? ` · RSVP ${categoryLabel(target.rsvpStatus)}` : ""}`
                        : "Not sent"}
                    </td>
                    <td className="pc-record-action-cell" data-label="Actions">
                      <div className="row-actions">
                        {providerSelectionAvailable ? (
                          <>
                            <CalendarAction
                              target={target}
                              method="REQUEST"
                              provider="email_ics"
                              working={working}
                            />
                            {target.activeProvider &&
                            target.activeConnectionId ? (
                              <CalendarAction
                                target={target}
                                method="REQUEST"
                                provider={target.activeProvider}
                                connectionId={target.activeConnectionId}
                                working={working}
                              />
                            ) : null}
                          </>
                        ) : target.invitationProvider ? (
                          <CalendarAction
                            target={target}
                            method="REQUEST"
                            provider={target.invitationProvider}
                            connectionId={target.invitationConnectionId}
                            working={working}
                          />
                        ) : null}
                        {active && target.invitationProvider ? (
                          <CalendarAction
                            target={target}
                            method="CANCEL"
                            provider={target.invitationProvider}
                            connectionId={target.invitationConnectionId}
                            working={working}
                          />
                        ) : null}
                        {active &&
                        target.invitationId &&
                        target.invitationProvider !== "email_ics" &&
                        (target.invitationStatus === "sent" ||
                          target.invitationStatus === "confirmed") ? (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="reconcile-calendar-rsvp"
                            />
                            <input
                              type="hidden"
                              name="invitationId"
                              value={target.invitationId}
                            />
                            <button className="btn small" disabled={working}>
                              Reconcile RSVP
                            </button>
                          </Form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty compact">
          <p>
            Publish a scheduled speaker session to administer its invitation.
          </p>
        </div>
      )}
    </section>
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
                <th>Created ({loaderData.eventTimezone})</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.communications.map((item) => (
                <tr key={item.id}>
                  <td>
                    {formatDate(item.createdAt, loaderData.eventTimezone)}
                    {item.scheduledAt ? (
                      <small>
                        Scheduled{" "}
                        {formatDate(item.scheduledAt, loaderData.eventTimezone)}
                      </small>
                    ) : null}
                    <small>{item.id}</small>
                  </td>
                  <td>
                    <DomainStatusBadge
                      domain="communication"
                      status={item.status}
                    />
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
                  <td className="pc-record-primary-cell" data-label="Session">
                    {invitation.sessionTitle}
                    <small>{invitation.icalUid}</small>
                  </td>
                  <td data-label="Speaker">
                    <CommunicationRecipientIdentity
                      name={invitation.personName}
                      email={invitation.email}
                    />
                  </td>
                  <td data-label="Provider">
                    {invitation.provider ?? "Pending"}
                  </td>
                  <td data-label="Lifecycle">
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
