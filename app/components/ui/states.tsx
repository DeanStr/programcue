import { Inbox, LoaderCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/cn";

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
  className,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <section className={cn("empty pc-empty-state", className)}>
      <span className="pc-state-icon"><Icon aria-hidden size={22} /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="pc-state-action">{action}</div> : null}
    </section>
  );
}

export function PendingState({
  label = "Loading content",
  rows = 3,
  className,
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("pc-pending-state", className)} role="status" aria-live="polite" aria-busy="true">
      <div className="pc-pending-label"><LoaderCircle className="pc-spin" aria-hidden size={17} /> {label}</div>
      <div aria-hidden className="pc-skeleton-stack">
        {Array.from({ length: rows }, (_, index) => <span key={index} style={{ width: `${92 - index * 9}%` }} />)}
      </div>
    </div>
  );
}
