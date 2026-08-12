import type { ComponentProps } from "react";

import { StatusBadge } from "./status-badge";

type StatusTone = NonNullable<ComponentProps<typeof StatusBadge>["tone"]>;

type StatusPresentation = {
  label: string;
  tone: StatusTone;
};

export const STATUS_PRESENTATIONS = {
  submission: {
    draft: { label: "Draft", tone: "neutral" },
    submitted: { label: "Submitted", tone: "info" },
    screening: { label: "Screening", tone: "info" },
    assigned: { label: "Assigned", tone: "info" },
    in_review: { label: "Under review", tone: "info" },
    under_review: { label: "Under review", tone: "info" },
    decision_ready: { label: "Decision ready", tone: "warning" },
    shortlisted: { label: "Shortlisted", tone: "warning" },
    waitlisted: { label: "Waitlisted", tone: "warning" },
    accepted: { label: "Accepted", tone: "success" },
    rejected: { label: "Rejected", tone: "danger" },
    withdrawn: { label: "Withdrawn", tone: "neutral" },
  },
  review: {
    assigned: { label: "Assigned", tone: "info" },
    in_progress: { label: "In progress", tone: "info" },
    submitted: { label: "Submitted", tone: "success" },
    locked: { label: "Locked", tone: "neutral" },
    reopened: { label: "Reopened", tone: "warning" },
    recused: { label: "Recused", tone: "neutral" },
    cancelled: { label: "Cancelled", tone: "neutral" },
  },
  session: {
    draft: { label: "Draft", tone: "neutral" },
    ready: { label: "Ready", tone: "success" },
    unscheduled: { label: "Unscheduled", tone: "warning" },
    scheduled: { label: "Scheduled", tone: "info" },
    published: { label: "Published", tone: "success" },
    cancelled: { label: "Cancelled", tone: "danger" },
    archived: { label: "Archived", tone: "neutral" },
  },
  schedule: {
    draft: { label: "Draft", tone: "neutral" },
    validation_failed: { label: "Validation failed", tone: "danger" },
    ready: { label: "Ready", tone: "success" },
    publishing: { label: "Publishing", tone: "info" },
    published: { label: "Published", tone: "success" },
    superseded: { label: "Superseded", tone: "neutral" },
    archived: { label: "Archived", tone: "neutral" },
    failed: { label: "Failed", tone: "danger" },
  },
  task: {
    not_started: { label: "Not started", tone: "neutral" },
    in_progress: { label: "In progress", tone: "info" },
    on_track: { label: "On track", tone: "success" },
    at_risk: { label: "At risk", tone: "warning" },
    blocked: { label: "Blocked", tone: "danger" },
    submitted: { label: "Submitted", tone: "warning" },
    completed: { label: "Complete", tone: "success" },
    complete: { label: "Complete", tone: "success" },
    waived: { label: "Waived", tone: "neutral" },
    overdue: { label: "Overdue", tone: "danger" },
  },
  communication: {
    draft: { label: "Draft", tone: "neutral" },
    scheduled: { label: "Scheduled", tone: "info" },
    queued: { label: "Queued", tone: "info" },
    queue_failed: { label: "Queue failed", tone: "danger" },
    sending: { label: "Sending", tone: "info" },
    sent: { label: "Sent", tone: "success" },
    delivering: { label: "Delivering", tone: "info" },
    delivered: { label: "Delivered", tone: "success" },
    partially_delivered: { label: "Partially delivered", tone: "warning" },
    partially_failed: { label: "Partially failed", tone: "warning" },
    failed: { label: "Failed", tone: "danger" },
    cancelled: { label: "Cancelled", tone: "neutral" },
    opened: { label: "Opened", tone: "success" },
    clicked: { label: "Clicked", tone: "success" },
    bounced: { label: "Bounced", tone: "danger" },
    suppressed: { label: "Suppressed", tone: "warning" },
  },
  integration: {
    pending: { label: "Pending", tone: "neutral" },
    queued: { label: "Queued", tone: "info" },
    running: { label: "Running", tone: "info" },
    succeeded: { label: "Succeeded", tone: "success" },
    partially_succeeded: { label: "Partially succeeded", tone: "warning" },
    partially_failed: { label: "Partially failed", tone: "warning" },
    failed: { label: "Failed", tone: "danger" },
    cancelled: { label: "Cancelled", tone: "neutral" },
    skipped: { label: "Skipped", tone: "neutral" },
  },
  operation: {
    pending: { label: "Pending", tone: "neutral" },
    queued: { label: "Queued", tone: "info" },
    queue_failed: { label: "Queue failed", tone: "danger" },
    received: { label: "Received", tone: "info" },
    running: { label: "Running", tone: "info" },
    retrying: { label: "Retrying", tone: "warning" },
    completed: { label: "Completed", tone: "success" },
    partially_failed: { label: "Partially failed", tone: "warning" },
    failed: { label: "Failed", tone: "danger" },
    cancelled: { label: "Cancelled", tone: "neutral" },
    skipped: { label: "Skipped", tone: "neutral" },
  },
  file: {
    pending: { label: "Quarantined: scan pending", tone: "warning" },
    requested: { label: "Upload requested", tone: "info" },
    uploading: { label: "Uploading", tone: "info" },
    uploaded: { label: "Uploaded; scan pending", tone: "warning" },
    clean: { label: "Scan passed", tone: "success" },
    infected: { label: "Quarantined: malware detected", tone: "danger" },
    quarantined: { label: "Quarantined", tone: "danger" },
    failed: { label: "Scan failed", tone: "danger" },
    aborted: { label: "Upload aborted", tone: "neutral" },
    deleted: { label: "Deleted", tone: "neutral" },
    active: { label: "Active", tone: "success" },
    rejected: { label: "Rejected", tone: "danger" },
  },
  content: {
    draft: { label: "Draft", tone: "neutral" },
    in_review: { label: "In review", tone: "info" },
    approved: { label: "Approved", tone: "success" },
    changes_requested: { label: "Changes requested", tone: "warning" },
    active: { label: "Active", tone: "success" },
    published: { label: "Published", tone: "success" },
    closed: { label: "Closed", tone: "neutral" },
    retired: { label: "Retired", tone: "neutral" },
    archived: { label: "Archived", tone: "neutral" },
    superseded: { label: "Superseded", tone: "neutral" },
    revoked: { label: "Revoked", tone: "danger" },
  },
} as const satisfies Record<string, Record<string, StatusPresentation>>;

export type StatusDomain = keyof typeof STATUS_PRESENTATIONS;

export function statusPresentation(domain: StatusDomain, status: string) {
  const presentation = (
    STATUS_PRESENTATIONS[domain] as Record<string, StatusPresentation>
  )[status];
  if (!presentation) {
    throw new Error(`Unsupported ${domain} status: ${status}.`);
  }
  return presentation;
}

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
