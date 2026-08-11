import {
  formSchemaSchema,
  routingSchema,
  type FormRouting,
  type SaveFormInput,
  type SubmissionFormSchema,
  type UploadReference,
} from "./submission-schema";
import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";
import {
  parseEventFilePolicy,
  type EventFilePolicy,
} from "~/modules/files/file-policy";

export type FormSummary = {
  id: string;
  revision: number;
  eventId: string;
  eventName: string;
  eventSlug: string;
  eventTimezone: string;
  brandAccent: string;
  filePolicy: EventFilePolicy;
  name: string;
  kind: "submission" | "direct_session";
  status: "draft" | "published" | "closed" | "archived";
  publicSlug: string;
  closesAt: number | null;
  submissionLimit: number | null;
  minSpeakers: number;
  maxSpeakers: number | null;
  accessMode: "email_verified" | "account_required" | "password_protected";
  accessPasswordHash: string | null;
  allowAnonymousDrafts: boolean;
  submittedCount: number;
};

export type FormVersion = {
  id: string;
  revision: number;
  versionNumber: number;
  status: "draft" | "published" | "retired";
  publishedAt: number | null;
  schema: SubmissionFormSchema;
  routing: FormRouting;
  settings: {
    name?: string;
    kind?: FormSummary["kind"];
    publicSlug?: string;
    closesAt?: number | null;
    submissionLimit?: number | null;
    minSpeakers?: number;
    maxSpeakers?: number | null;
    accessMode?: FormSummary["accessMode"];
  };
};

export type FormWorkspace = FormSummary & {
  draftVersion: FormVersion;
  publishedVersion: FormVersion | null;
  versions: Array<
    Pick<FormVersion, "id" | "versionNumber" | "status" | "publishedAt">
  >;
};

export type Applicant =
  | {
      personId: string;
      email: string;
      name: string;
      verified: true;
      anonymousDraftId: null;
      biography: string;
      profileRevision: number;
      /** A co-speaker claim session may edit its speaker profile but cannot manage applications. */
      claimOnly?: boolean;
    }
  | {
      personId: null;
      email: "";
      name: "";
      verified: false;
      anonymousDraftId: string;
      biography: "";
      profileRevision: 0;
      claimOnly?: boolean;
    };

export type ApplicantDraft = {
  id: string;
  title: string;
  category: string;
  format: string;
  status: string;
  answers: Record<string, string | string[]>;
  revision: number;
  formVersionId: string;
  versionNumber: number;
  submittedAt: number | null;
  uploads: Record<string, UploadReference>;
  speakers: Array<{
    personId: string | null;
    name: string;
    email: string;
    biography: string;
    position: number;
    isPrimary: boolean;
    invitationStatus: string;
  }>;
};

export type CoSpeakerInvitation = {
  id: string;
  submissionId: string;
  submissionTitle: string;
  displayName: string;
  status: string;
};

export type AdminSubmission = {
  id: string;
  publicReference: string;
  title: string;
  category: string;
  format: string;
  status: string;
  submitterName: string;
  submitterEmail: string;
  speakerCount: number;
  versionNumber: number | null;
  submittedAt: number | null;
  updatedAt: number;
  routedTo: string;
  routedTeamId: string | null;
  routedTeamIds: string[];
};

export function parseJson<T>(
  value: string,
  parser: { parse(input: unknown): T },
): T {
  return parser.parse(JSON.parse(value));
}

export function closeDateFromEpoch(value: number | null, timezone: string) {
  if (value === null) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(value * 1_000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function closeDateToEpoch(value: string | null, timezone: string) {
  if (value === null) return null;
  const endMarker = Math.floor(Date.parse(`${value}T23:59:59Z`) / 1_000);
  return eventLocalTimeEpoch(endMarker + 1, timezone, 0) - 1;
}

export function settingsSnapshot(input: SaveFormInput, timezone: string) {
  return {
    name: input.name,
    kind: input.kind,
    publicSlug: input.publicSlug,
    closesAt: closeDateToEpoch(input.closeDate, timezone),
    submissionLimit: input.submissionLimit,
    minSpeakers: input.minSpeakers,
    maxSpeakers: input.maxSpeakers,
    accessMode: input.accessMode,
  };
}

export type FormRow = {
  id: string;
  revision: number;
  eventId: string;
  eventName: string;
  eventSlug: string;
  eventTimezone: string;
  brandAccent: string;
  filePolicyJson: string;
  name: string;
  kind: FormSummary["kind"];
  status: FormSummary["status"];
  publicSlug: string;
  closesAt: number | null;
  submissionLimit: number | null;
  minSpeakers: number;
  maxSpeakers: number | null;
  accessMode: FormSummary["accessMode"];
  accessPasswordHash: string | null;
  allowAnonymousDrafts: number;
  submittedCount: number;
};

export type VersionRow = {
  id: string;
  revision: number;
  versionNumber: number;
  schemaJson: string;
  routingJson: string;
  settingsSnapshotJson: string;
  status: FormVersion["status"];
  publishedAt: number | null;
};

export function mapForm(row: FormRow): FormSummary {
  return {
    id: row.id,
    revision: row.revision,
    eventId: row.eventId,
    eventName: row.eventName,
    eventSlug: row.eventSlug,
    eventTimezone: row.eventTimezone,
    brandAccent: row.brandAccent,
    filePolicy: parseEventFilePolicy(row.filePolicyJson),
    name: row.name,
    kind: row.kind,
    status: row.status,
    publicSlug: row.publicSlug,
    closesAt: row.closesAt,
    submissionLimit: row.submissionLimit,
    minSpeakers: row.minSpeakers,
    maxSpeakers: row.maxSpeakers,
    accessMode: row.accessMode,
    accessPasswordHash: row.accessPasswordHash,
    allowAnonymousDrafts: Boolean(row.allowAnonymousDrafts),
    submittedCount: Number(row.submittedCount),
  };
}

export function mapVersion(row: VersionRow): FormVersion {
  return {
    id: row.id,
    revision: row.revision,
    versionNumber: row.versionNumber,
    status: row.status,
    publishedAt: row.publishedAt,
    schema: parseJson(row.schemaJson, formSchemaSchema),
    routing: parseJson(row.routingJson, routingSchema),
    settings: JSON.parse(row.settingsSnapshotJson) as FormVersion["settings"],
  };
}

export class SubmissionRevisionConflictError extends Error {
  constructor() {
    super(
      "This draft changed after the page loaded. Refresh before saving again.",
    );
    this.name = "SubmissionRevisionConflictError";
  }
}

export class SubmissionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionStateError";
  }
}

export class SubmissionDraftSavedError extends SubmissionStateError {
  constructor(
    message: string,
    readonly submissionId: string,
    readonly draftRevision: number,
  ) {
    super(message);
    this.name = "SubmissionDraftSavedError";
  }
}
