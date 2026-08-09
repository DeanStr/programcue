import { AlertTriangle, CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/cn";

const ICONS = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: CircleAlert,
  info: Info,
} as const;

export type StatusNoticeProps = {
  title: string;
  children?: ReactNode;
  tone?: keyof typeof ICONS;
  action?: ReactNode;
  onDismiss?: () => void;
  className?: string;
};

export function StatusNotice({
  title,
  children,
  tone = "info",
  action,
  onDismiss,
  className,
}: StatusNoticeProps) {
  const Icon = ICONS[tone];
  return (
    <section
      className={cn("pc-status-notice", `is-${tone}`, className)}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
    >
      <Icon aria-hidden size={19} />
      <div className="pc-status-notice-copy">
        <strong>{title}</strong>
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="pc-status-notice-action">{action}</div> : null}
      {onDismiss ? <button type="button" className="icon-btn" aria-label="Dismiss notification" onClick={onDismiss}><X aria-hidden size={16} /></button> : null}
    </section>
  );
}
