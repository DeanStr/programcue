import { AlertTriangle } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Dialog } from "~/components/dialog";

/**
 * Confirmation for consequential actions.
 *
 * window.confirm cannot show what is about to change, cannot be styled, and
 * cannot restore focus to the control that opened it. This can do all three,
 * and `records` is the point: the contributor guidance requires showing the
 * affected records before a consequential action, not just asking twice.
 */
export function ConfirmDialog({
  title,
  description,
  records,
  hideCount = false,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: ReactNode;
  /** What this action will actually affect. Omit only when there is nothing to enumerate. */
  records?: string[];
  /** Hide the leading count when records are grouped summaries, not atoms. */
  hideCount?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const shown = records?.slice(0, 8) ?? [];
  const remaining = (records?.length ?? 0) - shown.length;

  return (
    <Dialog
      title={title}
      icon={<AlertTriangle aria-hidden size={17} />}
      tone={tone === "danger" ? "danger" : "info"}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <button
            className="btn"
            data-dialog-autofocus={tone === "danger" ? true : undefined}
            data-pc-confirm="cancel"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className={tone === "danger" ? "btn danger" : "btn primary"}
            data-dialog-autofocus={tone === "primary" ? true : undefined}
            data-pc-confirm="accept"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {/* The glyph moved into the panel head, where every other panel carries
          one. It was indenting the sentence it sat beside by 46px and giving a
          confirmation a second, competing left margin. */}
      <div className="pc-confirm">
        <p>{description}</p>
        {records && records.length > 0 ? (
          <div>
            {hideCount ? null : (
              <p className="pc-confirm-count">
                {records.length} {records.length === 1 ? "record" : "records"}{" "}
                affected
              </p>
            )}
            <ul className="pc-confirm-records">
              {shown.map((record) => (
                <li key={record}>{record}</li>
              ))}
              {remaining > 0 ? (
                <li className="subtle">and {remaining} more</li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * Wiring for the common case: a button that needs confirmation before it runs.
 * Returns the dialog to render and the handler to attach.
 */
export function useConfirm() {
  const [pending, setPending] = useState<null | {
    props: Omit<Parameters<typeof ConfirmDialog>[0], "onConfirm" | "onCancel">;
    run: () => void;
  }>(null);

  return {
    confirm: (
      props: Omit<
        Parameters<typeof ConfirmDialog>[0],
        "onConfirm" | "onCancel"
      >,
      run: () => void,
    ) => setPending({ props, run }),
    dialog: pending ? (
      <ConfirmDialog
        {...pending.props}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          pending.run();
          setPending(null);
        }}
      />
    ) : null,
  };
}
