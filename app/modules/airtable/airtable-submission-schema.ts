import { z } from "zod";
import type { AirtableEventTableSpec } from "./airtable-event-data-schema-shared";
import {
  booleanInteger,
  eventRecord,
  id,
  integer,
  jsonText,
  nullableInteger,
  nullableJsonText,
  nullableText,
  revision,
  text,
  timestamps,
} from "./airtable-event-data-schema-shared";

export const AIRTABLE_SUBMISSION_TABLE_SPECS: readonly AirtableEventTableSpec[] =
  [
    {
      key: "submissions",
      domain: "submissions",
      entityType: "submission",
      query: `SELECT id, event_id, form_version_id, submitter_person_id,
                   submitter_email, public_reference, title, category, format,
                   status, answers_json,
                   submitted_snapshot_json, revision, submitted_at,
                   withdrawn_at, created_at, updated_at
              FROM submissions WHERE event_id = ? ORDER BY id`,
      schema: z
        .object({
          ...eventRecord,
          form_version_id: nullableText,
          submitter_person_id: nullableText,
          submitter_email: nullableText,
          public_reference: text.min(1),
          title: text,
          category: nullableText,
          format: nullableText,
          status: z.enum([
            "draft",
            "submitted",
            "assigned",
            "in_review",
            "decision_ready",
            "accepted",
            "waitlisted",
            "rejected",
            "withdrawn",
          ]),
          answers_json: jsonText,
          submitted_snapshot_json: nullableJsonText,
          revision: integer.positive(),
          submitted_at: nullableInteger,
          withdrawn_at: nullableInteger,
          ...timestamps,
        })
        .strict(),
      entityId: id,
      revision,
    },
    {
      key: "submissionTrackSelections",
      domain: "submissions",
      entityType: "submission_track_selection",
      query: `SELECT submission_id || ':' || track_id AS id, event_id,
                   submission_id, track_id, track_name_snapshot, position
              FROM submission_track_selections WHERE event_id = ?
             ORDER BY submission_id, position`,
      schema: z
        .object({
          ...eventRecord,
          submission_id: text.min(1),
          track_id: text.min(1),
          track_name_snapshot: text.min(1),
          position: integer.nonnegative(),
        })
        .strict(),
      entityId: id,
      revision: () => 1,
    },
    {
      key: "submissionRoutingTeams",
      domain: "submissions",
      entityType: "submission_routing_team",
      query: `SELECT submission_id || ':' || team_id AS id, event_id,
                   submission_id, team_id
              FROM submission_routing_teams WHERE event_id = ?
             ORDER BY submission_id, team_id`,
      schema: z
        .object({
          ...eventRecord,
          submission_id: text.min(1),
          team_id: text.min(1),
        })
        .strict(),
      entityId: id,
      revision: () => 1,
    },
    {
      key: "submissionSpeakers",
      domain: "submissions",
      entityType: "submission_speaker",
      query: `SELECT id, event_id, submission_id, person_id, email,
                   display_name, role_label, position, invitation_status,
                   is_primary, invitation_expires_at, invited_at, claimed_at,
                   created_at, updated_at
              FROM submission_speakers WHERE event_id = ? ORDER BY id`,
      schema: z
        .object({
          ...eventRecord,
          submission_id: text.min(1),
          person_id: nullableText,
          email: text.min(1),
          display_name: text.min(1),
          role_label: nullableText,
          position: integer.nonnegative(),
          invitation_status: z.enum([
            "pending",
            "sent",
            "claimed",
            "declined",
            "expired",
            "revoked",
          ]),
          is_primary: booleanInteger,
          invitation_expires_at: nullableInteger,
          invited_at: nullableInteger,
          claimed_at: nullableInteger,
          ...timestamps,
        })
        .strict(),
      entityId: id,
      revision: () => 1,
    },
    {
      key: "submissionRevisions",
      domain: "submissions",
      entityType: "submission_revision",
      query: `SELECT id, event_id, submission_id, form_version_id,
                   revision_number, answers_json, speaker_snapshot_json,
                   save_kind, saved_by_person_id, created_at
              FROM submission_revisions WHERE event_id = ? ORDER BY id`,
      schema: z
        .object({
          ...eventRecord,
          submission_id: text.min(1),
          form_version_id: text.min(1),
          revision_number: integer.positive(),
          answers_json: jsonText,
          speaker_snapshot_json: jsonText,
          save_kind: z.enum(["autosave", "manual", "submitted", "withdrawn"]),
          saved_by_person_id: nullableText,
          created_at: integer,
        })
        .strict(),
      entityId: id,
      revision: (row) => Number(row.revision_number),
    },
  ] as const;
