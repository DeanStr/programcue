import type {
  DraftRecoveryController,
  DraftRecoveryState,
} from "~/platform/drafts/draft-recovery";

const labels: Record<DraftRecoveryState, string> = {
  checking: "Checking recovery…",
  idle: "",
  saving: "Saving recovery…",
  saved: "Saved locally",
  offline: "Offline",
  retry_required: "Retry required",
  incompatible: "Incompatible draft",
  restore_available: "Restore available",
  restored: "Restored draft",
  conflict: "Draft conflict",
};

function statusClass(state: DraftRecoveryState) {
  if (
    state === "retry_required" ||
    state === "incompatible" ||
    state === "conflict"
  )
    return "danger";
  if (state === "offline" || state === "restore_available") return "warning";
  if (state === "saving" || state === "checking") return "info";
  return "success";
}

export function DraftRecoveryStatus({
  state,
}: {
  state: DraftRecoveryState;
}) {
  if (state === "idle") return null;
  return (
    <span className={`status ${statusClass(state)}`} role="status">
      {labels[state]}
    </span>
  );
}

export function DraftRecoveryFeedback<T>({
  recovery,
  className = "mb",
}: {
  recovery: DraftRecoveryController<T>;
  className?: string;
}) {
  const needsChoice =
    recovery.state === "restore_available" || recovery.state === "conflict";
  const incompatible = recovery.state === "incompatible";
  if (!needsChoice && !incompatible && recovery.state !== "retry_required")
    return null;
  return (
    <div
      className={`validation-item ${recovery.state === "restore_available" ? "warn" : "error"} ${className}`.trim()}
      role={
        recovery.state === "retry_required" || incompatible ? "alert" : "status"
      }
    >
      <strong>{labels[recovery.state]}</strong>
      <span>
        {recovery.message ??
          "Browser recovery needs attention before you leave this editor."}
      </span>
      <span className="row-actions right">
        {needsChoice ? (
          <>
            <button className="btn small" type="button" onClick={recovery.restore}>
              Restore local edits
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => void recovery.discard()}
            >
              Discard recovery copy
            </button>
          </>
        ) : incompatible ? (
          <button
            className="btn small"
            type="button"
            onClick={() => void recovery.discard()}
          >
            Discard incompatible copy
          </button>
        ) : (
          <>
            <button
              className="btn small"
              type="button"
              onClick={() => void recovery.retry()}
            >
              Retry recovery
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => void recovery.discard()}
            >
              Discard browser copy
            </button>
          </>
        )}
      </span>
    </div>
  );
}
