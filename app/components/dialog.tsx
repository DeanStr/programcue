import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, type RefObject } from "react";

/** Width class. The default stays at the historical 680px. */
type DialogSize = "sm" | "md" | "lg";

/**
 * Where the panel sits on a pointer-width screen.
 *
 *   center      a decision that owns the screen: forms, confirmations.
 *   top-start   a menu belonging to a control on the left of the top bar.
 *   top-end     a menu belonging to a control on the right of the top bar.
 *   top         a full-width instrument that opens from the top: the palette.
 *
 * Below 760px every placement becomes a sheet, because a phone has no room to
 * anchor anything and a centred card leaves scrim on all four sides.
 */
type DialogPlacement = "center" | "top" | "top-start" | "top-end";

export function Dialog({
  title,
  description,
  icon,
  children,
  footer,
  onClose,
  returnFocus,
  size = "md",
  placement = "center",
  tone = "info",
  titleHidden = false,
  bare = false,
}: {
  title: string;
  /** One line of context under the title. Also becomes the accessible description. */
  description?: React.ReactNode;
  /** Head glyph. Gives a wall of same-shaped panels something to be told apart by. */
  icon?: React.ReactNode;
  /** Colours the head glyph. A destructive decision should look like one before it is read. */
  tone?: "info" | "danger" | "warning";
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
  size?: DialogSize;
  placement?: DialogPlacement;
  /** Keep the accessible name, drop the painted head: for panels that supply their own. */
  titleHidden?: boolean;
  /** Remove body padding, for lists and instruments that own their own gutters. */
  bare?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const capturedReturnFocusRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const returnFocusFrameRef = useRef<number | null>(null);
  const restoreFocus = useCallback(() => {
    const target = returnFocus?.current ?? capturedReturnFocusRef.current;
    if (target?.isConnected) target.focus();
  }, [returnFocus]);
  const setContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (node) {
        // Capture at portal mount, immediately before Radix moves focus into the
        // dialog. Capturing during React render is timing-dependent under load
        // and can observe <body> instead of the control that opened the dialog.
        if (!returnFocus && document.activeElement instanceof HTMLElement) {
          capturedReturnFocusRef.current = document.activeElement;
        }
        if (returnFocusFrameRef.current !== null) {
          window.cancelAnimationFrame(returnFocusFrameRef.current);
          returnFocusFrameRef.current = null;
        }
        return;
      }
      // Radix completes its own focus-scope teardown after the portal unmounts.
      // Restore on the next frame so that cleanup cannot move focus back to
      // <body> after we have already returned it to the opener.
      returnFocusFrameRef.current = window.requestAnimationFrame(() => {
        returnFocusFrameRef.current = null;
        restoreFocus();
      });
    },
    [restoreFocus, returnFocus],
  );

  useEffect(() => {
    const focusTimer = window.setTimeout(() => {
      const focusTarget =
        contentRef.current?.querySelector<HTMLElement>(
          "[data-dialog-autofocus], input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled])",
        ) ??
        contentRef.current?.querySelector<HTMLElement>(
          "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
        );
      focusTarget?.focus();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
    };
  }, []);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="modal-overlay"
          data-placement={placement}
        >
          <DialogPrimitive.Content
            ref={setContentRef}
            className="modal"
            data-size={size}
            data-placement={placement}
            data-bare={bare ? "" : undefined}
            aria-labelledby={titleId}
            // Radix warns when a dialog has no description; passing undefined
            // is its documented way of saying "there deliberately is none".
            aria-describedby={description ? descriptionId : undefined}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              restoreFocus();
            }}
          >
            {/* Deliberately no grabber. A sheet handle states that the panel
                can be dragged away, and nothing here implements that gesture;
                the head's close control and Escape are the real exits. */}
            {titleHidden ? (
              <DialogPrimitive.Title id={titleId} className="sr-only">
                {title}
              </DialogPrimitive.Title>
            ) : (
              <div className="modal-head">
                {icon ? (
                  <span
                    className="modal-head-icon"
                    data-tone={tone}
                    aria-hidden
                  >
                    {icon}
                  </span>
                ) : null}
                <div className="modal-head-copy">
                  <DialogPrimitive.Title id={titleId} asChild>
                    <h2>{title}</h2>
                  </DialogPrimitive.Title>
                  {description ? (
                    <DialogPrimitive.Description
                      id={descriptionId}
                      className="modal-description"
                    >
                      {description}
                    </DialogPrimitive.Description>
                  ) : null}
                </div>
                <DialogPrimitive.Close
                  className="icon-btn modal-close"
                  aria-label="Close"
                >
                  <X aria-hidden size={17} />
                </DialogPrimitive.Close>
              </div>
            )}
            <div className="modal-body">{children}</div>
            {footer ? <div className="modal-foot">{footer}</div> : null}
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
