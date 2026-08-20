import { useState } from "react";
import { Form } from "react-router";

export function retentionHoldFormKey(holdAt: number | null) {
  return holdAt == null ? "none" : String(holdAt);
}

export function RetentionHoldForm({
  holdAt,
  busy,
}: {
  holdAt: number | null;
  busy: boolean;
}) {
  return (
    <RetentionHoldFields
      key={retentionHoldFormKey(holdAt)}
      busy={busy}
      holdAt={holdAt}
    />
  );
}

function RetentionHoldFields({
  holdAt,
  busy,
}: {
  holdAt: number | null;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Form method="post" className="stack">
      <input
        type="hidden"
        name="intent"
        value={holdAt ? "release-hold" : "place-hold"}
      />
      <label className="label">
        Reason
        <textarea
          className="textarea"
          name="reason"
          minLength={3}
          maxLength={500}
          required
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </label>
      <label className="speaker-confirm">
        <input
          type="checkbox"
          name="confirm"
          value="yes"
          required
          checked={confirmed}
          onChange={(event) => setConfirmed(event.currentTarget.checked)}
        />{" "}
        I understand this changes the event-wide retention boundary.
      </label>
      <button
        className="btn"
        type="submit"
        disabled={busy || !confirmed || reason.trim().length < 3}
      >
        {holdAt ? "Release retention hold" : "Place retention hold"}
      </button>
    </Form>
  );
}
