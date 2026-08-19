import { z } from "zod";
import type { AirtableEventTableSpec } from "./airtable-event-data-schema-shared";
import {
  booleanInteger,
  eventRecord,
  id,
  integer,
  jsonArrayText,
  jsonText,
  nullableInteger,
  nullableJsonText,
  nullableText,
  revision,
  text,
  timestamps,
} from "./airtable-event-data-schema-shared";

export const AIRTABLE_EVALUATION_TABLE_SPECS: readonly AirtableEventTableSpec[] =
  [
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
                   scorecard_version, recommendation_choices_json,
                   advancement_rule_json, revision,
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
          recommendation_choices_json: jsonArrayText,
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
                   recommendation_choices_snapshot_json,
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
          recommendation: nullableText,
          recommendation_choices_snapshot_json: jsonArrayText,
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
                   content_json, save_kind, saved_by_person_id,
                   recommendation_choices_snapshot_json, created_at
              FROM review_revisions WHERE event_id = ? ORDER BY id`,
      schema: z
        .object({
          ...eventRecord,
          review_id: text.min(1),
          revision_number: integer.positive(),
          scores_json: jsonText,
          content_json: jsonText,
          recommendation_choices_snapshot_json: jsonArrayText,
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
  ] as const;
