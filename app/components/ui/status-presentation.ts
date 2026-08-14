/**
 * How every stored status is worded on screen, in one table.
 *
 * Plain data rather than part of the badge component: server code, the copy
 * lint and non-badge surfaces all need this vocabulary, and none of them should
 * pull in React to read it. `statusPresentation` throws on an unmapped value so
 * a new status fails loudly in tests instead of quietly rendering its stored
 * spelling to the reader.
 */
export type StatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "ai";

export type StatusPresentation = {
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
  crm: {
    identified: { label: "Identified", tone: "neutral" },
    contacted: { label: "Contacted", tone: "info" },
    interested: { label: "Interested", tone: "warning" },
    confirmed: { label: "Confirmed", tone: "success" },
    declined: { label: "Declined", tone: "neutral" },
  },
  integrationConnection: {
    connected: { label: "Connected", tone: "success" },
    needs_attention: { label: "Needs attention", tone: "warning" },
    failed: { label: "Failed", tone: "danger" },
    disconnected: { label: "Disconnected", tone: "neutral" },
  },
  integrationChange: {
    create: { label: "Create", tone: "warning" },
    update: { label: "Update", tone: "warning" },
    noop: { label: "Unchanged", tone: "info" },
  },
  webhookEndpoint: {
    active: { label: "Active", tone: "success" },
    disabled: { label: "Disabled", tone: "neutral" },
    failing: { label: "Failing", tone: "danger" },
  },
  webhookDelivery: {
    queued: { label: "Queued", tone: "info" },
    delivering: { label: "Delivering", tone: "info" },
    delivered: { label: "Delivered", tone: "success" },
    failed: { label: "Failed", tone: "danger" },
    cancelled: { label: "Cancelled", tone: "neutral" },
  },
  calendarInvitation: {
    pending: { label: "Pending", tone: "neutral" },
    queued: { label: "Queued", tone: "info" },
    sent: { label: "Sent", tone: "success" },
    confirmed: { label: "Confirmed", tone: "success" },
    cancelled: { label: "Cancelled", tone: "neutral" },
    failed: { label: "Failed", tone: "danger" },
  },
  // Covers every versioned record: forms, schedules, resource pages, email
  // templates and session content. Their tables allow `retired`, `revoked` and
  // `superseded` for the previous version, so publishing a new one renders all
  // three.
  version: {
    draft: { label: "Draft", tone: "info" },
    published: { label: "Published", tone: "success" },
    superseded: { label: "Superseded", tone: "neutral" },
    retired: { label: "Retired", tone: "neutral" },
    revoked: { label: "Revoked", tone: "danger" },
    archived: { label: "Archived", tone: "neutral" },
    validation_failed: { label: "Validation failed", tone: "danger" },
    publishing: { label: "Publishing", tone: "info" },
    ready: { label: "Ready", tone: "success" },
    failed: { label: "Failed", tone: "danger" },
    in_review: { label: "In review", tone: "info" },
    approved: { label: "Approved", tone: "success" },
    changes_requested: { label: "Changes requested", tone: "warning" },
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
