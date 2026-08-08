export type Role =
  | "organisation_owner"
  | "event_admin"
  | "committee_chair"
  | "evaluator"
  | "submitter"
  | "speaker"
  | "public";

export type SemanticStatus =
  | "draft"
  | "in_review"
  | "scheduled"
  | "published"
  | "complete"
  | "on_track"
  | "at_risk"
  | "overdue"
  | "not_started"
  | "running"
  | "failed"
  | "pending";

export type SessionFormat = "Keynote" | "Presentation" | "Panel" | "Workshop" | "Breakout" | "Other";

export interface EventSummary {
  id: string;
  slug: string;
  name: string;
  startDate: string;
  endDate: string;
  venue: string;
  city: string;
  timezone: string;
  status: "draft" | "live" | "archived";
  provider: "d1" | "airtable";
}

export interface Person {
  id: string;
  name: string;
  title: string;
  organisation: string;
  initials: string;
  avatar?: string;
  biography?: string;
}

export interface Submission {
  id: string;
  title: string;
  abstract: string;
  category: string;
  track: string;
  format: SessionFormat;
  status: "submitted" | "under_review" | "shortlisted" | "accepted" | "rejected";
  submittedAt: string;
  speakers: Person[];
  tags: string[];
  attachments: { name: string; size: string; type: string }[];
  reviewProgress: { submitted: number; required: number };
  dueDate: string;
}

export interface ReviewCriterion {
  id: string;
  label: string;
  weight: number;
  rating: number;
}

export interface ReviewDraft {
  submissionId: string;
  conflict: "none" | "declared" | null;
  criteria: ReviewCriterion[];
  recommendation: "accept" | "minor_changes" | "conditional" | "decline" | null;
  confidence: number;
  submitterFeedback: string;
  privateNotes: string;
  updatedAt: string;
}

export interface ScheduleSession {
  id: string;
  title: string;
  speakerIds: string[];
  speakerNames: string[];
  format: SessionFormat;
  track: string;
  roomId: string | null;
  start: string | null;
  end: string | null;
  capacity: number;
  estimatedAttendance: number;
  status: "unscheduled" | "scheduled" | "published";
}

export interface Room {
  id: string;
  name: string;
  capacity: number;
  building?: string;
  level?: string;
}

export interface ScheduleConflict {
  id: string;
  type: "speaker" | "room" | "resource";
  severity: "warning" | "blocker";
  sessionIds: [string, string];
  personName?: string;
  start: string;
  end: string;
  recommendedMove: {
    sessionId: string;
    roomId: string;
    start: string;
    end: string;
    reasons: string[];
  };
}

export interface TaskItem {
  id: string;
  subjectType: "speaker" | "session";
  subject: string;
  subjectMeta: string;
  task: string;
  description: string;
  owner: string;
  dueDate: string | null;
  status: "on_track" | "at_risk" | "overdue" | "not_started" | "in_progress" | "complete";
  impact: "critical" | "high" | "medium" | "low";
  readiness: number;
  evidence?: string;
  waiver?: boolean;
}

export interface CommunicationDraft {
  id: string;
  name: string;
  subject: string;
  preheader: string;
  emailBody: string;
  smsBody: string;
  pushTitle: string;
  pushBody: string;
  calendarTitle: string;
  recipients: number;
  suppressed: number;
  invalid: number;
  scheduledAt: string;
  channels: Array<"email" | "sms" | "push" | "calendar">;
}

export interface Integration {
  id: string;
  name: string;
  kind: "airtable" | "accelevents" | "google_calendar" | "resend" | "webhook";
  optional?: boolean;
  connected: boolean;
  syncDirection: string;
  scope: string[];
  mappings: string[];
  conflictPolicy: string;
  status: "healthy" | "attention" | "failed";
  lastActivity: string;
  activitySummary: string;
}

export interface BackgroundOperation {
  id: string;
  name: string;
  status: "queued" | "running" | "complete" | "failed";
  progress: number;
  startedAt: string;
  duration?: string;
}

export interface ProgrammeSession {
  id: string;
  title: string;
  date: string;
  start: string;
  end: string;
  room: string;
  venue: string;
  building?: string;
  level?: string;
  track: string;
  format: SessionFormat;
  speakers: Person[];
  description: string;
  tags: string[];
  saved: boolean;
}

export interface FormFieldDefinition {
  id: string;
  type: "content" | "short_text" | "long_text" | "single_select" | "multi_select" | "file";
  label: string;
  description: string;
  placeholder?: string;
  required: boolean;
  options?: string[];
  maxLength?: number;
  condition?: { fieldId: string; operator: "equals" | "includes"; value: string };
}

export interface DemoState {
  event: EventSummary;
  role: Role;
  commandPaletteOpen: boolean;
  submissions: Submission[];
  reviewDrafts: Record<string, ReviewDraft>;
  rooms: Room[];
  scheduleSessions: ScheduleSession[];
  scheduleConflicts: ScheduleConflict[];
  proposedScheduleChanges: Array<{
    id: string;
    sessionId: string;
    from: { roomId: string | null; start: string | null; end: string | null };
    to: { roomId: string; start: string; end: string };
    status: "pending" | "published";
  }>;
  tasks: TaskItem[];
  communication: CommunicationDraft;
  integrations: Integration[];
  operations: BackgroundOperation[];
  programme: ProgrammeSession[];
  formFields: FormFieldDefinition[];
  selectedFormFieldId: string;
  speakerFiles: Array<{ id: string; name: string; kind: string; status: "complete" | "in_progress" | "optional" }>;
}
