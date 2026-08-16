import type { ComponentProps } from "react";

import { StatusBadge } from "./status-badge";
import { type StatusDomain, statusPresentation } from "./status-presentation";

export {
  STATUS_PRESENTATIONS,
  type StatusDomain,
  type StatusPresentation,
  type StatusTone,
  statusPresentation,
} from "./status-presentation";

export type DomainStatusBadgeProps = Omit<
  ComponentProps<typeof StatusBadge>,
  "children" | "tone"
> & {
  domain: StatusDomain;
  status: string;
};

export function DomainStatusBadge({
  domain,
  status,
  ...props
}: DomainStatusBadgeProps) {
  const presentation = statusPresentation(domain, status);
  return (
    <StatusBadge
      tone={presentation.tone}
      aria-label={props["aria-label"] ?? `${presentation.label} status`}
      data-status-domain={domain}
      data-status-value={status}
      {...props}
    >
      {presentation.label}
    </StatusBadge>
  );
}
