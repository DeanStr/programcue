import type { ComponentProps } from "react";

import { StatusBadge } from "./status-badge";
import { statusPresentation, type StatusDomain } from "./status-presentation";

export {
  STATUS_PRESENTATIONS,
  statusPresentation,
  type StatusDomain,
  type StatusPresentation,
  type StatusTone,
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
