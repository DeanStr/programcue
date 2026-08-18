import type { ReactNode } from "react";

import { cn } from "~/lib/cn";

export type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("page-head pc-page-header", className)}>
      <div className="pc-page-header-copy">
        {eyebrow ? <div className="pc-page-eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {description ? (
          <p className="pc-page-header-lede">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <fieldset
          className="page-actions pc-plain-fieldset"
          aria-label="Page actions"
        >
          {actions}
        </fieldset>
      ) : null}
    </header>
  );
}
