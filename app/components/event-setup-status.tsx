import { CircleAlert, CircleCheck } from "lucide-react";

import { Button } from "~/components/ui/button";
import type { ActionResponse } from "~/routes/event-setup";

/* One result banner, three sources. The mark is a real icon at one optical
   size: the "△" it replaces is a hollow geometric shape, not a warning
   triangle, and it was carrying the failure state of a save. */
export function ResultNotice({ response }: { response: ActionResponse }) {
  return (
    <div
      className={`card pad mb validation-item event-setup-notice ${response.ok ? "ok" : "error"}`}
      role={response.ok ? "status" : "alert"}
    >
      {response.ok ? (
        <CircleCheck aria-hidden size={18} />
      ) : (
        <CircleAlert aria-hidden size={18} />
      )}
      <span>{response.message}</span>
    </div>
  );
}

export function EventSetupCommitActions({
  compact = false,
  changeCount,
  hasAnyUnsavedChanges,
  pendingRecordDraftPresent,
  saving,
  onDiscard,
  pendingHelpId,
  className,
}: {
  compact?: boolean;
  changeCount: number;
  hasAnyUnsavedChanges: boolean;
  pendingRecordDraftPresent: boolean;
  saving: boolean;
  onDiscard(): void;
  pendingHelpId: string;
  className?: string;
}) {
  return (
    <div
      className={`event-setup-actions${className ? ` ${className}` : ""}`}
      data-dirty={hasAnyUnsavedChanges ? "true" : undefined}
    >
      {pendingRecordDraftPresent ? (
        <p className="event-setup-state is-blocked" id={pendingHelpId}>
          <CircleAlert aria-hidden size={16} />
          {compact
            ? "Finish the unfinished item"
            : "Add or clear the unfinished room, resource, track or format before saving."}
        </p>
      ) : changeCount ? (
        <p className="event-setup-state is-dirty">
          <CircleAlert aria-hidden size={16} />
          {compact
            ? `${changeCount} unsaved`
            : `${changeCount} unsaved ${changeCount === 1 ? "change" : "changes"}`}
        </p>
      ) : (
        <p className="event-setup-state">
          <CircleCheck aria-hidden size={16} />
          Saved
        </p>
      )}
      <div className="event-setup-actions-buttons">
        <Button
          type="button"
          size={compact ? "small" : undefined}
          onClick={onDiscard}
          disabled={!hasAnyUnsavedChanges || saving}
        >
          {compact ? "Discard" : "Discard changes"}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size={compact ? "small" : undefined}
          disabled={saving || pendingRecordDraftPresent}
          aria-describedby={
            pendingRecordDraftPresent ? pendingHelpId : undefined
          }
        >
          {saving ? "Saving…" : compact ? "Save" : "Save event"}
        </Button>
      </div>
    </div>
  );
}
