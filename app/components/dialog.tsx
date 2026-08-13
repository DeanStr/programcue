import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, type RefObject } from "react";

export function Dialog({
  title,
  children,
  footer,
  onClose,
  returnFocus,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
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
        <DialogPrimitive.Overlay className="modal-overlay">
          <DialogPrimitive.Content
            ref={setContentRef}
            className="modal"
            aria-labelledby={titleId}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              restoreFocus();
            }}
          >
            <div className="modal-head">
              <DialogPrimitive.Title id={titleId} asChild>
                <h2>{title}</h2>
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className="icon-btn" aria-label="Close">
                <X aria-hidden size={17} />
              </DialogPrimitive.Close>
            </div>
            <div className="modal-body">{children}</div>
            {footer ? <div className="modal-foot">{footer}</div> : null}
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
