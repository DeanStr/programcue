import { CheckCircle2, Inbox, LoaderCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/cn";

/**
 * An empty state almost always sits inside a card that already has a heading,
 * so it defaults to h3. Pass headingLevel to place it correctly for its
 * surrounding outline rather than always emitting an h2 sibling.
 */
export function EmptyState({
  title,
  description,
  action,
  icon: Icon,
  tone = "neutral",
  headingLevel = 3,
  className,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  tone?: "neutral" | "positive";
  headingLevel?: 2 | 3 | 4;
  className?: string;
}) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const Glyph = Icon ?? (tone === "positive" ? CheckCircle2 : Inbox);
  return (
    <section
      className={cn("empty pc-empty-state", tone === "positive" && "is-positive", className)}
    >
      <span className="pc-state-icon">
        <Glyph aria-hidden size={22} />
      </span>
      <Heading>{title}</Heading>
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
    <div
      className={cn("pc-pending-state", className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="pc-pending-label">
        <LoaderCircle className="pc-spin" aria-hidden size={17} /> {label}
      </div>
      <div aria-hidden className="pc-skeleton-stack">
        {Array.from({ length: rows }, (_, index) => (
          <span key={index} style={{ width: `${92 - index * 9}%` }} />
        ))}
      </div>
    </div>
  );
}
