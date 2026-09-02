import { Dialog } from "~/components/dialog";
import { DraftRecoveryFeedback } from "~/components/draft-recovery-feedback";
import { useReviewWorkbenchModel } from "~/components/review-workbench-model";
import { Button } from "~/components/ui/button";
import { useConfirm } from "~/components/ui/confirm-dialog";

export function ReviewWorkbenchHeader() {
  const {
    fetcher,
    dirty,
    readOnly,
    committedWarning,
    saveFailed,
    recovery,
    workspace,
  } = useReviewWorkbenchModel();
  const hasSavedDraft = Boolean(workspace.review);
  return (
    <div className="page-head review-page-head">
      <div>
        <h1>Review workbench</h1>
        <p>
          {workspace.selected
            ? readOnly
              ? "Inspect the submitted scoring record without losing queue context."
              : "Score the open assignment without losing queue context."
            : "Assigned reviews appear here when an organiser gives you work."}
        </p>
      </div>
      <div className="page-actions">
        <span className="review-head-status">
          {recovery.state === "checking"
            ? "Checking recovery"
            : recovery.state === "restore_available"
              ? "Restore available"
              : recovery.state === "conflict"
                ? "Draft conflict"
                : readOnly
                  ? "Submitted"
                  : fetcher.state !== "idle"
                    ? "Saving"
                    : committedWarning
                      ? "Saved · live update delayed"
                      : saveFailed
                        ? "Save failed"
                        : dirty
                          ? "Unsaved"
                          : hasSavedDraft
                            ? "Saved"
                            : "No draft yet"}
        </span>
      </div>
    </div>
  );
}

export function ReviewDraftRecoveryNotice() {
  const { recovery } = useReviewWorkbenchModel();
  return <DraftRecoveryFeedback recovery={recovery} />;
}

export function ReviewActionNotice() {
  const { fetcher, committedWarning } = useReviewWorkbenchModel();
  return fetcher.data &&
    !committedWarning &&
    ("error" in fetcher.data || ("ok" in fetcher.data && !fetcher.data.ok)) ? (
    <div className="validation-item error mb" role="alert">
      {"error" in fetcher.data ? fetcher.data.error : fetcher.data.message}
    </div>
  ) : fetcher.data && "message" in fetcher.data && fetcher.data.message ? (
    <div
      className={`validation-item ${committedWarning ? "warn" : "ok"} mb`}
      role="status"
    >
      {fetcher.data.message}
    </div>
  ) : null;
}

export function ReviewShortcutSheet() {
  const { shortcutsOpen, setShortcutsOpen, readOnly } =
    useReviewWorkbenchModel();
  return shortcutsOpen ? (
    <Dialog
      title="Keyboard shortcuts"
      onClose={() => setShortcutsOpen(false)}
      footer={
        <Button type="button" onClick={() => setShortcutsOpen(false)}>
          Close
        </Button>
      }
    >
      <dl className="shortcut-list review-shortcut-list">
        <div>
          <dt>
            <kbd>J</kbd> / <kbd>K</kbd>
          </dt>
          <dd>Open the next or previous assignment</dd>
        </div>
        {!readOnly ? (
          <>
            <div>
              <dt>
                <kbd>1</kbd> – <kbd>9</kbd>
              </dt>
              <dd>
                Score the criterion you are on, then move to the next unscored
                one
              </dd>
            </div>
            <div>
              <dt>
                <kbd>←</kbd> / <kbd>→</kbd>
              </dt>
              <dd>Move within one criterion&rsquo;s scale</dd>
            </div>
            <div>
              <dt>
                <kbd>⌘/Ctrl</kbd> + <kbd>S</kbd>
              </dt>
              <dd>Save the draft now</dd>
            </div>
            <div>
              <dt>
                <kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd>
              </dt>
              <dd>Submit this review and open the next</dd>
            </div>
          </>
        ) : null}
        <div>
          <dt>
            <kbd>?</kbd>
          </dt>
          <dd>Open this shortcut reference</dd>
        </div>
      </dl>
    </Dialog>
  ) : null;
}

export function ReviewSubmitDialog() {
  const {
    workspace,
    fetcher,
    submitMode,
    setSubmitMode,
    readOnly,
    submitReviewTriggerRef,
    submitNextTriggerRef,
  } = useReviewWorkbenchModel();
  return submitMode && workspace.selected && !readOnly ? (
    <Dialog
      title={
        submitMode === "next"
          ? "Submit and open the next review?"
          : "Submit this review?"
      }
      onClose={() => setSubmitMode(null)}
      returnFocus={
        submitMode === "next" ? submitNextTriggerRef : submitReviewTriggerRef
      }
      footer={null}
    >
      <div className="stack">
        <div className="validation-item warn">
          <strong>The submitted revision will be locked</strong>
          <span>
            Your scores, recommendation and notes become an immutable submitted
            snapshot. Only an authorised evaluation manager can explicitly
            reopen the review, and that creates a new revision.
          </span>
        </div>
        <p>
          {submitMode === "next"
            ? "After the server confirms submission, the next unfinished assignment will open automatically."
            : "You will remain on this submitted review after the server confirms it."}
        </p>
        <div className="page-actions">
          <Button type="button" onClick={() => setSubmitMode(null)}>
            Continue editing
          </Button>
          <Button
            form="review-score-form"
            type="submit"
            name="intent"
            value="submit"
            variant="primary"
            disabled={fetcher.state !== "idle"}
          >
            {submitMode === "next" ? "Submit and open next" : "Submit review"}
          </Button>
        </div>
      </div>
    </Dialog>
  ) : null;
}

export function ReviewDraftConflictNotice() {
  const { assignmentKey, fetcher, recoveryPayload, recovery } =
    useReviewWorkbenchModel();
  const { confirm, dialog } = useConfirm();
  return fetcher.data && "conflict" in fetcher.data && fetcher.data.conflict ? (
    <>
      {dialog}
      <div className="validation-item error mb" role="alert">
        <strong>Draft conflict</strong>
        <span>
          Your browser recovery copy remains intact. Export it or explicitly
          load the newer server revision; Program Cue will not overwrite it.
        </span>
        <span className="row-actions right">
          <Button
            size="small"
            type="button"
            onClick={() => {
              const blob = new Blob(
                [JSON.stringify(recoveryPayload, null, 2)],
                { type: "application/json" },
              );
              const href = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = href;
              link.download = `${assignmentKey}-review-recovery.json`;
              link.click();
              URL.revokeObjectURL(href);
            }}
          >
            Export local edits
          </Button>
          <Button
            size="small"
            type="button"
            onClick={() =>
              confirm(
                {
                  title: "Load the latest server review?",
                  description:
                    "The editor contents in this browser are discarded, the recovery copy is cleared and the page reloads with the newest server revision. Export your local edits first if you still need them.",
                  confirmLabel: "Discard and load server version",
                  tone: "danger",
                },
                () => {
                  void recovery.clear().then(() => window.location.reload());
                },
              )
            }
          >
            Load server version
          </Button>
        </span>
      </div>
    </>
  ) : null;
}

export function ReviewConflictDialog() {
  const {
    workspace,
    fetcher,
    conflictOpen,
    setConflictOpen,
    conflictTriggerRef,
    readOnly,
    cancelAutosave,
  } = useReviewWorkbenchModel();
  return conflictOpen && workspace.selected && !readOnly ? (
    <Dialog
      title="Declare a conflict"
      onClose={() => setConflictOpen(false)}
      returnFocus={conflictTriggerRef}
      footer={null}
    >
      <fetcher.Form
        method="post"
        className="stack"
        onSubmit={() => {
          cancelAutosave();
          setConflictOpen(false);
        }}
      >
        <input type="hidden" name="intent" value="conflict" />
        <input
          type="hidden"
          name="assignmentId"
          value={workspace.selected.id}
        />
        <label className="label">
          Reason
          <textarea
            className="textarea"
            name="reason"
            minLength={10}
            required
          />
        </label>
        <p className="help">
          The review will be recused and returned to the committee for
          reassignment.
        </p>
        <Button
          type="submit"
          variant="danger"
          disabled={fetcher.state !== "idle"}
        >
          {fetcher.state === "submitting" ? "Declaring…" : "Declare and recuse"}
        </Button>
      </fetcher.Form>
    </Dialog>
  ) : null;
}

export function ReviewAbstentionDialog() {
  const {
    workspace,
    fetcher,
    abstentionOpen,
    setAbstentionOpen,
    abstentionTriggerRef,
    readOnly,
    cancelAutosave,
  } = useReviewWorkbenchModel();
  return abstentionOpen && workspace.selected && !readOnly ? (
    <Dialog
      title="Cannot review this assignment"
      description="Return the assignment without submitting a review."
      onClose={() => setAbstentionOpen(false)}
      returnFocus={abstentionTriggerRef}
      footer={null}
    >
      <fetcher.Form
        method="post"
        className="stack"
        onSubmit={() => {
          cancelAutosave();
          setAbstentionOpen(false);
        }}
      >
        <input type="hidden" name="intent" value="abstain" />
        <input
          type="hidden"
          name="assignmentId"
          value={workspace.selected.id}
        />
        <label className="label">
          Reason
          <select className="select" name="reason" defaultValue="" required>
            <option value="" disabled>
              Choose a reason
            </option>
            <option value="insufficient_expertise">
              Insufficient expertise
            </option>
            <option value="unavailable">Unavailable</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="label">
          Private note (optional)
          <textarea className="textarea" name="note" maxLength={2000} />
        </label>
        <p className="help">
          This resolves the assignment for your queue but reduces organizer
          coverage. The private note is never shared with the applicant.
        </p>
        <Button
          type="submit"
          variant="danger"
          disabled={fetcher.state !== "idle"}
        >
          {fetcher.state === "submitting"
            ? "Returning…"
            : "Return without review"}
        </Button>
      </fetcher.Form>
    </Dialog>
  ) : null;
}
