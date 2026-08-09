import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

export function Dialog({
  title,
  children,
  footer,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => {
      const focusTarget = contentRef.current?.querySelector<HTMLElement>(
        "[data-dialog-autofocus], input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled])",
      ) ?? contentRef.current?.querySelector<HTMLElement>("button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])");
      focusTarget?.focus();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      requestAnimationFrame(() => {
        if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
      });
    };
  }, []);

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="modal-overlay">
          <DialogPrimitive.Content
            ref={contentRef}
            className="modal"
            aria-labelledby={titleId}
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <div className="modal-head">
              <DialogPrimitive.Title id={titleId} asChild><h2>{title}</h2></DialogPrimitive.Title>
              <DialogPrimitive.Close className="icon-btn" aria-label="Close"><X aria-hidden size={17} /></DialogPrimitive.Close>
            </div>
            <div className="modal-body">{children}</div>
            {footer ? <div className="modal-foot">{footer}</div> : null}
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
