import { DEFAULT_EVENT_BRAND_ACCENT } from "~/lib/brand";
import { requireEmailProviderConfiguration } from "~/modules/communications/email-provider.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { INITIAL_EVENT_SESSION_FORMATS_JSON } from "~/modules/events/event-configuration";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import {
  DEMO_ASSISTANT_FIXTURE_MODEL,
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
  DEMO_R2_PREFIX,
  DEMO_RESET_CONFIRMATION,
  DEMO_VENUE_ADDRESS,
  DEMO_VENUE_MAP_URL,
  SBEK_FIXTURE_PEOPLE,
  SBEK_SECOND_SPEAKER,
} from "~/platform/demo/demo-identities";
import {
  DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
  DEMO_DECISION_SENDER_ID,
  DEMO_DECISION_TEMPLATE_ID,
  DEMO_DECISION_VERSION_ID,
  DEMO_EVALUATION_RESET_CONFIRMATION,
  DEMO_REMINDER_TEMPLATE_ID,
  DEMO_REMINDER_VERSION_ID,
  DEMO_REVIEWER_REMINDER_TEMPLATE_ID,
  DEMO_REVIEWER_REMINDER_VERSION_ID,
  DEMO_SHOWCASE_CHAIR_ASSIGNMENT_ID,
  DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
  DEMO_SHOWCASE_DECISION_ID,
  DEMO_SHOWCASE_DISCUSSION_ID,
  DEMO_SHOWCASE_EMBED_CONFIGURATION,
  DEMO_SHOWCASE_EMBED_ID,
  DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
  DEMO_SHOWCASE_PROFILE_REVISION_ID,
  DEMO_SHOWCASE_REVIEWER_ASSIGNMENT_ID,
  DEMO_SHOWCASE_ROUND_ID,
  DEMO_SHOWCASE_SUBMISSION_ID,
  DEMO_SHOWCASE_TIMESTAMP,
  DEMO_SPEAKER_WELCOME_TEMPLATE_ID,
  DEMO_SPEAKER_WELCOME_VERSION_ID,
  DEMO_SUBMISSION_CONFIRMATION_TEMPLATE_ID,
  DEMO_SUBMISSION_CONFIRMATION_VERSION_ID,
} from "~/platform/demo/demo-reset-fixtures";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

export {
  DEMO_EVENT_ID,
  DEMO_ORGANISATION_ID,
  DEMO_R2_PREFIX,
  DEMO_RESET_CONFIRMATION,
} from "~/platform/demo/demo-identities";
export {
  DEMO_DECISION_SENDER_ID,
  DEMO_EVALUATION_RESET_CONFIRMATION,
} from "~/platform/demo/demo-reset-fixtures";

export type DemoActiveWork = {
  operations: number;
  multipartUploads: number;
  integrationRuns: number;
  communications: number;
  calendarAttempts: number;
  webhookDeliveries: number;
};

export class DemoResetUnavailableError extends Error {
  constructor() {
    super(
      "The evaluator reset is available only in the explicit demo runtime.",
    );
    this.name = "DemoResetUnavailableError";
  }
}

export class DemoResetConfirmationError extends Error {
  constructor() {
    super(
      "Type the exact demo event name shown on the page before resetting it.",
    );
    this.name = "DemoResetConfirmationError";
  }
}

export class DemoResetBusyError extends Error {
  readonly activeWork: DemoActiveWork;

  constructor(activeWork: DemoActiveWork) {
    super(
      "The demo cannot reset while external or background work is still active.",
    );
    this.name = "DemoResetBusyError";
    this.activeWork = activeWork;
  }
}

export class DemoResetRetentionError extends Error {
  constructor() {
    super(
      "The demo cannot be reset after participant retention has completed.",
    );
    this.name = "DemoResetRetentionError";
  }
}

export class DemoResetStorageError extends Error {
  readonly committed = true;

  constructor(cause: unknown) {
    super(
      `The D1 demo baseline was restored, but its private R2 prefix could not be cleared: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "DemoResetStorageError";
  }
}

// Ordered to remove restrictive child references before their parents. Audit
// history is deliberately absent: the baseline trigger makes it append-only,
// and a demo reset must not weaken that production invariant.
export const DEMO_RESET_EVENT_TABLES = [
  "assistant_proposal_executions",
  "api_keys",
  "webhook_endpoints",
  "saved_views",
  "idempotency_records",
  "calendar_invitations",
  "calendar_connections",
  "communication_deliveries",
  "communications",
  "communication_unsubscribes",
  "communication_triggers",
  "communication_template_versions",
  "communication_templates",
  "sender_profiles",
  "integration_connections",
  "resource_acknowledgements",
  "resource_attachments",
  "resource_audiences",
  "resource_page_versions",
  "resource_pages",
  "task_evidence",
  "event_brand_assets",
  "file_multipart_uploads",
  "file_versions",
  "file_assets",
  "task_comments",
  "task_instances",
  "task_templates",
  "programme_embeds",
  "public_itineraries",
  "schedule_conflicts",
  "schedule_entries",
  "session_content_revisions",
  "schedule_session_contents",
  "schedule_versions",
  "speaker_profile_revisions",
  "event_participant_profiles",
  "event_speaker_workflows",
  "session_tags",
  "session_archives",
  "session_speakers",
  "sessions",
  "tags",
  "rooms",
  "submission_routing_teams",
  "submission_track_selections",
  "tracks",
  "schedule_policies",
  "submission_decisions",
  "ai_review_assessments",
  "review_moderations",
  "review_revisions",
  "evaluation_discussion_messages",
  "reviews",
  "reviewer_ai_suggestions",
  "event_ai_review_settings",
  "evaluator_assignments",
  "evaluator_conflicts",
  "submission_speakers",
  "submission_email_verifications",
  "submission_revisions",
  "submissions",
  "evaluation_criteria",
  "evaluation_round_reviewers",
  "evaluation_team_members",
  "evaluation_rounds",
  "evaluation_teams",
  "evaluation_plans",
  "form_versions",
  "form_definitions",
  "operation_jobs",
  "event_changes",
  "memberships",
] as const;

function assertDemoRuntime(env: CloudflareEnvironment) {
  const mode = requireRuntimeMode(env);
  if (
    !mode.demo ||
    env.DEFAULT_EVENT_ID !== DEMO_EVENT_ID ||
    String(env.DEMO_MODE) !== "true"
  ) {
    throw new DemoResetUnavailableError();
  }
}

export async function readDemoActiveWork(
  env: CloudflareEnvironment,
): Promise<DemoActiveWork> {
  assertDemoRuntime(env);
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM operation_jobs
         WHERE event_id = ? AND status IN ('queued','received','running','retrying')) AS operations,
       (SELECT COUNT(*) FROM file_multipart_uploads
         WHERE event_id = ? AND status IN ('requested','initiated','completing')) AS multipartUploads,
       (SELECT COUNT(*)
          FROM integration_runs run
          JOIN integration_connections connection ON connection.id = run.connection_id
         WHERE connection.event_id = ? AND run.status IN ('queued','running')) AS integrationRuns,
       (SELECT COUNT(*) FROM communications
         WHERE event_id = ? AND status IN ('scheduled','queued','sending')) AS communications,
       (SELECT COUNT(*)
          FROM calendar_sync_attempts attempt
          JOIN calendar_invitations invitation ON invitation.id = attempt.invitation_id
         WHERE invitation.event_id = ? AND attempt.status IN ('queued','running')) AS calendarAttempts,
       (SELECT COUNT(*)
          FROM webhook_deliveries delivery
          JOIN webhook_endpoints endpoint ON endpoint.id = delivery.endpoint_id
         WHERE endpoint.event_id = ? AND delivery.status IN ('queued','delivering')) AS webhookDeliveries`,
  )
    .bind(
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
    )
    .first<DemoActiveWork>();
  if (!row) throw new Error("The demo activity boundary could not be read.");
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as DemoActiveWork;
}

function activeWorkTotal(activeWork: DemoActiveWork) {
  return Object.values(activeWork).reduce((total, count) => total + count, 0);
}

// Visual/demo proposal previews are append-only audit records, so resetting
// their mutable execution ledger cannot remove them. Append the same terminal
// marker used by the assistant and limit it to the explicit no-provider demo
// model; ordinary assistant proposals and their production semantics are left
// untouched.
async function supersedeDemoAssistantFixtureProposals(
  env: CloudflareEnvironment,
) {
  const result = await env.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
       entity_type, entity_id, correlation_id, metadata_json, created_at
     )
     SELECT 'demo-reset-assistant-superseded:' || proposal.entity_id, 'person', 'internal', 1,
            proposal.organisation_id, proposal.event_id,
            proposal.actor_person_id, 'assistant.proposal.superseded',
            'assistant_proposal', proposal.entity_id,
            'demo-reset:' || proposal.entity_id,
            json_object(
              'proposalId', proposal.entity_id,
              'reason', 'demo_fixture_reset',
              'fixtureModel', ?
            ),
            unixepoch()
       FROM audit_events proposal
      WHERE proposal.organisation_id = ? AND proposal.event_id = ?
        AND proposal.action = 'assistant.proposal.previewed'
        AND proposal.entity_type = 'assistant_proposal'
        AND proposal.entity_id IS NOT NULL
        AND json_extract(proposal.metadata_json, '$.model') = ?
        AND NOT EXISTS (
          SELECT 1
            FROM audit_events superseded
           WHERE superseded.event_id = proposal.event_id
             AND superseded.actor_person_id = proposal.actor_person_id
             AND superseded.action = 'assistant.proposal.superseded'
             AND superseded.entity_type = 'assistant_proposal'
             AND superseded.entity_id = proposal.entity_id
        )`,
  )
    .bind(
      DEMO_ASSISTANT_FIXTURE_MODEL,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_ASSISTANT_FIXTURE_MODEL,
    )
    .run();
  return result.meta.changes ?? 0;
}

async function clearDemoObjects(
  bucket: R2Bucket,
  assertDestructiveWorkAllowed: (() => Promise<void>) | null = null,
) {
  let deleted = 0;
  let previousPage: string | null = null;
  let repeatedPageCount = 0;
  while (true) {
    await assertDestructiveWorkAllowed?.();
    const page = await bucket.list({ prefix: DEMO_R2_PREFIX, limit: 1_000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length === 0) return deleted;
    const pageIdentity = JSON.stringify(keys);
    repeatedPageCount =
      pageIdentity === previousPage ? repeatedPageCount + 1 : 0;
    if (repeatedPageCount >= 3) {
      throw new Error(
        "The demo R2 prefix did not make progress after repeated delete attempts.",
      );
    }
    previousPage = pageIdentity;
    await assertDestructiveWorkAllowed?.();
    await bucket.delete(keys);
    deleted += keys.length;
    if (deleted > 100_000) {
      throw new Error(
        "The demo R2 prefix exceeded the 100,000-object reset safety limit.",
      );
    }
  }
}

async function resetMutableIdentity(env: CloudflareEnvironment) {
  const identities = [...Object.values(DEMO_IDENTITIES), SBEK_SECOND_SPEAKER];
  const statements = [
    env.DB.prepare(
      `UPDATE organisations
          SET name = 'Future Events Association', slug = 'future-events-association', updated_at = unixepoch()
        WHERE id = ?`,
    ).bind(DEMO_ORGANISATION_ID),
    env.DB.prepare(
      `UPDATE events
          SET name = 'Future of Events 2027', slug = 'future-of-events-2027',
              timezone = 'America/Toronto',
              starts_at = unixepoch('2027-05-20T00:00:00Z'),
              ends_at = unixepoch('2027-05-22T23:59:59Z'),
              venue_name = 'Metro Toronto Convention Centre', city = 'Toronto',
              venue_address = ?, venue_map_url = ?,
              programme_hero_image_url = NULL,
              description = 'The conference for modern event professionals.',
              brand_accent = ?, participant_logo_url = NULL,
              participant_welcome_text = NULL, participant_support_url = NULL,
              brand_logo_asset_id = NULL, brand_banner_asset_id = NULL,
              brand_draft_accent = ?,
              brand_draft_logo_asset_id = NULL,
              brand_draft_banner_asset_id = NULL,
              brand_draft_welcome_text = NULL,
              brand_draft_support_url = NULL,
              brand_draft_revision = 1, brand_published_revision = 1,
              brand_published_at = unixepoch(),
              session_formats_json = ?, repository_provider = 'd1',
              activation_status = 'active',
              repository_locked_at = NULL, retention_months = 24,
              file_retention_hold_at = NULL,
              participant_retention_completed_at = NULL,
              submission_access_mode = 'email_verified',
              allow_anonymous_drafts = 1, duplicate_person_warnings = 1,
              file_policy_json = ?, revision = 1, last_operation_id = NULL,
              last_updated_by_person_id = ?, programme_published_at = NULL,
              updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ?`,
    ).bind(
      DEMO_VENUE_ADDRESS,
      DEMO_VENUE_MAP_URL,
      DEFAULT_EVENT_BRAND_ACCENT,
      DEFAULT_EVENT_BRAND_ACCENT,
      INITIAL_EVENT_SESSION_FORMATS_JSON,
      CANONICAL_EVENT_FILE_POLICY_JSON,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
    ),
    env.DB.prepare(
      `INSERT INTO schedule_policies (
         event_id, room_overlap_action, speaker_overlap_action
       ) VALUES (?, 'block', 'warn')`,
    ).bind(DEMO_EVENT_ID),
    ...identities.map((identity) =>
      env.DB.prepare(
        `UPDATE people
            SET email = ?, display_name = ?, email_verified = 1,
                image_url = NULL, biography = NULL, pronunciation = NULL,
                organisation_name = NULL, job_title = NULL,
                linkedin_url = NULL, x_handle = NULL,
                profile_status = ?, profile_revision = 1,
                last_operation_id = NULL, updated_at = unixepoch()
          WHERE id = ?`,
      ).bind(
        identity.email,
        identity.name,
        identity.profileStatus,
        identity.personId,
      ),
    ),
  ];
  const results = await env.DB.batch(statements);
  if ((results[1]?.meta.changes ?? 0) !== 1) {
    throw new Error("The canonical demo event identity could not be restored.");
  }
}

// Showcase evidence uses only the populated demo people. The clean SBEK
// applicant and reviewer remain absent from these records by construction and
// are independently verified as clean in baselineEvidence.
async function seedShowcaseCohort(env: CloudflareEnvironment) {
  const positiveScores = JSON.stringify({
    "demo-evaluation-criterion-relevance": 5,
    "demo-evaluation-criterion-substance": 5,
    "demo-evaluation-criterion-practicality": 4,
    "demo-evaluation-criterion-delivery": 4,
  });
  const criticalScores = JSON.stringify({
    "demo-evaluation-criterion-relevance": 2,
    "demo-evaluation-criterion-substance": 2,
    "demo-evaluation-criterion-practicality": 3,
    "demo-evaluation-criterion-delivery": 2,
  });
  const criteriaSnapshotSql = `COALESCE((
    SELECT json_group_array(json(ordered.snapshot))
      FROM (
        SELECT json_object(
                 'id', criterion.id,
                 'name', criterion.name,
                 'description', criterion.description,
                 'inputType', criterion.input_type,
                 'options', json(criterion.options_json),
                 'weightPercent', criterion.weight_percent,
                 'required', json(CASE WHEN criterion.required = 1
                                      THEN 'true' ELSE 'false' END),
                 'position', criterion.position
               ) AS snapshot
          FROM evaluation_criteria criterion
         WHERE criterion.event_id = round.event_id
           AND criterion.round_id = round.id
         ORDER BY criterion.position
      ) ordered
  ), '[]')`;
  const reviewRevision = (input: {
    id: string;
    reviewId: string;
    scores: string;
    recommendation: "accept" | "reject";
    submitterFeedback: string;
    privateNotes: string;
    personId: string;
    timestamp: number;
  }) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO review_revisions (
         id, event_id, review_id, revision_number, scores_json, content_json,
         save_kind, saved_by_person_id, idempotency_key, scorecard_id,
         scorecard_version, criteria_snapshot_json, created_at
       )
       SELECT ?, review.event_id, review.id, 1, ?, ?, 'submitted', ?, ?,
              round.scorecard_id, round.scorecard_version,
              ${criteriaSnapshotSql}, ?
         FROM reviews review
         JOIN evaluator_assignments assignment
           ON assignment.id = review.assignment_id
          AND assignment.event_id = review.event_id
         JOIN evaluation_rounds round
           ON round.id = assignment.round_id
          AND round.event_id = assignment.event_id
        WHERE review.id = ? AND review.event_id = ?`,
    ).bind(
      input.id,
      input.scores,
      JSON.stringify({
        recommendation: input.recommendation,
        confidence: 4,
        submitterFeedback: input.submitterFeedback,
        privateNotes: input.privateNotes,
      }),
      input.personId,
      `demo-showcase:${input.reviewId}`,
      input.timestamp,
      input.reviewId,
      DEMO_EVENT_ID,
    );

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO evaluation_round_reviewers (
         id, event_id, round_id, person_id, added_by_person_id,
         revision, created_at, updated_at
       )
       SELECT 'demo-showcase-round-reviewer-chair', round.event_id, round.id,
              membership.person_id, ?, 1, ?, ?
         FROM evaluation_rounds round
         JOIN memberships membership
           ON membership.event_id = round.event_id
          AND membership.person_id = ?
          AND membership.role = 'committee_chair'
          AND membership.accepted_at IS NOT NULL
          AND membership.revoked_at IS NULL
        WHERE round.id = ? AND round.event_id = ?`,
    ).bind(
      DEMO_IDENTITIES.owner.personId,
      DEMO_SHOWCASE_TIMESTAMP - 500,
      DEMO_SHOWCASE_TIMESTAMP - 500,
      DEMO_IDENTITIES.committee_chair.personId,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_EVENT_ID,
    ),
    env.DB.prepare(
      `UPDATE evaluator_assignments
          SET status = 'submitted', revision = 2,
              last_operation_id = 'demo-showcase:positive-review',
              submitted_at = ?, assigned_at = ?
        WHERE id = ? AND event_id = ? AND round_id = ?
          AND submission_id = ? AND evaluator_person_id = ?`,
    ).bind(
      DEMO_SHOWCASE_TIMESTAMP - 300,
      DEMO_SHOWCASE_TIMESTAMP - 900,
      DEMO_SHOWCASE_REVIEWER_ASSIGNMENT_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_IDENTITIES.evaluator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO evaluator_assignments (
         id, event_id, round_id, submission_id, evaluator_person_id,
         status, revision, last_operation_id, assigned_at, submitted_at
       )
       SELECT ?, round.event_id, round.id, submission.id, pool.person_id,
              'submitted', 2, 'demo-showcase:critical-review', ?, ?
         FROM evaluation_rounds round
         JOIN submissions submission
           ON submission.event_id = round.event_id AND submission.id = ?
         JOIN evaluation_round_reviewers pool
           ON pool.event_id = round.event_id AND pool.round_id = round.id
          AND pool.person_id = ?
        WHERE round.id = ? AND round.event_id = ?`,
    ).bind(
      DEMO_SHOWCASE_CHAIR_ASSIGNMENT_ID,
      DEMO_SHOWCASE_TIMESTAMP - 800,
      DEMO_SHOWCASE_TIMESTAMP - 200,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_IDENTITIES.committee_chair.personId,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_EVENT_ID,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO reviews (
         id, event_id, assignment_id, status, scores_json, weighted_score,
         recommendation, confidence, submitter_feedback, private_notes,
         revision, last_operation_id, created_at, updated_at,
         submitted_at, locked_at
       ) VALUES (?, ?, ?, 'submitted', ?, 4.55, 'accept', 4, ?, ?,
                 1, 'demo-showcase:positive-review', ?, ?, ?, ?)`,
    ).bind(
      DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_REVIEWER_ASSIGNMENT_ID,
      positiveScores,
      "The operating rhythm is practical and immediately useful for event teams.",
      "Strong evidence and a clear facilitation plan.",
      DEMO_SHOWCASE_TIMESTAMP - 600,
      DEMO_SHOWCASE_TIMESTAMP - 300,
      DEMO_SHOWCASE_TIMESTAMP - 300,
      DEMO_SHOWCASE_TIMESTAMP - 300,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO reviews (
         id, event_id, assignment_id, status, scores_json, weighted_score,
         recommendation, confidence, submitter_feedback, private_notes,
         revision, last_operation_id, created_at, updated_at,
         submitted_at, locked_at
       ) VALUES (?, ?, ?, 'submitted', ?, 2.25, 'reject', 4, ?, ?,
                 1, 'demo-showcase:critical-review', ?, ?, ?, ?)`,
    ).bind(
      DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_CHAIR_ASSIGNMENT_ID,
      criticalScores,
      "The proposal needs clearer evidence and a more specific participant outcome.",
      "Useful topic, but the current scope is too broad for the promised workshop.",
      DEMO_SHOWCASE_TIMESTAMP - 550,
      DEMO_SHOWCASE_TIMESTAMP - 200,
      DEMO_SHOWCASE_TIMESTAMP - 200,
      DEMO_SHOWCASE_TIMESTAMP - 200,
    ),
    reviewRevision({
      id: "demo-showcase-review-positive-r1",
      reviewId: DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
      scores: positiveScores,
      recommendation: "accept",
      submitterFeedback:
        "The operating rhythm is practical and immediately useful for event teams.",
      privateNotes: "Strong evidence and a clear facilitation plan.",
      personId: DEMO_IDENTITIES.evaluator.personId,
      timestamp: DEMO_SHOWCASE_TIMESTAMP - 300,
    }),
    reviewRevision({
      id: "demo-showcase-review-critical-r1",
      reviewId: DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
      scores: criticalScores,
      recommendation: "reject",
      submitterFeedback:
        "The proposal needs clearer evidence and a more specific participant outcome.",
      privateNotes:
        "Useful topic, but the current scope is too broad for the promised workshop.",
      personId: DEMO_IDENTITIES.committee_chair.personId,
      timestamp: DEMO_SHOWCASE_TIMESTAMP - 200,
    }),
    env.DB.prepare(
      `INSERT OR IGNORE INTO evaluation_discussion_messages (
         id, event_id, round_id, submission_id, session_id,
         author_person_id, body, idempotency_key, created_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'demo-showcase:discussion', ?)`,
    ).bind(
      DEMO_SHOWCASE_DISCUSSION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_IDENTITIES.committee_chair.personId,
      "The reviews diverge on evidence and workshop scope. Keep this proposal visible for committee moderation before a final accept or reject decision.",
      DEMO_SHOWCASE_TIMESTAMP - 100,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO submission_decisions (
         id, event_id, submission_id, round_id, revision_number, status,
         decision, decided_by_person_id, rationale,
         notification_feedback_json, effect_preview_json, idempotency_key,
         decided_at, published_at
       ) VALUES (?, ?, ?, ?, 1, 'published', 'waitlisted', ?, ?, '[]', ?,
                 'demo-showcase:decision', ?, ?)`,
    ).bind(
      DEMO_SHOWCASE_DECISION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_IDENTITIES.owner.personId,
      "Waitlisted after committee moderation because the reviewers disagreed on evidence and delivery scope.",
      JSON.stringify({
        submissionId: DEMO_SHOWCASE_SUBMISSION_ID,
        fromStatus: "in_review",
        toStatus: "waitlisted",
        notificationReleased: false,
      }),
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_TIMESTAMP,
    ),
    env.DB.prepare(
      `UPDATE submissions
          SET status = 'waitlisted', revision = 3,
              last_operation_id = ?, updated_at = ?
        WHERE id = ? AND event_id = ?`,
    ).bind(
      DEMO_SHOWCASE_DECISION_ID,
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_EVENT_ID,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO speaker_profile_revisions (
         id, organisation_id, event_id, person_id, source, profile_revision,
         display_name, biography, pronunciation, organisation_name, job_title,
         publication_status, headshot_file_version_id, recorded_by_person_id,
         correlation_id, created_at
       ) VALUES (?, ?, ?, ?, 'canonical_person', 1, 'Priya Shah', ?,
                 'PREE-yah SHAH', 'EventLab', 'Director of Experience Design',
                 'published', NULL, ?, 'demo-showcase:profile-revision', ?)`,
    ).bind(
      DEMO_SHOWCASE_PROFILE_REVISION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.speaker.personId,
      "Priya helps event teams design useful, inclusive technology experiences.",
      DEMO_IDENTITIES.owner.personId,
      DEMO_SHOWCASE_TIMESTAMP - 1_000,
    ),
    env.DB.prepare(
      `UPDATE people
          SET profile_revision = 2, updated_at = ?
        WHERE id = ? AND profile_status = 'published'`,
    ).bind(DEMO_SHOWCASE_TIMESTAMP - 900, DEMO_IDENTITIES.speaker.personId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO programme_embeds (
         id, event_id, organisation_id, name, slug, status,
         configuration_json, installation_note, revision,
         created_by_person_id, updated_by_person_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'Main website agenda', 'main-agenda', 'active', ?, ?, 2,
                 ?, ?, ?, ?)`,
    ).bind(
      DEMO_SHOWCASE_EMBED_ID,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      JSON.stringify(DEMO_SHOWCASE_EMBED_CONFIGURATION),
      "Primary schedule embed for the conference website agenda page.",
      DEMO_IDENTITIES.owner.personId,
      DEMO_IDENTITIES.owner.personId,
      DEMO_SHOWCASE_TIMESTAMP - 700,
      DEMO_SHOWCASE_TIMESTAMP - 650,
    ),
    ...[
      {
        id: "audit-demo-showcase-review-positive",
        actor: DEMO_IDENTITIES.evaluator.personId,
        action: "review.submitted",
        table: "reviews",
        entityType: "review",
        entityId: DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
        metadata: { revision: 1 },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 300,
      },
      {
        id: "audit-demo-showcase-review-critical",
        actor: DEMO_IDENTITIES.committee_chair.personId,
        action: "review.submitted",
        table: "reviews",
        entityType: "review",
        entityId: DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
        metadata: { revision: 1 },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 200,
      },
      {
        id: "audit-demo-showcase-discussion",
        actor: DEMO_IDENTITIES.committee_chair.personId,
        action: "evaluation.discussion.message.added",
        table: "evaluation_discussion_messages",
        entityType: "evaluation_discussion_message",
        entityId: DEMO_SHOWCASE_DISCUSSION_ID,
        metadata: {
          roundId: DEMO_SHOWCASE_ROUND_ID,
          targetType: "submission",
          targetId: DEMO_SHOWCASE_SUBMISSION_ID,
        },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 100,
      },
      {
        id: "audit-demo-showcase-decision",
        actor: DEMO_IDENTITIES.owner.personId,
        action: "decision.published",
        table: "submission_decisions",
        entityType: "submission_decision",
        entityId: DEMO_SHOWCASE_DECISION_ID,
        metadata: { decision: "waitlisted" },
        timestamp: DEMO_SHOWCASE_TIMESTAMP,
      },
      {
        id: "audit-demo-showcase-profile-revision",
        actor: DEMO_IDENTITIES.owner.personId,
        action: "speaker.admin.profile.updated",
        table: "people",
        entityType: "person",
        entityId: DEMO_IDENTITIES.speaker.personId,
        metadata: { profileStatus: "published", revision: 2 },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 900,
      },
      {
        id: "audit-demo-showcase-embed-created",
        actor: DEMO_IDENTITIES.owner.personId,
        action: "programme_embed.created",
        table: "programme_embeds",
        entityType: "programme_embed",
        entityId: DEMO_SHOWCASE_EMBED_ID,
        metadata: { status: "draft", revision: 1 },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 700,
      },
      {
        id: "audit-demo-showcase-embed-activated",
        actor: DEMO_IDENTITIES.owner.personId,
        action: "programme_embed.activated",
        table: "programme_embeds",
        entityType: "programme_embed",
        entityId: DEMO_SHOWCASE_EMBED_ID,
        metadata: { status: "active", revision: 2 },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 650,
      },
    ].map((audit) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, metadata_json,
           created_at
         )
         SELECT ?, 'person', 'internal', 1, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM ${audit.table} entity WHERE entity.id = ?)`,
      ).bind(
        audit.id,
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        audit.actor,
        audit.action,
        audit.entityType,
        audit.entityId,
        JSON.stringify(audit.metadata),
        audit.timestamp,
        audit.entityId,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO people (id, email, display_name, profile_status)
       SELECT 'demo-showcase-incomplete-sentinel', NULL, 'Invalid fixture', 'draft'
        WHERE (SELECT COUNT(*) FROM reviews
                WHERE id IN (?, ?) AND event_id = ? AND status = 'submitted') <> 2
           OR NOT EXISTS (
                SELECT 1 FROM evaluator_assignments
                 WHERE id = ? AND event_id = ? AND round_id = ?
                   AND submission_id = ? AND evaluator_person_id = ?
                   AND status = 'submitted' AND revision = 2
                   AND last_operation_id = 'demo-showcase:critical-review'
              )
           OR (SELECT COUNT(*)
                 FROM review_revisions revision
                 JOIN reviews review
                   ON review.id = revision.review_id
                  AND review.event_id = revision.event_id
                WHERE revision.review_id IN (?, ?) AND revision.event_id = ?
                  AND revision.save_kind = 'submitted'
                  AND json_array_length(revision.criteria_snapshot_json) = 4
                  AND revision.scores_json = review.scores_json
                  AND json_extract(revision.content_json, '$.recommendation') = review.recommendation) <> 2
           OR NOT EXISTS (
                SELECT 1 FROM evaluation_discussion_messages WHERE id = ? AND event_id = ?
              )
           OR NOT EXISTS (
                SELECT 1 FROM submission_decisions
                 WHERE id = ? AND event_id = ? AND status = 'published'
              )
           OR NOT EXISTS (
                SELECT 1 FROM speaker_profile_revisions WHERE id = ? AND event_id = ?
              )
           OR NOT EXISTS (
                SELECT 1 FROM programme_embeds
                 WHERE id = ? AND event_id = ? AND status = 'active'
              )
           OR (SELECT COUNT(*) FROM audit_events
                WHERE id IN (
                  'audit-demo-showcase-review-positive',
                  'audit-demo-showcase-review-critical',
                  'audit-demo-showcase-discussion',
                  'audit-demo-showcase-decision',
                  'audit-demo-showcase-profile-revision',
                  'audit-demo-showcase-embed-created',
                  'audit-demo-showcase-embed-activated'
                ) AND event_id = ?) <> 7`,
    ).bind(
      DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
      DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_CHAIR_ASSIGNMENT_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_IDENTITIES.committee_chair.personId,
      DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
      DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_DISCUSSION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_DECISION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_PROFILE_REVISION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_EMBED_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
    ),
  ]);
}

async function seedJudgedDemoWorkflow(env: CloudflareEnvironment) {
  const emailProvider = requireEmailProviderConfiguration(env);
  await ensureDemoData(env);
  await ensureDemoSubmissionForm(env);
  await ensureDemoEvaluationData(env);
  await ensureDemoSpeakerData(env);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO sender_profiles (
         id, event_id, name, from_name, from_email, reply_to_email,
         provider, status, created_at, updated_at
       ) VALUES (?, ?, 'Demo decision notifications', 'Program Cue Demo',
                 'notifications@example.invalid', 'notifications@example.invalid',
                 ?, 'verified', unixepoch(), unixepoch())`,
    ).bind(DEMO_DECISION_SENDER_ID, DEMO_EVENT_ID, emailProvider.provider),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Speaker task reminder', 'task_reminder', 'active', ?,
                 ?, ?)`,
    ).bind(
      DEMO_REMINDER_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP + 1,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Speaker task reminder', 'task_reminder', 'email',
         'Reminder: {{task.title}} is due {{task.dueDate}}', ?, NULL, 'published', ?,
         unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_REMINDER_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_REMINDER_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nPlease complete {{task.title}} for {{event.name}} by {{task.dueDate}}.",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Reviewer reminder', 'ad_hoc', 'active', ?,
                 ?, ?)`,
    ).bind(
      DEMO_REVIEWER_REMINDER_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Reviewer reminder', 'ad_hoc', 'email',
         'Reviews awaiting your attention for {{event.name}}', ?, NULL,
         'published', ?, unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_REVIEWER_REMINDER_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_REVIEWER_REMINDER_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nYou have outstanding review assignments for {{event.name}}. Please return to your reviewer workspace to complete them.",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Speaker welcome', 'ad_hoc', 'active', ?, ?, ?)`,
    ).bind(
      DEMO_SPEAKER_WELCOME_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP + 2,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Speaker welcome', 'ad_hoc', 'email',
         'Welcome to {{event.name}} speakers', ?, NULL, 'published', ?,
         unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_SPEAKER_WELCOME_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_SPEAKER_WELCOME_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nWelcome to {{event.name}}. Your speaker workspace is ready.",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Submission confirmation', 'submission_confirmation',
                 'active', ?, ?, ?)`,
    ).bind(
      DEMO_SUBMISSION_CONFIRMATION_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Submission confirmation', 'submission_confirmation',
         'email', 'We received {{submission.title}}', ?, NULL, 'published', ?,
         unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_SUBMISSION_CONFIRMATION_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_SUBMISSION_CONFIRMATION_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nWe received {{submission.title}} for {{event.name}}. You can return to your application workspace at any time to review its status.",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Proposal decision', 'decision', 'active', ?, ?, ?)`,
    ).bind(
      DEMO_DECISION_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Proposal decision', 'decision', 'email',
         'Decision for {{submission.title}}', ?, NULL, 'published', ?,
         unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_DECISION_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_DECISION_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nThe decision for {{submission.title}} is {{decision.outcome}}.\n\n{{decision.rationale}}\n\n{{decision.feedback}}",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
  ]);
  await ensureDemoProgramme(env);
  await seedShowcaseCohort(env);
}

export type DemoBaselineEvidence = {
  forms: number;
  submissions: number;
  assignments: number;
  tasks: number;
  sessions: number;
  publishedSchedules: number;
  canonicalEventConfiguration: number;
  canonicalOrganisationMemberships: number;
  publishedTemplates: number;
  verifiedDecisionSenders: number;
  showcaseMemberships: number;
  showcaseReviewerAssignments: number;
  showcaseApplicantSubmissions: number;
  showcaseSpeakerTasks: number;
  showcaseCompletedReviews: number;
  showcaseReviewScoreSpread: number;
  showcaseDiscussionMessages: number;
  showcasePublishedDecisions: number;
  showcaseProfileRevisions: number;
  showcaseManagedEmbeds: number;
  sbekPeople: number;
  sbekReviewerMemberships: number;
  sbekReviewerAssignments: number;
  sbekSpeakerMemberships: number;
  sbekSpeakerTasks: number;
  sbekFixtureSubmissions: number;
  sbekApplicantMemberships: number;
};

export function demoBaselineIsComplete(evidence: DemoBaselineEvidence) {
  return (
    evidence.forms >= 2 &&
    evidence.submissions >= 2 &&
    evidence.assignments >= 2 &&
    evidence.tasks >= 3 &&
    evidence.sessions >= 6 &&
    evidence.publishedSchedules === 1 &&
    evidence.canonicalEventConfiguration === 1 &&
    evidence.canonicalOrganisationMemberships === 1 &&
    evidence.publishedTemplates === 5 &&
    evidence.verifiedDecisionSenders === 1 &&
    evidence.showcaseMemberships === 6 &&
    evidence.showcaseReviewerAssignments >= 1 &&
    evidence.showcaseApplicantSubmissions >= 1 &&
    evidence.showcaseSpeakerTasks >= 1 &&
    evidence.showcaseCompletedReviews === 2 &&
    evidence.showcaseReviewScoreSpread === 1 &&
    evidence.showcaseDiscussionMessages === 1 &&
    evidence.showcasePublishedDecisions === 1 &&
    evidence.showcaseProfileRevisions === 1 &&
    evidence.showcaseManagedEmbeds === 1 &&
    evidence.sbekPeople === 4 &&
    evidence.sbekReviewerMemberships === 0 &&
    evidence.sbekReviewerAssignments === 0 &&
    evidence.sbekSpeakerMemberships === 0 &&
    evidence.sbekSpeakerTasks === 0 &&
    evidence.sbekFixtureSubmissions === 0 &&
    evidence.sbekApplicantMemberships === 0
  );
}

async function baselineEvidence(env: CloudflareEnvironment) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM form_definitions WHERE event_id = ?) AS forms,
       (SELECT COUNT(*) FROM submissions WHERE event_id = ?) AS submissions,
       (SELECT COUNT(*) FROM evaluator_assignments WHERE event_id = ?) AS assignments,
       (SELECT COUNT(*) FROM task_instances WHERE event_id = ?) AS tasks,
       (SELECT COUNT(*) FROM sessions WHERE event_id = ?) AS sessions,
       (SELECT COUNT(*) FROM schedule_versions WHERE event_id = ? AND status = 'published') AS publishedSchedules,
       (SELECT COUNT(*) FROM events
         WHERE id = ? AND organisation_id = ? AND activation_status = 'active'
           AND participant_logo_url IS NULL
           AND participant_welcome_text IS NULL
           AND participant_support_url IS NULL
           AND venue_address = ?
           AND venue_map_url = ?
           AND programme_hero_image_url IS NULL
           AND brand_logo_asset_id IS NULL
           AND brand_banner_asset_id IS NULL
           AND brand_accent = ?
           AND brand_draft_accent = ?
           AND brand_draft_logo_asset_id IS NULL
           AND brand_draft_banner_asset_id IS NULL
           AND brand_draft_welcome_text IS NULL
           AND brand_draft_support_url IS NULL
           AND brand_draft_revision = 1
           AND brand_published_revision = 1
           AND session_formats_json = ?
           AND file_policy_json = ?
           AND participant_retention_completed_at IS NULL) AS canonicalEventConfiguration,
       (SELECT COUNT(*) FROM memberships membership
         WHERE membership.id = 'membership-demo-owner'
           AND membership.organisation_id = ? AND membership.event_id IS NULL
           AND membership.person_id = ? AND membership.role = 'owner'
           AND membership.accepted_at IS NOT NULL
           AND membership.revoked_at IS NULL
           AND (SELECT COUNT(*) FROM memberships
                 WHERE organisation_id = ? AND event_id IS NULL) = 1) AS canonicalOrganisationMemberships,
       (SELECT COUNT(*)
          FROM communication_template_versions version
          JOIN communication_templates template
            ON template.id = version.template_id
           AND template.event_id = version.event_id
         WHERE version.event_id = ?
           AND template.status = 'active'
           AND version.status = 'published'
           AND (
             (template.id = ?
               AND template.name = 'Speaker task reminder'
               AND template.category = 'task_reminder'
               AND version.id = ?
               AND version.name = 'Speaker task reminder'
               AND version.category = 'task_reminder'
               AND version.channel = 'email')
             OR
             (template.id = ?
               AND template.name = 'Reviewer reminder'
               AND template.category = 'ad_hoc'
               AND version.id = ?
               AND version.name = 'Reviewer reminder'
               AND version.category = 'ad_hoc'
               AND version.channel = 'email')
             OR
             (template.id = ?
               AND template.name = 'Speaker welcome'
               AND template.category = 'ad_hoc'
               AND version.id = ?
               AND version.name = 'Speaker welcome'
               AND version.category = 'ad_hoc'
               AND version.channel = 'email')
             OR
             (template.id = ?
               AND template.name = 'Submission confirmation'
               AND template.category = 'submission_confirmation'
               AND version.id = ?
               AND version.name = 'Submission confirmation'
               AND version.category = 'submission_confirmation'
               AND version.channel = 'email')
             OR
             (template.id = ?
               AND template.name = 'Proposal decision'
               AND template.category = 'decision'
               AND version.id = ?
               AND version.name = 'Proposal decision'
               AND version.category = 'decision'
               AND version.channel = 'email')
           )) AS publishedTemplates,
       (SELECT COUNT(*) FROM people person
         WHERE person.id IN (?, ?, ?, ?, ?, ?)
           AND EXISTS (
             SELECT 1 FROM memberships membership
              WHERE membership.person_id = person.id
                AND membership.organisation_id = ?
                AND (membership.event_id = ? OR membership.event_id IS NULL)
                AND membership.accepted_at IS NOT NULL
                AND membership.revoked_at IS NULL
           )) AS showcaseMemberships,
       (SELECT COUNT(*) FROM evaluator_assignments
         WHERE event_id = ? AND evaluator_person_id = ?) AS showcaseReviewerAssignments,
       (SELECT COUNT(*) FROM submissions
         WHERE event_id = ? AND submitter_person_id = ?) AS showcaseApplicantSubmissions,
       (SELECT COUNT(*) FROM task_instances
         WHERE event_id = ? AND owner_person_id = ?) AS showcaseSpeakerTasks,
       (SELECT COUNT(*)
          FROM reviews review
          JOIN evaluator_assignments assignment
            ON assignment.id = review.assignment_id
           AND assignment.event_id = review.event_id
         WHERE review.event_id = ?
           AND review.id IN (?, ?)
           AND review.status = 'submitted'
           AND assignment.submission_id = ?
           AND assignment.status = 'submitted' AND assignment.revision = 2
           AND review.locked_at IS NOT NULL) AS showcaseCompletedReviews,
       (SELECT CASE
          WHEN COUNT(*) = 2
           AND MIN(review.weighted_score) = 2.25
           AND MAX(review.weighted_score) = 4.55
          THEN 1 ELSE 0 END
          FROM reviews review
         WHERE review.event_id = ? AND review.id IN (?, ?)
           AND review.status = 'submitted') AS showcaseReviewScoreSpread,
       (SELECT COUNT(*) FROM evaluation_discussion_messages message
         WHERE message.id = ? AND message.event_id = ?
           AND message.round_id = ? AND message.submission_id = ?
           AND message.session_id IS NULL AND message.author_person_id = ?
           AND length(trim(message.body)) > 0) AS showcaseDiscussionMessages,
       (SELECT COUNT(*) FROM submission_decisions decision
         JOIN submissions submission
           ON submission.id = decision.submission_id
          AND submission.event_id = decision.event_id
         WHERE decision.id = ? AND decision.event_id = ?
           AND decision.submission_id = ? AND decision.round_id = ?
           AND decision.status = 'published' AND decision.decision = 'waitlisted'
           AND decision.decided_by_person_id = 'person-demo-owner'
           AND decision.published_at IS NOT NULL
           AND submission.status = 'waitlisted' AND submission.revision = 3
           AND submission.last_operation_id = decision.id) AS showcasePublishedDecisions,
       (SELECT COUNT(*) FROM speaker_profile_revisions revision
         JOIN people person ON person.id = revision.person_id
         WHERE revision.id = ? AND revision.organisation_id = ?
           AND revision.event_id = ? AND revision.person_id = ?
           AND revision.source = 'canonical_person'
           AND revision.profile_revision = 1
           AND revision.recorded_by_person_id = 'person-demo-owner'
           AND person.profile_revision = 2) AS showcaseProfileRevisions,
       (SELECT COUNT(*) FROM programme_embeds embed
         WHERE embed.id = ? AND embed.organisation_id = ? AND embed.event_id = ?
           AND embed.name = 'Main website agenda' AND embed.slug = 'main-agenda'
           AND embed.status = 'active' AND embed.revision = 2
           AND embed.created_by_person_id = 'person-demo-owner'
           AND embed.updated_by_person_id = 'person-demo-owner'
           AND json_extract(embed.configuration_json, '$.surface') = 'schedule'
           AND json_extract(embed.configuration_json, '$.density') = 'compact') AS showcaseManagedEmbeds,
       (SELECT COUNT(*) FROM people
         WHERE (id = ? AND email = ? COLLATE NOCASE AND display_name = ? AND profile_status = ?)
            OR (id = ? AND email = ? COLLATE NOCASE AND display_name = ? AND profile_status = ?)
            OR (id = ? AND email = ? COLLATE NOCASE AND display_name = ? AND profile_status = ?)
            OR (id = ? AND email = ? COLLATE NOCASE AND display_name = ? AND profile_status = ?)) AS sbekPeople,
       (SELECT COUNT(*) FROM memberships
         WHERE event_id = ? AND person_id = ? AND role = 'evaluator') AS sbekReviewerMemberships,
       (SELECT COUNT(*) FROM evaluator_assignments
         WHERE event_id = ? AND evaluator_person_id = ?) AS sbekReviewerAssignments,
       (SELECT COUNT(*) FROM memberships
         WHERE event_id = ? AND person_id IN (?, ?) AND role = 'speaker') AS sbekSpeakerMemberships,
       (SELECT COUNT(*) FROM task_instances
         WHERE event_id = ? AND owner_person_id IN (?, ?)) AS sbekSpeakerTasks,
       (SELECT COUNT(*) FROM submissions submission
         WHERE submission.event_id = ?
           AND (
             submission.submitter_person_id IN (?, ?)
             OR submission.submitter_email COLLATE NOCASE IN (?, ?)
             OR EXISTS (
               SELECT 1 FROM submission_speakers speaker
                WHERE speaker.event_id = submission.event_id
                  AND speaker.submission_id = submission.id
                  AND (
                    speaker.person_id IN (?, ?)
                    OR speaker.email COLLATE NOCASE IN (?, ?)
                  )
             )
           )) AS sbekFixtureSubmissions,
       (SELECT COUNT(*) FROM memberships
         WHERE id = 'membership-production-evaluation-applicant-event') AS sbekApplicantMemberships`,
  )
    .bind(
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      DEMO_VENUE_ADDRESS,
      DEMO_VENUE_MAP_URL,
      DEFAULT_EVENT_BRAND_ACCENT,
      DEFAULT_EVENT_BRAND_ACCENT,
      INITIAL_EVENT_SESSION_FORMATS_JSON,
      CANONICAL_EVENT_FILE_POLICY_JSON,
      DEMO_ORGANISATION_ID,
      DEMO_IDENTITIES.owner.personId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_REMINDER_TEMPLATE_ID,
      DEMO_REMINDER_VERSION_ID,
      DEMO_REVIEWER_REMINDER_TEMPLATE_ID,
      DEMO_REVIEWER_REMINDER_VERSION_ID,
      DEMO_SPEAKER_WELCOME_TEMPLATE_ID,
      DEMO_SPEAKER_WELCOME_VERSION_ID,
      DEMO_SUBMISSION_CONFIRMATION_TEMPLATE_ID,
      DEMO_SUBMISSION_CONFIRMATION_VERSION_ID,
      DEMO_DECISION_TEMPLATE_ID,
      DEMO_DECISION_VERSION_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_IDENTITIES.owner.personId,
      DEMO_IDENTITIES.committee_chair.personId,
      DEMO_IDENTITIES.evaluator.personId,
      DEMO_IDENTITIES.submitter.personId,
      DEMO_IDENTITIES.speaker.personId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.evaluator.personId,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.submitter.personId,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.speaker.personId,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
      DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
      DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
      DEMO_SHOWCASE_DISCUSSION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_IDENTITIES.committee_chair.personId,
      DEMO_SHOWCASE_DECISION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_SHOWCASE_PROFILE_REVISION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.speaker.personId,
      DEMO_SHOWCASE_EMBED_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      ...Object.values(SBEK_FIXTURE_PEOPLE).flatMap((identity) => [
        identity.personId,
        identity.email,
        identity.name,
        identity.profileStatus,
      ]),
      DEMO_EVENT_ID,
      SBEK_FIXTURE_PEOPLE.reviewer.personId,
      DEMO_EVENT_ID,
      SBEK_FIXTURE_PEOPLE.reviewer.personId,
      DEMO_EVENT_ID,
      SBEK_FIXTURE_PEOPLE.speaker.personId,
      SBEK_FIXTURE_PEOPLE.speaker2.personId,
      DEMO_EVENT_ID,
      SBEK_FIXTURE_PEOPLE.speaker.personId,
      SBEK_FIXTURE_PEOPLE.speaker2.personId,
      DEMO_EVENT_ID,
      SBEK_FIXTURE_PEOPLE.speaker.personId,
      SBEK_FIXTURE_PEOPLE.speaker2.personId,
      SBEK_FIXTURE_PEOPLE.speaker.email,
      SBEK_FIXTURE_PEOPLE.speaker2.email,
      SBEK_FIXTURE_PEOPLE.speaker.personId,
      SBEK_FIXTURE_PEOPLE.speaker2.personId,
      SBEK_FIXTURE_PEOPLE.speaker.email,
      SBEK_FIXTURE_PEOPLE.speaker2.email,
    )
    .first<DemoBaselineEvidence>();
  if (!row)
    throw new Error("The restored demo baseline could not be verified.");
  const sender = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM sender_profiles
      WHERE id = ? AND event_id = ? AND provider = ? AND status = 'verified'
        AND from_email = 'notifications@example.invalid'`,
  )
    .bind(
      DEMO_DECISION_SENDER_ID,
      DEMO_EVENT_ID,
      requireEmailProviderConfiguration(env).provider,
    )
    .first<{ count: number }>();
  const evidence = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as DemoBaselineEvidence;
  evidence.verifiedDecisionSenders = Number(sender?.count ?? 0);
  return evidence;
}

export async function ensureJudgedDemoWorkflow(env: CloudflareEnvironment) {
  assertDemoRuntime(env);
  await seedJudgedDemoWorkflow(env);
  const evidence = await baselineEvidence(env);
  if (!demoBaselineIsComplete(evidence)) {
    throw new Error("The restored demo baseline is incomplete.");
  }
  return evidence;
}

export async function prepareJudgedDemoWorkflow(env: CloudflareEnvironment) {
  assertDemoRuntime(env);
  await seedJudgedDemoWorkflow(env);
  const evidence = await baselineEvidence(env);
  return { evidence, complete: demoBaselineIsComplete(evidence) };
}

/**
 * Empty only the demo evaluation graph so a browser acceptance workflow can
 * create its own protected plan through the real administration route. This
 * is deliberately separate from the canonical reset, which restores the
 * judged baseline used by the evaluator guide.
 */
export async function clearDemoEvaluationWorkflow(
  env: CloudflareEnvironment,
  confirmation: unknown,
) {
  assertDemoRuntime(env);
  if (confirmation !== DEMO_EVALUATION_RESET_CONFIRMATION) {
    throw new DemoResetConfirmationError();
  }
  await env.DB.batch(
    [
      "submission_decisions",
      "ai_review_assessments",
      "review_moderations",
      "review_revisions",
      "evaluation_discussion_messages",
      "reviews",
      "reviewer_ai_suggestions",
      "event_ai_review_settings",
      "evaluator_conflicts",
      "evaluator_assignments",
      "evaluation_criteria",
      "evaluation_round_reviewers",
      "evaluation_team_members",
      "evaluation_rounds",
      "evaluation_teams",
      "evaluation_plans",
    ].map((table) =>
      env.DB.prepare(`DELETE FROM ${table} WHERE event_id = ?`).bind(
        DEMO_EVENT_ID,
      ),
    ),
  );
  return { cleared: true };
}

export async function resetDemoEvent(
  env: CloudflareEnvironment,
  actorPersonId: string | null,
  confirmation: unknown,
  actorId: string | null = null,
  beforeDestructiveWork: (() => Promise<void>) | null = null,
  assertDestructiveWorkAllowed: (() => Promise<void>) | null = null,
) {
  assertDemoRuntime(env);
  if (confirmation !== DEMO_RESET_CONFIRMATION) {
    throw new DemoResetConfirmationError();
  }
  if (!env.FILES) {
    throw new Error("Required Cloudflare binding FILES is unavailable.");
  }
  requireEmailProviderConfiguration(env);
  const assertRetentionIncomplete = async () => {
    const event = await env.DB.prepare(
      `SELECT participant_retention_completed_at AS completedAt
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(DEMO_EVENT_ID, DEMO_ORGANISATION_ID)
      .first<{ completedAt: number | null }>();
    if (event?.completedAt !== null && event?.completedAt !== undefined) {
      throw new DemoResetRetentionError();
    }
  };
  await assertRetentionIncomplete();
  const initialActiveWork = await readDemoActiveWork(env);
  if (activeWorkTotal(initialActiveWork) > 0) {
    throw new DemoResetBusyError(initialActiveWork);
  }
  await assertDestructiveWorkAllowed?.();
  await ensureDemoData(env);
  await assertDestructiveWorkAllowed?.();
  await assertRetentionIncomplete();
  const activeWork = await readDemoActiveWork(env);
  if (activeWorkTotal(activeWork) > 0) throw new DemoResetBusyError(activeWork);
  const preservedAuditEvents = Number(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE event_id = ?",
      )
        .bind(DEMO_EVENT_ID)
        .first<{ count: number }>()
    )?.count ?? 0,
  );
  await beforeDestructiveWork?.();
  await assertDestructiveWorkAllowed?.();
  const supersededAssistantFixtureProposals =
    await supersedeDemoAssistantFixtureProposals(env);

  const forms = await env.DB.prepare(
    "SELECT id FROM form_definitions WHERE event_id = ?",
  )
    .bind(DEMO_EVENT_ID)
    .all<{ id: string }>();
  const tokenStatements = forms.results.flatMap(({ id }) =>
    [
      `application-session:${id}:`,
      `anonymous-application-session:${id}:`,
      `co-speaker-claim:${id}:`,
    ].map((prefix) =>
      env.DB.prepare(
        "DELETE FROM verification_tokens WHERE substr(identifier, 1, length(?)) = ?",
      ).bind(prefix, prefix),
    ),
  );
  const cleanup = DEMO_RESET_EVENT_TABLES.map((table) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE event_id = ?`).bind(
      DEMO_EVENT_ID,
    ),
  );
  const organisationCrmCleanup = [
    "crm_pipeline_activity",
    "crm_pipeline_entries",
    "organisation_contact_notes",
    "organisation_contact_tags",
    "crm_segments",
    "organisation_contacts",
  ].map((table) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE organisation_id = ?`).bind(
      DEMO_ORGANISATION_ID,
    ),
  );
  await assertDestructiveWorkAllowed?.();
  await env.DB.batch([
    ...tokenStatements,
    ...organisationCrmCleanup,
    env.DB.prepare(
      "DELETE FROM memberships WHERE organisation_id = ? AND event_id IS NULL",
    ).bind(DEMO_ORGANISATION_ID),
    env.DB.prepare(
      `UPDATE events
          SET brand_logo_asset_id = NULL, brand_banner_asset_id = NULL,
              brand_draft_logo_asset_id = NULL,
              brand_draft_banner_asset_id = NULL
        WHERE id = ? AND organisation_id = ?`,
    ).bind(DEMO_EVENT_ID, DEMO_ORGANISATION_ID),
    ...cleanup,
  ]);

  let objectCount = 0;
  let objectCleanupError: unknown = null;
  try {
    objectCount = await clearDemoObjects(
      env.FILES,
      assertDestructiveWorkAllowed,
    );
  } catch (error) {
    objectCleanupError = error;
  }

  await assertDestructiveWorkAllowed?.();
  await resetMutableIdentity(env);
  await assertDestructiveWorkAllowed?.();
  await seedJudgedDemoWorkflow(env);
  const baseline = await baselineEvidence(env);
  if (!demoBaselineIsComplete(baseline)) {
    throw new Error("The restored demo baseline is incomplete.");
  }
  await assertDestructiveWorkAllowed?.();
  await env.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, CASE WHEN ? IS NULL THEN 'system' ELSE 'person' END, 'internal', 1, ?, ?, ?, ?, 'demo.reset', 'event', ?, ?, unixepoch())`,
  )
    .bind(
      crypto.randomUUID(),
      actorPersonId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      actorPersonId,
      actorId,
      DEMO_EVENT_ID,
      JSON.stringify({
        objectCount,
        preservedAuditEvents,
        supersededAssistantFixtureProposals,
        baseline,
      }),
    )
    .run();

  if (objectCleanupError) throw new DemoResetStorageError(objectCleanupError);
  return {
    objectCount,
    preservedAuditEvents,
    supersededAssistantFixtureProposals,
    baseline,
  };
}
