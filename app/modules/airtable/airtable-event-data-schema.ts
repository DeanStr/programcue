import { AIRTABLE_EVALUATION_TABLE_SPECS } from "./airtable-evaluation-schema";
import type { AirtableEventTableSpec } from "./airtable-event-data-schema-shared";
import { AIRTABLE_EVENT_SETUP_TABLE_SPECS } from "./airtable-event-setup-schema";
import { AIRTABLE_FORM_TABLE_SPECS } from "./airtable-form-schema";
import { AIRTABLE_SESSION_TABLE_SPECS } from "./airtable-session-schema";
import { AIRTABLE_SUBMISSION_TABLE_SPECS } from "./airtable-submission-schema";
import { AIRTABLE_TASK_TABLE_SPECS } from "./airtable-task-schema";

export type {
  AirtableEventDataDomain,
  AirtableEventTableSpec,
} from "./airtable-event-data-schema-shared";

export const AIRTABLE_EVENT_TABLE_SPECS: readonly AirtableEventTableSpec[] = [
  ...AIRTABLE_EVENT_SETUP_TABLE_SPECS,
  ...AIRTABLE_FORM_TABLE_SPECS,
  ...AIRTABLE_SUBMISSION_TABLE_SPECS,
  ...AIRTABLE_EVALUATION_TABLE_SPECS,
  ...AIRTABLE_SESSION_TABLE_SPECS,
  ...AIRTABLE_TASK_TABLE_SPECS,
];

export const AIRTABLE_EVENT_DATA_DOMAINS = [
  "event_setup",
  "forms",
  "submissions",
  "evaluations",
  "sessions",
  "tasks",
] as const;
