import { AlertTriangle, CheckCircle2, CircleAlert, Info } from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";

import { cn } from "~/lib/cn";

const ICONS = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: CircleAlert,
  info: Info,
} as const;

type StatusNoticeProps = {
  title: string;
  children?: ReactNode;
  tone?: keyof typeof ICONS;
  action?: ReactNode;
  className?: string;
};

export function StatusNotice({
  title,
  children,
  tone = "info",
  action,
  className,
}: StatusNoticeProps) {
  const Icon = ICONS[tone];
  const titleId = useId();
  return (
    <section
      className={cn("pc-status-notice", `is-${tone}`, className)}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
      aria-labelledby={titleId}
    >
      <Icon aria-hidden size={16} />
      <div className="pc-status-notice-copy">
        <strong id={titleId}>{title}</strong>
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="pc-status-notice-action">{action}</div> : null}
    </section>
  );
}
