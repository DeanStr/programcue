import { z } from "zod";

import type { AirtableEventDataTableKey } from "./airtable-schema";

const text = z.string();
const nullableText = z.string().nullable();
const integer = z.number().int();
const nullableInteger = z.number().int().nullable();
const booleanInteger = z.union([z.literal(0), z.literal(1)]);
const jsonText = z.string().refine((value) => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}, "must contain valid JSON");
const jsonArrayText = jsonText.refine((value) => {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}, "must contain a JSON array");
const nullableJsonText = z
  .string()
  .nullable()
  .refine((value) => value === null || jsonText.safeParse(value).success, {
    message: "must be null or valid JSON",
  });

const eventRecord = { id: text.min(1), event_id: text.min(1) } as const;
const timestamps = { created_at: integer, updated_at: integer } as const;

export type AirtableEventDataDomain =
  | "event_setup"
  | "forms"
  | "submissions"
  | "evaluations"
  | "sessions"
  | "tasks";

export type AirtableEventTableSpec = {
  key: AirtableEventDataTableKey;
  domain: AirtableEventDataDomain;
  entityType: string;
  query: string;
  schema: z.ZodType<Record<string, unknown>>;
  entityId: (row: Record<string, unknown>) => string;
  revision: (row: Record<string, unknown>) => number;
};

function id(value: Record<string, unknown>) {
  return String(value.id);
}

function revision(value: Record<string, unknown>) {
  return typeof value.revision === "number" ? value.revision : 1;
}

export const AIRTABLE_EVENT_TABLE_SPECS: readonly AirtableEventTableSpec[] = [
  {
    key: "eventConfiguration",
    domain: "event_setup",
    entityType: "event_configuration",
    query: `SELECT id, id AS event_id, name, slug, timezone, starts_at,
                   ends_at, venue_name, city, description, brand_accent,
                   participant_logo_url, participant_welcome_text,
                   participant_support_url,
                   session_formats_json, file_policy_json,
                   submission_access_mode,
                   allow_anonymous_drafts, duplicate_person_warnings
              FROM events WHERE id = ?`,
    schema: z
      .object({
        ...eventRecord,
        name: text.min(1),
        slug: text.min(1),
        timezone: text.min(1),
        starts_at: integer,
        ends_at: integer,
        venue_name: nullableText,
        city: nullableText,
        description: nullableText,
        brand_accent: text.regex(/^#[0-9a-fA-F]{6}$/),
        participant_logo_url: nullableText,
        participant_welcome_text: nullableText,
        participant_support_url: nullableText,
        session_formats_json: jsonText,
        file_policy_json: jsonText,
        submission_access_mode: z.enum([
          "email_verified",
          "account_required",
          "password_protected",
        ]),
        allow_anonymous_drafts: booleanInteger,
        duplicate_person_warnings: booleanInteger,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
  {
    key: "tracks",
    domain: "event_setup",
    entityType: "track",
    query: `SELECT id, event_id, name, slug, colour_token, position,
                   exclusive, is_public
              FROM tracks WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        name: text.min(1),
        slug: text.min(1),
        colour_token: nullableText,
        position: integer.nonnegative(),
        exclusive: booleanInteger,
        is_public: booleanInteger,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
  {
    key: "forms",
    domain: "forms",
    entityType: "form_definition",
    query: `SELECT id, event_id, name, description, kind, status, public_slug,
                   closes_at, submission_limit, min_speakers, max_speakers,
                   access_mode, confirmation_template_id, revision,
                   created_by_person_id, archived_at, created_at, updated_at
              FROM form_definitions WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        name: text.min(1),
        description: nullableText,
        kind: z.enum(["submission", "direct_session"]),
        status: z.enum(["draft", "published", "closed", "archived"]),
        public_slug: text.min(1),
        closes_at: nullableInteger,
        submission_limit: nullableInteger,
        min_speakers: integer,
        max_speakers: nullableInteger,
        access_mode: z.enum([
          "email_verified",
          "account_required",
          "password_protected",
        ]),
        confirmation_template_id: nullableText,
        revision: integer.positive(),
        created_by_person_id: nullableText,
        archived_at: nullableInteger,
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "formVersions",
    domain: "forms",
    entityType: "form_version",
    query: `SELECT id, event_id, form_id, version_number, schema_json,
                   routing_json, settings_snapshot_json, status, revision,
                   published_at, retired_at, created_by_person_id,
                   created_at, updated_at
              FROM form_versions WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        form_id: text.min(1),
        version_number: integer.positive(),
        schema_json: jsonText,
        routing_json: jsonText,
        settings_snapshot_json: jsonText,
        status: z.enum(["draft", "published", "retired"]),
        revision: integer.positive(),
        published_at: nullableInteger,
        retired_at: nullableInteger,
        created_by_person_id: nullableText,
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
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
  {
    key: "evaluationPlans",
    domain: "evaluations",
    entityType: "evaluation_plan",
    query: `SELECT id, event_id, name, status, blinded_reviewing,
                   decision_role, revision, created_by_person_id,
                   created_at, updated_at
              FROM evaluation_plans WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        name: text.min(1),
        status: z.enum(["draft", "active", "closed", "archived"]),
        blinded_reviewing: booleanInteger,
        decision_role: z.enum(["administrator", "committee_chair"]),
        revision: integer.positive(),
        created_by_person_id: nullableText,
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "evaluationTeams",
    domain: "evaluations",
    entityType: "evaluation_team",
    query: `SELECT id, event_id, name, description, chair_person_id, status,
                   created_at, updated_at
              FROM evaluation_teams WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        name: text.min(1),
        description: nullableText,
        chair_person_id: nullableText,
        status: z.enum(["active", "archived"]),
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
  {
    key: "evaluationTeamMembers",
    domain: "evaluations",
    entityType: "evaluation_team_member",
    query: `SELECT team_id, event_id, person_id, role, joined_at, removed_at
              FROM evaluation_team_members WHERE event_id = ?
             ORDER BY team_id, person_id`,
    schema: z
      .object({
        team_id: text.min(1),
        event_id: text.min(1),
        person_id: text.min(1),
        role: z.enum(["chair", "evaluator"]),
        joined_at: integer,
        removed_at: nullableInteger,
      })
      .strict(),
    entityId: (row) => `${String(row.team_id)}:${String(row.person_id)}`,
    revision: () => 1,
  },
  {
    key: "evaluationRounds",
    domain: "evaluations",
    entityType: "evaluation_round",
    query: `SELECT id, event_id, plan_id, round_number, name, status,
                   opens_at, closes_at, blinded_reviewing, scorecard_id,
                   scorecard_version, advancement_rule_json, revision,
                   created_at, updated_at
              FROM evaluation_rounds WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        plan_id: text.min(1),
        round_number: integer.positive(),
        name: text.min(1),
        status: z.enum(["draft", "active", "closed", "archived"]),
        opens_at: nullableInteger,
        closes_at: nullableInteger,
        blinded_reviewing: booleanInteger,
        scorecard_id: text.min(1),
        scorecard_version: integer.positive(),
        advancement_rule_json: jsonText,
        revision: integer.positive(),
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "evaluationRoundReviewers",
    domain: "evaluations",
    entityType: "evaluation_round_reviewer",
    query: `SELECT id, event_id, round_id, person_id, added_by_person_id,
                   revision, created_at, updated_at
              FROM evaluation_round_reviewers WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        round_id: text.min(1),
        person_id: text.min(1),
        added_by_person_id: nullableText,
        revision: integer.positive(),
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "evaluationCriteria",
    domain: "evaluations",
    entityType: "evaluation_criterion",
    query: `SELECT id, event_id, round_id, name, description, input_type,
                   options_json, weight_percent, required, position
              FROM evaluation_criteria WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        round_id: text.min(1),
        name: text.min(1),
        description: nullableText,
        input_type: z.enum([
          "scale_5",
          "scale_10",
          "yes_no",
          "free_text",
          "dropdown",
        ]),
        options_json: jsonArrayText,
        weight_percent: integer.min(0).max(100),
        required: booleanInteger,
        position: integer.nonnegative(),
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
  {
    key: "evaluatorAssignments",
    domain: "evaluations",
    entityType: "evaluator_assignment",
    query: `SELECT id, event_id, round_id, submission_id, session_id,
                   session_snapshot_json, evaluator_person_id, team_id, status,
                   revision, due_at, conflict_declared_at, cancellation_reason,
                   assigned_at, submitted_at
              FROM evaluator_assignments WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        round_id: text.min(1),
        submission_id: nullableText,
        session_id: nullableText,
        session_snapshot_json: nullableJsonText,
        evaluator_person_id: text.min(1),
        team_id: nullableText,
        status: z.enum([
          "assigned",
          "in_progress",
          "submitted",
          "recused",
          "reopened",
          "cancelled",
        ]),
        revision: integer.positive(),
        due_at: nullableInteger,
        conflict_declared_at: nullableInteger,
        cancellation_reason: z
          .enum([
            "reviewer_removed",
            "submission_withdrawn",
            "decision_published",
          ])
          .nullable(),
        assigned_at: integer,
        submitted_at: nullableInteger,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "evaluatorConflicts",
    domain: "evaluations",
    entityType: "evaluator_conflict",
    query: `SELECT id, event_id, round_id, submission_id, session_id,
                   evaluator_person_id, relationship, notes, status,
                   declared_at, resolved_by_person_id, resolved_at
              FROM evaluator_conflicts WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        round_id: text.min(1),
        submission_id: nullableText,
        session_id: nullableText,
        evaluator_person_id: text.min(1),
        relationship: nullableText,
        notes: nullableText,
        status: z.enum(["declared", "recused", "waived", "dismissed"]),
        declared_at: integer,
        resolved_by_person_id: nullableText,
        resolved_at: nullableInteger,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
  {
    key: "reviews",
    domain: "evaluations",
    entityType: "review",
    query: `SELECT id, event_id, assignment_id, status, scores_json,
                   weighted_score, recommendation, confidence,
                   submitter_feedback, private_notes, revision, created_at,
                   updated_at, submitted_at, locked_at
              FROM reviews WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        assignment_id: text.min(1),
        status: z.enum(["draft", "submitted", "locked", "reopened"]),
        scores_json: jsonText,
        weighted_score: z.number().nullable(),
        recommendation: z
          .enum([
            "accept",
            "minor_changes",
            "conditional_accept",
            "waitlist",
            "reject",
          ])
          .nullable(),
        confidence: nullableInteger,
        submitter_feedback: nullableText,
        private_notes: nullableText,
        revision: integer.positive(),
        ...timestamps,
        submitted_at: nullableInteger,
        locked_at: nullableInteger,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "reviewRevisions",
    domain: "evaluations",
    entityType: "review_revision",
    query: `SELECT id, event_id, review_id, revision_number, scores_json,
                   content_json, save_kind, saved_by_person_id, created_at
              FROM review_revisions WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        review_id: text.min(1),
        revision_number: integer.positive(),
        scores_json: jsonText,
        content_json: jsonText,
        save_kind: z.enum(["autosave", "manual", "submitted", "reopened"]),
        saved_by_person_id: text.min(1),
        created_at: integer,
      })
      .strict(),
    entityId: id,
    revision: (row) => Number(row.revision_number),
  },
  {
    key: "reviewModerations",
    domain: "evaluations",
    entityType: "review_moderation",
    query: `SELECT id, event_id, round_id, submission_id,
                   moderator_person_id, status, recommendation,
                   moderated_score, notes, created_at, updated_at, confirmed_at
              FROM review_moderations WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        round_id: text.min(1),
        submission_id: text.min(1),
        moderator_person_id: text.min(1),
        status: z.enum(["draft", "confirmed", "superseded"]),
        recommendation: z
          .enum(["accept", "waitlist", "reject", "advance"])
          .nullable(),
        moderated_score: z.number().nullable(),
        notes: nullableText,
        ...timestamps,
        confirmed_at: nullableInteger,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
  {
    key: "decisions",
    domain: "evaluations",
    entityType: "submission_decision",
    query: `SELECT id, event_id, submission_id, round_id, revision_number,
                   status, decision, decided_by_person_id, rationale,
                   notification_feedback_json, effect_preview_json,
                   decided_at, published_at
              FROM submission_decisions WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        submission_id: text.min(1),
        round_id: nullableText,
        revision_number: integer.positive(),
        status: z.enum(["draft", "published", "superseded", "revoked"]),
        decision: z.enum(["accepted", "rejected", "waitlisted"]),
        decided_by_person_id: text.min(1),
        rationale: nullableText,
        notification_feedback_json: jsonText,
        effect_preview_json: jsonText,
        decided_at: integer,
        published_at: nullableInteger,
      })
      .strict(),
    entityId: id,
    revision: (row) => Number(row.revision_number),
  },
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
                   visibility
              FROM session_speakers WHERE event_id = ?
             ORDER BY session_id, person_id`,
    schema: z
      .object({
        session_id: text.min(1),
        event_id: text.min(1),
        person_id: text.min(1),
        position: integer.nonnegative(),
        role_label: nullableText,
        visibility: z.enum(["public", "private", "hidden"]),
      })
      .strict(),
    entityId: (row) => `${String(row.session_id)}:${String(row.person_id)}`,
    revision: () => 1,
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
                   approved_by_person_id, approved_at, created_at, updated_at
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
                   capacity_action, minimum_turnaround_minutes, revision,
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
  {
    key: "taskTemplates",
    domain: "tasks",
    entityType: "task_template",
    query: `SELECT id, event_id, name, description, target_type, task_type,
                   impact, evidence_mode, due_anchor, due_offset_minutes,
                   fixed_due_at, auto_assign_on_acceptance,
                   configuration_json, status,
                   created_at, updated_at
              FROM task_templates WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        name: text.min(1),
        description: nullableText,
        target_type: z.enum(["speaker", "session", "event"]),
        task_type: z.enum([
          "checklist",
          "acknowledgement",
          "short_form",
          "file_upload",
          "link_visit",
          "administrator_only",
        ]),
        impact: z.enum(["critical", "high", "medium", "low"]),
        evidence_mode: z.enum([
          "none",
          "checkbox",
          "file",
          "text",
          "link",
          "admin_approval",
        ]),
        due_anchor: z.enum(["none", "acceptance", "session_start", "fixed"]),
        due_offset_minutes: nullableInteger,
        fixed_due_at: nullableInteger,
        auto_assign_on_acceptance: booleanInteger,
        configuration_json: jsonText,
        status: z.enum(["active", "archived"]),
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
  {
    key: "taskInstances",
    domain: "tasks",
    entityType: "task_instance",
    query: `SELECT id, event_id, template_id, target_type, target_id,
                   owner_person_id, title, description, task_type, impact,
                   status, readiness_state, readiness_percent, revision,
                   due_at, evidence_json, waiver_json, submitted_at,
                   completed_at, completed_by_person_id, created_at, updated_at
              FROM task_instances WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        template_id: nullableText,
        target_type: z.enum(["speaker", "session", "event"]),
        target_id: text.min(1),
        owner_person_id: nullableText,
        title: text.min(1),
        description: nullableText,
        task_type: z.enum([
          "checklist",
          "acknowledgement",
          "short_form",
          "file_upload",
          "link_visit",
          "administrator_only",
        ]),
        impact: z.enum(["critical", "high", "medium", "low"]),
        status: z.enum([
          "not_started",
          "in_progress",
          "blocked",
          "submitted",
          "completed",
          "waived",
          "overdue",
        ]),
        readiness_state: z.enum(["on_track", "at_risk", "overdue", "blocked"]),
        readiness_percent: integer.min(0).max(100),
        revision: integer.positive(),
        due_at: nullableInteger,
        evidence_json: nullableJsonText,
        waiver_json: nullableJsonText,
        submitted_at: nullableInteger,
        completed_at: nullableInteger,
        completed_by_person_id: nullableText,
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "taskTemplateDependencies",
    domain: "tasks",
    entityType: "task_template_dependency",
    query: `SELECT dependency.template_id, template.event_id,
                   dependency.depends_on_template_id, dependency.created_at
              FROM task_template_dependencies dependency
              JOIN task_templates template ON template.id = dependency.template_id
             WHERE template.event_id = ?
             ORDER BY dependency.template_id, dependency.depends_on_template_id`,
    schema: z
      .object({
        template_id: text.min(1),
        event_id: text.min(1),
        depends_on_template_id: text.min(1),
        created_at: integer,
      })
      .strict(),
    entityId: (row) =>
      `${String(row.template_id)}:${String(row.depends_on_template_id)}`,
    revision: () => 1,
  },
  {
    key: "taskInstanceDependencies",
    domain: "tasks",
    entityType: "task_instance_dependency",
    query: `SELECT dependency.task_id, task.event_id,
                   dependency.depends_on_task_id, dependency.created_at
              FROM task_instance_dependencies dependency
              JOIN task_instances task ON task.id = dependency.task_id
             WHERE task.event_id = ?
             ORDER BY dependency.task_id, dependency.depends_on_task_id`,
    schema: z
      .object({
        task_id: text.min(1),
        event_id: text.min(1),
        depends_on_task_id: text.min(1),
        created_at: integer,
      })
      .strict(),
    entityId: (row) =>
      `${String(row.task_id)}:${String(row.depends_on_task_id)}`,
    revision: () => 1,
  },
  {
    key: "taskEvidence",
    domain: "tasks",
    entityType: "task_evidence",
    query: `SELECT id, event_id, task_id, submitted_by_person_id,
                   file_asset_id, evidence_json, status,
                   reviewed_by_person_id, created_at, reviewed_at
              FROM task_evidence WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        task_id: text.min(1),
        submitted_by_person_id: text.min(1),
        file_asset_id: nullableText,
        evidence_json: jsonText,
        status: z.enum(["submitted", "approved", "rejected", "superseded"]),
        reviewed_by_person_id: nullableText,
        created_at: integer,
        reviewed_at: nullableInteger,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
  {
    key: "taskComments",
    domain: "tasks",
    entityType: "task_comment",
    query: `SELECT id, event_id, task_id, author_person_id, body, visibility,
                   created_at, edited_at
              FROM task_comments WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        task_id: text.min(1),
        author_person_id: text.min(1),
        body: text.min(1),
        visibility: z.enum(["participant", "administrator"]),
        created_at: integer,
        edited_at: nullableInteger,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
] as const;

export const AIRTABLE_EVENT_DATA_DOMAINS = [
  "event_setup",
  "forms",
  "submissions",
  "evaluations",
  "sessions",
  "tasks",
] as const satisfies readonly AirtableEventDataDomain[];
