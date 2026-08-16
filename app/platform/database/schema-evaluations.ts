import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { events, people } from "./schema-core";
import { epochNow } from "./schema-helpers";
import { sessions } from "./schema-schedule";
import { submissions } from "./schema-submissions";

export const evaluationPlans = sqliteTable(
  "evaluation_plans",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "active" | "closed" | "archived">(),
    blindedReviewing: integer("blinded_reviewing", { mode: "boolean" })
      .notNull()
      .default(false),
    decisionRole: text("decision_role")
      .notNull()
      .default("administrator")
      .$type<"administrator" | "committee_chair">(),
    revision: integer("revision").notNull().default(1),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_evaluation_plans_event").on(table.eventId, table.status),
  ],
);

export const evaluationTeams = sqliteTable(
  "evaluation_teams",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    chairPersonId: text("chair_person_id").references(() => people.id),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "archived">(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("evaluation_teams_event_name_unique").on(
      table.eventId,
      table.name,
    ),
  ],
);

export const submissionRoutingTeams = sqliteTable(
  "submission_routing_teams",
  {
    submissionId: text("submission_id").notNull(),
    eventId: text("event_id").notNull(),
    teamId: text("team_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.submissionId, table.teamId] }),
    index("idx_submission_routing_teams_event").on(
      table.eventId,
      table.teamId,
      table.submissionId,
    ),
    foreignKey({
      columns: [table.submissionId, table.eventId],
      foreignColumns: [submissions.id, submissions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId, table.eventId],
      foreignColumns: [evaluationTeams.id, evaluationTeams.eventId],
    }),
  ],
);

export const evaluationTeamMembers = sqliteTable(
  "evaluation_team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => evaluationTeams.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    role: text("role")
      .notNull()
      .default("evaluator")
      .$type<"chair" | "evaluator">(),
    joinedAt: integer("joined_at").notNull().default(epochNow),
    removedAt: integer("removed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.personId] }),
    index("idx_team_members_person").on(
      table.eventId,
      table.personId,
      table.removedAt,
    ),
  ],
);

export const evaluationRounds = sqliteTable(
  "evaluation_rounds",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => evaluationPlans.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull(),
    name: text("name").notNull(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "active" | "closed" | "archived">(),
    opensAt: integer("opens_at"),
    closesAt: integer("closes_at"),
    blindedReviewing: integer("blinded_reviewing", { mode: "boolean" })
      .notNull()
      .default(false),
    scorecardId: text("scorecard_id").notNull(),
    scorecardVersion: integer("scorecard_version").notNull().default(1),
    advancementRuleJson: text("advancement_rule_json").notNull().default("{}"),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("evaluation_rounds_number_unique").on(
      table.planId,
      table.roundNumber,
    ),
    index("idx_evaluation_rounds_active").on(
      table.eventId,
      table.status,
      table.roundNumber,
    ),
    index("idx_evaluation_rounds_schedule").on(
      table.eventId,
      table.opensAt,
      table.closesAt,
      table.status,
    ),
    check(
      "evaluation_rounds_date_order_check",
      sql`${table.closesAt} IS NULL OR ${table.opensAt} IS NULL OR ${table.closesAt} > ${table.opensAt}`,
    ),
    check(
      "evaluation_rounds_scorecard_id_check",
      sql`length(trim(${table.scorecardId})) > 0`,
    ),
  ],
);

export const evaluationCriteria = sqliteTable(
  "evaluation_criteria",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundId: text("round_id")
      .notNull()
      .references(() => evaluationRounds.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    inputType: text("input_type")
      .notNull()
      .default("scale_5")
      .$type<"scale_5" | "scale_10" | "yes_no" | "free_text" | "dropdown">(),
    optionsJson: text("options_json").notNull().default("[]"),
    weightPercent: integer("weight_percent").notNull().default(0),
    required: integer("required", { mode: "boolean" }).notNull().default(true),
    position: integer("position").notNull(),
  },
  (table) => [
    uniqueIndex("evaluation_criteria_position_unique").on(
      table.roundId,
      table.position,
    ),
    check(
      "evaluation_criteria_options_check",
      sql`(${table.inputType} = 'dropdown' AND json_array_length(${table.optionsJson}) > 0) OR (${table.inputType} <> 'dropdown' AND json_array_length(${table.optionsJson}) = 0)`,
    ),
  ],
);

export const evaluationRoundReviewers = sqliteTable(
  "evaluation_round_reviewers",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundId: text("round_id").notNull(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    addedByPersonId: text("added_by_person_id").references(() => people.id),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("evaluation_round_reviewers_round_person_unique").on(
      table.roundId,
      table.personId,
    ),
    foreignKey({
      columns: [table.roundId, table.eventId],
      foreignColumns: [evaluationRounds.id, evaluationRounds.eventId],
    }).onDelete("cascade"),
    index("idx_evaluation_round_reviewers_round").on(
      table.eventId,
      table.roundId,
      table.personId,
    ),
    index("idx_evaluation_round_reviewers_person").on(
      table.eventId,
      table.personId,
      table.roundId,
    ),
  ],
);

export const evaluatorConflicts = sqliteTable(
  "evaluator_conflicts",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundId: text("round_id")
      .notNull()
      .references(() => evaluationRounds.id, { onDelete: "cascade" }),
    submissionId: text("submission_id"),
    sessionId: text("session_id"),
    evaluatorPersonId: text("evaluator_person_id")
      .notNull()
      .references(() => people.id),
    relationship: text("relationship"),
    notes: text("notes"),
    status: text("status")
      .notNull()
      .default("declared")
      .$type<"declared" | "recused" | "waived" | "dismissed">(),
    declaredAt: integer("declared_at").notNull().default(epochNow),
    resolvedByPersonId: text("resolved_by_person_id").references(
      () => people.id,
    ),
    resolvedAt: integer("resolved_at"),
  },
  (table) => [
    check(
      "evaluator_conflicts_exact_target_check",
      sql`(${table.submissionId} IS NOT NULL) <> (${table.sessionId} IS NOT NULL)`,
    ),
    foreignKey({
      columns: [table.submissionId, table.eventId],
      foreignColumns: [submissions.id, submissions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId, table.eventId],
      foreignColumns: [sessions.id, sessions.eventId],
    }).onDelete("cascade"),
    uniqueIndex("ux_evaluator_conflicts_submission")
      .on(table.roundId, table.submissionId, table.evaluatorPersonId)
      .where(sql`${table.submissionId} IS NOT NULL`),
    uniqueIndex("ux_evaluator_conflicts_session")
      .on(table.roundId, table.sessionId, table.evaluatorPersonId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    index("idx_evaluator_conflicts_open").on(
      table.eventId,
      table.evaluatorPersonId,
      table.status,
    ),
  ],
);

export const evaluatorAssignments = sqliteTable(
  "evaluator_assignments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundId: text("round_id")
      .notNull()
      .references(() => evaluationRounds.id, { onDelete: "cascade" }),
    submissionId: text("submission_id"),
    sessionId: text("session_id"),
    sessionSnapshotJson: text("session_snapshot_json"),
    evaluatorPersonId: text("evaluator_person_id")
      .notNull()
      .references(() => people.id),
    teamId: text("team_id").references(() => evaluationTeams.id),
    status: text("status")
      .notNull()
      .default("assigned")
      .$type<
        | "assigned"
        | "in_progress"
        | "submitted"
        | "recused"
        | "reopened"
        | "cancelled"
      >(),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    cancellationReason: text("cancellation_reason").$type<
      "reviewer_removed" | "submission_withdrawn" | "decision_published"
    >(),
    dueAt: integer("due_at"),
    conflictDeclaredAt: integer("conflict_declared_at"),
    assignedAt: integer("assigned_at").notNull().default(epochNow),
    submittedAt: integer("submitted_at"),
  },
  (table) => [
    check(
      "evaluator_assignments_exact_target_check",
      sql`(
        (${table.submissionId} IS NOT NULL AND ${table.sessionId} IS NULL AND ${table.sessionSnapshotJson} IS NULL)
        OR
        (${table.submissionId} IS NULL AND ${table.sessionId} IS NOT NULL AND ${table.sessionSnapshotJson} IS NOT NULL AND json_valid(${table.sessionSnapshotJson}))
      )`,
    ),
    foreignKey({
      columns: [table.submissionId, table.eventId],
      foreignColumns: [submissions.id, submissions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId, table.eventId],
      foreignColumns: [sessions.id, sessions.eventId],
    }).onDelete("cascade"),
    uniqueIndex("ux_evaluator_assignments_submission")
      .on(table.roundId, table.submissionId, table.evaluatorPersonId)
      .where(sql`${table.submissionId} IS NOT NULL`),
    uniqueIndex("ux_evaluator_assignments_session")
      .on(table.roundId, table.sessionId, table.evaluatorPersonId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    index("idx_assignments_evaluator_status").on(
      table.eventId,
      table.evaluatorPersonId,
      table.status,
      table.dueAt,
    ),
    index("idx_assignments_submission").on(
      table.eventId,
      table.submissionId,
      table.roundId,
    ),
    index("idx_assignments_session").on(
      table.eventId,
      table.sessionId,
      table.roundId,
    ),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => evaluatorAssignments.id, { onDelete: "cascade" }),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "submitted" | "locked" | "reopened">(),
    scoresJson: text("scores_json").notNull().default("{}"),
    weightedScore: real("weighted_score"),
    recommendation: text("recommendation").$type<
      "accept" | "minor_changes" | "conditional_accept" | "waitlist" | "reject"
    >(),
    confidence: integer("confidence"),
    submitterFeedback: text("submitter_feedback"),
    privateNotes: text("private_notes"),
    aiSuggestionId: text("ai_suggestion_id").references(
      () => reviewerAiSuggestions.id,
    ),
    importedCriterionIdsJson: text("imported_criterion_ids_json")
      .notNull()
      .default("[]"),
    confirmedAiCriterionIdsJson: text("confirmed_ai_criterion_ids_json")
      .notNull()
      .default("[]"),
    /* When the reviewer affirmed they hold no conflict on this assignment.
       Null means the question is unanswered, which blocks submission. */
    conflictAffirmedAt: integer("conflict_affirmed_at"),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
    submittedAt: integer("submitted_at"),
    lockedAt: integer("locked_at"),
  },
  (table) => [
    uniqueIndex("reviews_assignment_unique").on(table.assignmentId),
    index("idx_reviews_status").on(
      table.eventId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const evaluationDiscussionMessages = sqliteTable(
  "evaluation_discussion_messages",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundId: text("round_id").notNull(),
    submissionId: text("submission_id"),
    sessionId: text("session_id"),
    authorPersonId: text("author_person_id")
      .notNull()
      .references(() => people.id),
    body: text("body"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    check(
      "evaluation_discussion_messages_exact_target_check",
      sql`(
        (${table.submissionId} IS NOT NULL AND ${table.sessionId} IS NULL)
        OR
        (${table.submissionId} IS NULL AND ${table.sessionId} IS NOT NULL)
      )`,
    ),
    check(
      "evaluation_discussion_messages_body_check",
      sql`${table.body} IS NULL OR length(trim(${table.body})) BETWEEN 1 AND 2000`,
    ),
    foreignKey({
      columns: [table.roundId, table.eventId],
      foreignColumns: [evaluationRounds.id, evaluationRounds.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.submissionId, table.eventId],
      foreignColumns: [submissions.id, submissions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId, table.eventId],
      foreignColumns: [sessions.id, sessions.eventId],
    }).onDelete("cascade"),
    uniqueIndex("evaluation_discussion_messages_idempotency_unique").on(
      table.eventId,
      table.authorPersonId,
      table.idempotencyKey,
    ),
    index("idx_evaluation_discussion_submission").on(
      table.eventId,
      table.roundId,
      table.submissionId,
      table.createdAt,
      table.id,
    ),
    index("idx_evaluation_discussion_session").on(
      table.eventId,
      table.roundId,
      table.sessionId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const aiReviewAssessments = sqliteTable(
  "ai_review_assessments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    roundId: text("round_id").notNull(),
    submissionId: text("submission_id").notNull(),
    scorecardId: text("scorecard_id").notNull(),
    scorecardVersion: integer("scorecard_version").notNull(),
    roundRevision: integer("round_revision").notNull(),
    score: real("score").notNull(),
    rationale: text("rationale").notNull(),
    provider: text("provider")
      .notNull()
      .$type<"workers_ai" | "openai" | "anthropic">(),
    model: text("model").notNull(),
    providerResponseId: text("provider_response_id").notNull(),
    generatedByPersonId: text("generated_by_person_id")
      .notNull()
      .references(() => people.id),
    generatedAt: integer("generated_at").notNull().default(epochNow),
    overrideScore: real("override_score"),
    overrideRationale: text("override_rationale"),
    overrideByPersonId: text("override_by_person_id").references(
      () => people.id,
    ),
    overrideAt: integer("override_at"),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id").notNull(),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.roundId, table.eventId],
      foreignColumns: [evaluationRounds.id, evaluationRounds.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.submissionId, table.eventId],
      foreignColumns: [submissions.id, submissions.eventId],
    }).onDelete("cascade"),
    uniqueIndex("ai_review_assessments_target_unique").on(
      table.eventId,
      table.roundId,
      table.submissionId,
    ),
    uniqueIndex("ai_review_assessments_operation_unique").on(
      table.lastOperationId,
    ),
    index("idx_ai_review_assessments_round").on(
      table.eventId,
      table.roundId,
      table.submissionId,
    ),
    index("idx_ai_review_assessments_submission").on(
      table.eventId,
      table.submissionId,
      table.roundId,
    ),
  ],
);

export const reviewerAiSuggestions = sqliteTable(
  "reviewer_ai_suggestions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    assignmentId: text("assignment_id").notNull(),
    evaluatorPersonId: text("evaluator_person_id")
      .notNull()
      .references(() => people.id),
    assignmentRevision: integer("assignment_revision").notNull(),
    roundId: text("round_id").notNull(),
    targetType: text("target_type").notNull().$type<"submission" | "session">(),
    targetId: text("target_id").notNull(),
    sourceSnapshotHash: text("source_snapshot_hash").notNull(),
    scorecardId: text("scorecard_id").notNull(),
    scorecardVersion: integer("scorecard_version").notNull(),
    suggestionsJson: text("suggestions_json").notNull(),
    provider: text("provider")
      .notNull()
      .$type<"workers_ai" | "openai" | "anthropic">(),
    model: text("model").notNull(),
    providerResponseId: text("provider_response_id").notNull(),
    status: text("status")
      .notNull()
      .default("offered")
      .$type<"offered" | "dismissed" | "imported">(),
    generatedAt: integer("generated_at").notNull().default(epochNow),
    dismissedAt: integer("dismissed_at"),
    importedAt: integer("imported_at"),
    importedReviewId: text("imported_review_id"),
    lifecycleOperationId: text("lifecycle_operation_id"),
    lastOperationId: text("last_operation_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.assignmentId, table.eventId],
      foreignColumns: [evaluatorAssignments.id, evaluatorAssignments.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.roundId, table.eventId],
      foreignColumns: [evaluationRounds.id, evaluationRounds.eventId],
    }).onDelete("cascade"),
    uniqueIndex("reviewer_ai_suggestions_operation_unique").on(
      table.lastOperationId,
    ),
    uniqueIndex("reviewer_ai_suggestions_lifecycle_operation_unique").on(
      table.lifecycleOperationId,
    ),
    index("idx_reviewer_ai_suggestions_assignment").on(
      table.eventId,
      table.assignmentId,
      table.evaluatorPersonId,
      table.generatedAt,
    ),
    uniqueIndex("ux_reviewer_ai_suggestions_active")
      .on(table.eventId, table.assignmentId, table.evaluatorPersonId)
      .where(sql`${table.status} IN ('offered','imported')`),
  ],
);

export const reviewRevisions = sqliteTable(
  "review_revisions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    scoresJson: text("scores_json").notNull(),
    contentJson: text("content_json").notNull().default("{}"),
    saveKind: text("save_kind")
      .notNull()
      .default("autosave")
      .$type<"autosave" | "manual" | "submitted" | "reopened">(),
    savedByPersonId: text("saved_by_person_id")
      .notNull()
      .references(() => people.id),
    idempotencyKey: text("idempotency_key"),
    scorecardId: text("scorecard_id"),
    scorecardVersion: integer("scorecard_version"),
    criteriaSnapshotJson: text("criteria_snapshot_json"),
    aiSuggestionId: text("ai_suggestion_id").references(
      () => reviewerAiSuggestions.id,
    ),
    importedCriterionIdsJson: text("imported_criterion_ids_json")
      .notNull()
      .default("[]"),
    confirmedAiCriterionIdsJson: text("confirmed_ai_criterion_ids_json")
      .notNull()
      .default("[]"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("review_revisions_number_unique").on(
      table.reviewId,
      table.revisionNumber,
    ),
    uniqueIndex("review_revisions_idempotency_unique").on(
      table.reviewId,
      table.idempotencyKey,
    ),
  ],
);

export const reviewModerations = sqliteTable(
  "review_moderations",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundId: text("round_id")
      .notNull()
      .references(() => evaluationRounds.id, { onDelete: "cascade" }),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    moderatorPersonId: text("moderator_person_id")
      .notNull()
      .references(() => people.id),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "confirmed" | "superseded">(),
    recommendation: text("recommendation").$type<
      "accept" | "waitlist" | "reject" | "advance"
    >(),
    moderatedScore: real("moderated_score"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
    confirmedAt: integer("confirmed_at"),
  },
  (table) => [
    uniqueIndex("ux_review_moderations_current")
      .on(table.roundId, table.submissionId)
      .where(sql`${table.status} IN ('draft','confirmed')`),
  ],
);

export const submissionDecisions = sqliteTable(
  "submission_decisions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    roundId: text("round_id").references(() => evaluationRounds.id),
    revisionNumber: integer("revision_number").notNull().default(1),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "published" | "superseded" | "revoked">(),
    decision: text("decision")
      .notNull()
      .$type<"accepted" | "rejected" | "waitlisted">(),
    decidedByPersonId: text("decided_by_person_id")
      .notNull()
      .references(() => people.id),
    rationale: text("rationale"),
    notificationFeedbackJson: text("notification_feedback_json").notNull(),
    effectPreviewJson: text("effect_preview_json").notNull().default("{}"),
    idempotencyKey: text("idempotency_key"),
    decidedAt: integer("decided_at").notNull().default(epochNow),
    publishedAt: integer("published_at"),
  },
  (table) => [
    uniqueIndex("submission_decisions_revision_unique").on(
      table.submissionId,
      table.revisionNumber,
    ),
    uniqueIndex("submission_decisions_idempotency_unique").on(
      table.eventId,
      table.idempotencyKey,
    ),
    uniqueIndex("ux_decisions_one_published")
      .on(table.submissionId)
      .where(sql`${table.status} = 'published'`),
  ],
);
