import { Form } from "react-router";
import { Button, ButtonLink, ButtonSummary } from "~/components/ui/button";
import type { CommunicationsCentreLoaderData } from "~/routes/communications-centre";
import {
  communicationCategoryLabel as categoryLabel,
  type PendingIntent,
} from "./communications-panel-shared";

type ReadinessCell = {
  label: string;
  ready: boolean;
  /** The state itself, so the dot is never the only thing carrying it. */
  state: string;
  detail: string;
};

/**
 * The four cells this replaced all read as the same grey sentence, so the one
 * fact the reader came for — can this event send email — took four readings to
 * assemble. The fourth cell stated a policy that never varies, which is chrome
 * rather than state, and is gone.
 */
export function DeliveryReadiness({
  loaderData,
}: {
  loaderData: CommunicationsCentreLoaderData;
}) {
  const provider = loaderData.provider;
  const providerLabel = provider.name === "mailpit" ? "Mailpit" : "Resend";
  const cells: ReadinessCell[] = [
    {
      label: "Sender",
      ready: Boolean(provider.sender),
      state: provider.sender ? "Verified" : "Not verified",
      detail:
        provider.sender ??
        "No sender profile is verified, so every send is refused.",
    },
    {
      label: providerLabel,
      ready: provider.configured,
      state: provider.configured ? "Connected" : "Not configured",
      detail: provider.configured
        ? provider.name === "mailpit"
          ? "Local capture address and verified sender are both present."
          : "Sending credentials and a verified sender are both present."
        : "Sending credentials are missing or the sender is unverified.",
    },
    {
      label: "Delivery queue",
      ready: provider.queueConfigured,
      state: provider.queueConfigured ? "Ready" : "Unavailable",
      detail: provider.queueConfigured
        ? "Every send is recorded durably before it is dispatched."
        : "Nothing can be dispatched until the operations queue is available.",
    },
  ];
  const blocked = cells.some((cell) => !cell.ready);
  return (
    <section
      className={`pc-admin-page-section comms-readiness${blocked ? " is-blocked" : ""}`}
      aria-labelledby="communications-readiness-title"
    >
      <header className="pc-admin-section-head">
        <div className="pc-admin-section-head-copy">
          <h2 id="communications-readiness-title">
            {blocked ? "Delivery blocked" : "Delivery ready"}
          </h2>
          <p>
            {blocked
              ? "Email cannot leave Program Cue until every requirement below is met."
              : "Every requirement for sending email from this event is met."}
          </p>
        </div>
        <ButtonLink to="?view=setup">Delivery settings</ButtonLink>
      </header>
      <p className="comms-readiness-line">
        <span className="comms-readiness-state">
          {blocked ? "Blocked" : "Ready"}
        </span>
        {cells.map((cell) => (
          <span
            key={cell.label}
            className="comms-readiness-fact"
            data-ready={cell.ready}
          >
            <strong>{cell.label}</strong> {cell.state}
            {blocked && !cell.ready ? ` — ${cell.detail}` : ""}
          </span>
        ))}
      </p>
    </section>
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
  const allPublished = loaderData.templates.filter(
    (template) => template.versionStatus === "published",
  );
  const published = allPublished.filter(
    (template) => template.category !== "submission_confirmation",
  );
  const emailProviderLabel =
    loaderData.provider.name === "mailpit" ? "Mailpit" : "Resend";
  const localCapture = loaderData.provider.name === "mailpit";
  const testSendBlocker = !loaderData.provider.queueConfigured
    ? "The operations queue is unavailable, so nothing can be dispatched."
    : !loaderData.provider.configured
      ? "Verify a sender profile first."
      : !published.length
        ? allPublished.length
          ? "Published submission confirmations are sent automatically and cannot be used for test sends."
          : "Publish a template version first."
        : null;
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Sender profiles and test sends</h2>
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
            <Button type="submit" disabled={working}>
              {working && pendingIntent === "save-sender"
                ? "Saving…"
                : localCapture
                  ? "Save verified local sender"
                  : "Save unverified sender"}
            </Button>
          </Form>
          {/* No empty state here: the create form above is the empty state, and
              an illustrated box 40px below it explaining that form was the
              loudest way this page had of saying nothing was wrong. */}
          {loaderData.senders.length ? (
            <section
              className="table-wrap"
              aria-label="Sender profiles"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
              tabIndex={0}
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Sender</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
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
                              <Button
                                type="submit"
                                size="small"
                                disabled={working}
                              >
                                Check Resend
                              </Button>
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
                            <Button
                              type="submit"
                              size="small"
                              disabled={working}
                            >
                              {sender.status === "disabled"
                                ? "Enable"
                                : "Disable"}
                            </Button>
                          </Form>
                          <details className="pc-disclosure">
                            <ButtonSummary size="small">Edit</ButtonSummary>
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
                              <Button
                                type="submit"
                                size="small"
                                disabled={working}
                              >
                                Save changes
                              </Button>
                            </Form>
                          </details>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
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
            <div className="row-actions">
              {/* A disabled primary with no stated cause is a button the reader
                  clicks and gets nothing from. The unmet condition sits beside
                  it, because there is no other place on this page that names
                  which of the three it is. */}
              {testSendBlocker ? (
                <span className="help">{testSendBlocker}</span>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                disabled={working || Boolean(testSendBlocker)}
              >
                {working && pendingIntent === "test-send"
                  ? "Queueing…"
                  : "Send real test email"}
              </Button>
            </div>
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
  const scheduleTemplates = loaderData.templates.filter(
    (template) =>
      template.category === "schedule" &&
      template.versionStatus === "published",
  );
  return (
    <div className="stack">
      <section className="card pad">
        <div className="card-title">
          <h2>Reminder triggers</h2>
          <span className="status info right">
            {loaderData.triggers.length}
          </span>
        </div>
        <p className="help">
          The scheduled Worker marks expired tasks overdue, evaluates each
          trigger once per UTC day and records every resulting send durably
          before Queue dispatch.
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
                <option value="application_draft">Unsubmitted drafts</option>
                <option value="participation_pending">
                  Pending participation responses
                </option>
              </select>
            </label>
          </div>
          <div className="form-row comms-trigger-row">
            <label className="label">
              Audience
              <select
                className="select"
                name="triggerAudience"
                defaultValue="due_speakers"
              >
                <option value="due_speakers">
                  Speakers due within 24 hours
                </option>
                <option value="overdue_speakers">Overdue speakers</option>
                <option value="draft_applicants">Applicants with drafts</option>
                <option value="pending_participants">
                  Participants awaiting a response
                </option>
                <option value="event_administrators">
                  Event administrators
                </option>
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
              <select
                className="select"
                name="kind"
                defaultValue="transactional"
              >
                <option value="transactional">Transactional</option>
                <option value="optional">Optional / unsubscribe-aware</option>
              </select>
            </label>
          </div>
          <div className="row-actions">
            {reminderTemplates.length ? null : (
              <span className="help">
                Publish a task-reminder template before enabling a trigger.
              </span>
            )}
            <Button
              type="submit"
              disabled={working || !reminderTemplates.length}
            >
              {working && pendingIntent === "save-trigger"
                ? "Saving…"
                : "Enable reminder trigger"}
            </Button>
          </div>
        </Form>
        {loaderData.triggers.length ? (
          <section
            className="table-wrap mt"
            aria-label="Automatic reminder triggers"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Template</th>
                  <th scope="col">Rule</th>
                  <th scope="col">Last run</th>
                  <th scope="col">Action</th>
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
                            trigger.enabled
                              ? "disable-trigger"
                              : "enable-trigger"
                          }
                        />
                        <input
                          type="hidden"
                          name="triggerId"
                          value={trigger.id}
                        />
                        <Button type="submit" size="small" disabled={working}>
                          {trigger.enabled ? "Disable" : "Enable"}
                        </Button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </section>
      <section
        className="card pad"
        aria-labelledby="schedule-change-email-heading"
      >
        <div className="card-title">
          <div>
            <h2 id="schedule-change-email-heading">Schedule-change email</h2>
            <p className="help">
              One transactional email per affected participant when a revised
              schedule is published. Draft edits never send email.
            </p>
          </div>
          <span
            className={`status ${loaderData.scheduleChangeNotificationSetting.enabled ? "ok" : "info"} right`}
          >
            {loaderData.scheduleChangeNotificationSetting.enabled
              ? "Enabled"
              : "Off"}
          </span>
        </div>
        <Form
          key={`${loaderData.scheduleChangeNotificationSetting.enabled}:${loaderData.scheduleChangeNotificationSetting.templateVersionId ?? "none"}`}
          method="post"
          className="stack"
        >
          <label className="label">
            Published schedule template
            <select
              className="select"
              name="templateVersionId"
              defaultValue={
                loaderData.scheduleChangeNotificationSetting
                  .templateVersionId ?? ""
              }
              required
            >
              <option value="" disabled>
                Select a published schedule template
              </option>
              {scheduleTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} · v{template.versionNumber}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              name="enabled"
              value="true"
              defaultChecked={
                loaderData.scheduleChangeNotificationSetting.enabled
              }
            />
            Notify pending and confirmed participants on publication
          </label>
          <p className="help">
            Supported merge fields: {"{{schedule.changes}}"} and{" "}
            {"{{schedule.url}}"}. Declined roles are excluded. The first
            publication does not send a change email.
          </p>
          <div className="row-actions">
            {!scheduleTemplates.length ? (
              <span className="help">
                Publish a schedule email template before enabling this setting.
              </span>
            ) : null}
            <Button
              type="submit"
              name="intent"
              value="save-schedule-change-notifications"
              disabled={working || !scheduleTemplates.length}
            >
              {working && pendingIntent === "save-schedule-change-notifications"
                ? "Saving…"
                : "Save schedule email setting"}
            </Button>
            {loaderData.scheduleChangeNotificationSetting.enabled ? (
              <Button
                type="submit"
                name="intent"
                value="disable-schedule-change-notifications"
                formNoValidate
                disabled={working}
              >
                Disable
              </Button>
            ) : null}
          </div>
        </Form>
      </section>
    </div>
  );
}

export type SenderDnsRecord = {
  type: string;
  name: string;
  value: string;
  priority: string | null;
};

export type SenderDnsRecordSet = {
  readable: SenderDnsRecord[];
  /** Verbatim entries whose shape this table could not read. */
  unreadable: string[];
};

/**
 * The reader has to retype each of these into their DNS host, so the records
 * are a table they can read a row at a time. The provider's raw JSON was
 * accurate but unusable for the one job this panel has.
 *
 * Any entry the table cannot read is still shown, verbatim and labelled as
 * such. Publishing an incomplete set leaves the domain unverified with nothing
 * on screen to explain why, so an unrecognised record has to stay visible.
 */
export function SenderDnsRecords({ records }: { records: SenderDnsRecordSet }) {
  return (
    <>
      {records.readable.length ? (
        <section
          className="table-wrap mt"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
          aria-label="DNS records to add"
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Name</th>
                <th scope="col">Value</th>
                <th scope="col">Priority</th>
              </tr>
            </thead>
            <tbody>
              {records.readable.map((record) => (
                <tr key={`${record.type}:${record.name}:${record.value}`}>
                  <td data-label="Type">{record.type}</td>
                  <td data-label="Name">
                    <code>{record.name}</code>
                  </td>
                  <td data-label="Value">
                    <code>{record.value}</code>
                  </td>
                  <td data-label="Priority">{record.priority ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {records.unreadable.length ? (
        <div className="validation-item warn mt" role="alert">
          <strong>
            {records.unreadable.length} record
            {records.unreadable.length === 1 ? "" : "s"} could not be displayed
          </strong>
          <span>
            Resend returned {records.unreadable.length === 1 ? "it" : "them"} in
            a shape Program Cue does not recognise. Add{" "}
            {records.unreadable.length === 1 ? "it" : "them"} from your Resend
            dashboard as well; the domain will not verify until every record is
            published.
          </span>
          {records.unreadable.map((entry) => (
            <pre className="code-block" key={entry}>
              {entry}
            </pre>
          ))}
        </div>
      ) : null}
    </>
  );
}
