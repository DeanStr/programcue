import { Form } from "react-router";
import { EmptyState } from "~/components/ui/states";
import type { CommunicationsCentreLoaderData } from "~/routes/communications-centre";
import {
  communicationCategoryLabel as categoryLabel,
  type PendingIntent,
} from "./communications-panel-shared";

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
                          <details className="pc-disclosure">
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
            <EmptyState
              headingLevel={4}
              title="No sender profile yet"
              description={`Add a ${emailProviderLabel} sender profile above before any communication can be sent.`}
            />
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
