import { Send } from "lucide-react";
import { useState } from "react";
import { Form } from "react-router";

import { EventDateTime } from "~/components/ui/event-date-time";
import type { CommunicationPreview } from "~/modules/communications/communication-service.server";

type PendingIntent = FormDataEntryValue | null | undefined;

export function deliveryActionLabel(
  action: "Schedule" | "Confirm",
  deliveryCount: number,
) {
  return `${action} ${deliveryCount} ${deliveryCount === 1 ? "delivery" : "deliveries"}`;
}

export function CommunicationDraftPreview({
  preview,
  revision,
  scheduledAt,
  eventTimezone,
  working,
  pendingIntent,
  configurationDirty,
}: {
  preview: CommunicationPreview;
  revision: number;
  scheduledAt: number | null;
  eventTimezone: string;
  working: boolean;
  pendingIntent: PendingIntent;
  configurationDirty: boolean;
}) {
  const [viewport, setViewport] = useState<"mobile" | "desktop">("desktop");
  const deliveryCount = preview.recipients.deliverable.length;
  const confirmationBlocked =
    configurationDirty ||
    working ||
    !preview.provider.configured ||
    !preview.provider.queueConfigured ||
    deliveryCount === 0;

  return (
    <div className="stack mt">
      <div className="grid grid-4">
        <div className="metric">
          <span className="label">Selected</span>
          <strong className="value">{preview.recipients.selected}</strong>
        </div>
        <div className="metric">
          <span className="label">Deliverable</span>
          <strong className="value">{deliveryCount}</strong>
        </div>
        <div className="metric">
          <span className="label">Suppressed</span>
          <strong className="value">
            {preview.recipients.suppressed.length}
          </strong>
        </div>
        <div className="metric">
          <span className="label">Invalid</span>
          <strong className="value">{preview.recipients.invalid.length}</strong>
        </div>
      </div>

      {preview.recipients.invalid.length ||
      preview.recipients.suppressed.length ? (
        <div className="validation-item warn">
          <p>
            Excluded recipients will not receive this communication. Inspect the
            counts before confirming.
          </p>
          {preview.recipients.invalid.length ? (
            <details>
              <summary>
                {preview.recipients.invalid.length} invalid recipient
                {preview.recipients.invalid.length === 1 ? "" : "s"}
              </summary>
              <ul>
                {preview.recipients.invalid.slice(0, 20).map((recipient) => (
                  <li key={recipient.address}>
                    {recipient.name ? `${recipient.name} · ` : ""}
                    {recipient.address} — {recipient.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="validation-item ok">
          All selected recipients are deliverable.
        </div>
      )}

      {configurationDirty ? (
        <div className="validation-item error" role="alert">
          The visible configuration has unsaved changes. Save it and generate a
          new preview before confirming.
        </div>
      ) : null}

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
              srcDoc={preview.rendered.html}
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
                {preview.recipients.deliverable
                  .slice(0, 20)
                  .map((recipient) => (
                    <tr
                      key={`${recipient.address}:${recipient.sourceId ?? ""}`}
                    >
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
          {deliveryCount > 20 ? (
            <p className="help">Showing 20 of {deliveryCount} recipients.</p>
          ) : null}
        </div>
      </div>

      {scheduledAt !== null ? (
        <div className="validation-item info">
          <span className="comms-schedule-summary">
            Scheduled for{" "}
            <EventDateTime
              epochSeconds={scheduledAt}
              timeZone={eventTimezone}
              showTimeZone
            />
            . No Queue message will be sent before that instant.
          </span>
        </div>
      ) : null}

      <div className="divider" />
      <div className="card-title">
        <h2>3. Confirm durable delivery</h2>
      </div>
      {!preview.provider.configured || !preview.provider.queueConfigured ? (
        <div className="validation-item error">
          Confirm is blocked until the verified sender, provider and Operations
          Queue are available.
        </div>
      ) : null}
      <Form method="post" className="row-actions">
        <input type="hidden" name="intent" value="confirm-draft" />
        <input type="hidden" name="revision" value={revision} />
        <input
          type="hidden"
          name="recipientFingerprint"
          value={preview.confirmation.recipientFingerprint}
        />
        <input
          type="hidden"
          name="deliverableFingerprint"
          value={preview.confirmation.deliverableFingerprint}
        />
        <input
          type="hidden"
          name="suppressedCount"
          value={preview.confirmation.suppressedCount}
        />
        <span className="help">
          Confirmation recomputes the audience and atomically transitions this
          draft.
        </span>
        <button className="btn primary" disabled={confirmationBlocked}>
          <Send aria-hidden size={16} />
          {working && pendingIntent === "confirm-draft"
            ? "Recording…"
            : deliveryActionLabel(
                scheduledAt === null ? "Confirm" : "Schedule",
                deliveryCount,
              )}
        </button>
      </Form>
    </div>
  );
}
