import { z } from "zod";
import type { AirtableEventTableSpec } from "./airtable-event-data-schema-shared";
import {
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

export const AIRTABLE_SESSION_TABLE_SPECS: readonly AirtableEventTableSpec[] = [
  {
    key: "sourceSessions",
    domain: "sessions",
    entityType: "session",
    query: `SELECT id, event_id, source_submission_id, track_id, title, slug,
                   description, format, duration_minutes, expected_attendance,
                   required_resources_json, status, visibility, revision,
                   created_at, updated_at
              FROM sessions WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        source_submission_id: nullableText,
        track_id: nullableText,
        title: text.min(1),
        slug: text.min(1),
        description: nullableText,
        format: text.min(1),
        duration_minutes: integer.positive(),
        expected_attendance: nullableInteger,
        required_resources_json: jsonText,
        status: z.enum([
          "unscheduled",
          "scheduled",
          "published",
          "cancelled",
          "archived",
        ]),
        visibility: z.enum(["public", "private", "hidden"]),
        revision: integer.positive(),
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "sessionSpeakers",
    domain: "sessions",
    entityType: "session_speaker",
    query: `SELECT session_id, event_id, person_id, position, role_label,
                   participation_status, participation_revision,
                   participation_confirmed_at, participation_declined_at,
                   participation_decline_reason, visibility
              FROM session_speakers WHERE event_id = ?
             ORDER BY session_id, person_id`,
    schema: z
      .object({
        session_id: text.min(1),
        event_id: text.min(1),
        person_id: text.min(1),
        position: integer.nonnegative(),
        role_label: nullableText,
        participation_status: z.enum(["pending", "confirmed", "declined"]),
        participation_revision: integer.positive(),
        participation_confirmed_at: nullableInteger,
        participation_declined_at: nullableInteger,
        participation_decline_reason: nullableText,
        visibility: z.enum(["public", "private", "hidden"]),
      })
      .strict(),
    entityId: (row) => `${String(row.session_id)}:${String(row.person_id)}`,
    revision: (row) => Number(row.participation_revision),
  },
  {
    key: "programmePeople",
    domain: "sessions",
    entityType: "programme_person",
    query: `SELECT person.id, speaker.event_id, person.display_name,
                   person.image_url, person.biography, person.pronunciation,
                   person.organisation_name, person.job_title,
                   person.profile_status, person.profile_revision
              FROM people person
              JOIN (
                SELECT DISTINCT event_id, person_id FROM session_speakers
                 WHERE event_id = ?
              ) speaker ON speaker.person_id = person.id
             ORDER BY person.id`,
    schema: z
      .object({
        ...eventRecord,
        display_name: text.min(1),
        image_url: nullableText,
        biography: nullableText,
        pronunciation: nullableText,
        organisation_name: nullableText,
        job_title: nullableText,
        profile_status: z.enum(["draft", "published", "archived"]),
        profile_revision: integer.positive(),
      })
      .strict(),
    entityId: id,
    revision: (row) => Number(row.profile_revision),
  },
  {
    key: "scheduleVersions",
    domain: "sessions",
    entityType: "schedule_version",
    query: `SELECT id, event_id, version_number, name, notes, status, revision,
                   created_by_person_id, created_at, published_at
              FROM schedule_versions WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        version_number: integer.positive(),
        name: nullableText,
        notes: text,
        status: z.enum([
          "draft",
          "publishing",
          "published",
          "archived",
          "failed",
        ]),
        revision: integer.positive(),
        created_by_person_id: nullableText,
        created_at: integer,
        published_at: nullableInteger,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "scheduleSessionContents",
    domain: "sessions",
    entityType: "schedule_session_content",
    query: `SELECT schedule_version_id, event_id, session_id, title, slug,
                   description, track_id, format, duration_minutes,
                   required_resources_json, visibility, content_status,
                   content_revision, last_edited_by_person_id,
                   approved_by_person_id, approved_at, approval_source,
                   created_at, updated_at
              FROM schedule_session_contents
             WHERE event_id = ?
             ORDER BY schedule_version_id, session_id`,
    schema: z
      .object({
        schedule_version_id: text.min(1),
        event_id: text.min(1),
        session_id: text.min(1),
        title: text.min(1),
        slug: text.min(1),
        description: nullableText,
        track_id: nullableText,
        format: text.min(1),
        duration_minutes: integer.positive(),
        required_resources_json: jsonText,
        visibility: z.enum(["public", "private", "hidden"]),
        content_status: z.enum([
          "draft",
          "in_review",
          "approved",
          "changes_requested",
        ]),
        content_revision: integer.positive(),
        last_edited_by_person_id: nullableText,
        approved_by_person_id: nullableText,
        approved_at: nullableInteger,
        approval_source: z.enum(["editorial", "legacy_publication"]).nullable(),
        ...timestamps,
      })
      .strict(),
    entityId: (row) =>
      `${String(row.schedule_version_id)}:${String(row.session_id)}`,
    revision: (row) => Number(row.content_revision),
  },
  {
    key: "scheduleEntries",
    domain: "sessions",
    entityType: "schedule_entry",
    query: `SELECT id, event_id, schedule_version_id, session_id, room_id,
                   starts_at, ends_at, revision, created_at, updated_at
              FROM schedule_entries WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        schedule_version_id: text.min(1),
        session_id: text.min(1),
        room_id: text.min(1),
        starts_at: integer,
        ends_at: integer,
        revision: integer.positive(),
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "schedulePolicies",
    domain: "sessions",
    entityType: "schedule_policy",
    query: `SELECT event_id, event_id AS id, room_overlap_action,
                   speaker_overlap_action, required_resource_overlap_action,
                   exclusive_track_overlap_action, event_boundary_action,
                   capacity_action, speaker_unavailable_action,
                   minimum_turnaround_minutes, revision,
                   updated_at
              FROM schedule_policies WHERE event_id = ?`,
    schema: z
      .object({
        ...eventRecord,
        room_overlap_action: z.enum(["allow", "warn", "block"]),
        speaker_overlap_action: z.enum(["allow", "warn", "block"]),
        required_resource_overlap_action: z.enum(["allow", "warn", "block"]),
        exclusive_track_overlap_action: z.enum(["allow", "warn", "block"]),
        event_boundary_action: z.enum(["allow", "warn", "block"]),
        capacity_action: z.enum(["allow", "warn", "block"]),
        speaker_unavailable_action: z.enum(["warn", "block"]).default("block"),
        minimum_turnaround_minutes: integer.nonnegative(),
        revision: integer.positive(),
        updated_at: integer,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "scheduleConflicts",
    domain: "sessions",
    entityType: "schedule_conflict",
    query: `SELECT id, event_id, schedule_version_id, conflict_type, severity,
                   fingerprint, primary_entry_id, conflicting_entry_id,
                   details_json, created_at, resolved_by_person_id,
                   resolved_at, resolution_json
              FROM schedule_conflicts WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        schedule_version_id: text.min(1),
        conflict_type: z.enum([
          "room",
          "speaker",
          "track",
          "event_boundary",
          "capacity",
          "required_resource",
          "resource_configuration",
          "room_resource",
          "turnaround",
          "speaker_unavailable",
        ]),
        severity: z.enum(["warning", "blocking"]),
        fingerprint: text.min(1),
        primary_entry_id: nullableText,
        conflicting_entry_id: nullableText,
        details_json: jsonText,
        created_at: integer,
        resolved_by_person_id: nullableText,
        resolved_at: nullableInteger,
        resolution_json: nullableJsonText,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
] as const;
