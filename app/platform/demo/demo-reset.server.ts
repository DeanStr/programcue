import { DEFAULT_EVENT_BRAND_ACCENT } from "~/lib/brand";
import { requireEmailProviderConfiguration } from "~/modules/communications/email-provider.server";
import { INITIAL_EVENT_SESSION_FORMATS_JSON } from "~/modules/events/event-configuration";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import {
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
import { seedJudgedDemoWorkflow } from "~/platform/demo/demo-judged-workflow-seed.server";
import {
  DEMO_DECISION_SENDER_ID,
  DEMO_DECISION_TEMPLATE_ID,
  DEMO_DECISION_VERSION_ID,
  DEMO_EVALUATION_RESET_CONFIRMATION,
  DEMO_REMINDER_TEMPLATE_ID,
  DEMO_REMINDER_VERSION_ID,
  DEMO_REVIEWER_REMINDER_TEMPLATE_ID,
  DEMO_REVIEWER_REMINDER_VERSION_ID,
  DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
  DEMO_SHOWCASE_DECISION_ID,
  DEMO_SHOWCASE_DISCUSSION_ID,
  DEMO_SHOWCASE_EMBED_ID,
  DEMO_SHOWCASE_ENABLED_PAGES,
  DEMO_SHOWCASE_FAQ_ITEMS,
  DEMO_SHOWCASE_FEATURED_SESSION_IDS,
  DEMO_SHOWCASE_FEATURED_SPEAKER_IDS,
  DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
  DEMO_SHOWCASE_PROFILE_REVISION_ID,
  DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
  DEMO_SHOWCASE_PUBLIC_SITE_TAGLINE,
  DEMO_SHOWCASE_ROUND_ID,
  DEMO_SHOWCASE_SITE_SPONSORS,
  DEMO_SHOWCASE_SUBMISSION_ID,
  DEMO_SPEAKER_WELCOME_TEMPLATE_ID,
  DEMO_SPEAKER_WELCOME_VERSION_ID,
  DEMO_SUBMISSION_CONFIRMATION_TEMPLATE_ID,
  DEMO_SUBMISSION_CONFIRMATION_VERSION_ID,
} from "~/platform/demo/demo-reset-fixtures";
import { ensureDemoData } from "~/platform/demo/seed.server";
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
  "event_public_site_references",
  "event_session_recordings",
  "event_site_sponsors",
  "event_public_sites",
  "programme_embeds",
  "public_itineraries",
  "schedule_review_links",
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
  "speaker_blackout_windows",
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
       ((SELECT COUNT(*) FROM operation_jobs
          WHERE event_id = ? AND status IN ('queued','received','running','retrying')
            AND (
              status <> 'running'
              OR type NOT IN ('ai.assistant.run','ai.context.run','ai.proposal.revision')
              OR claim_token IS NULL
              OR claim_expires_at IS NULL
              OR claim_expires_at > unixepoch()
            ))
        +
        (SELECT COUNT(*) FROM assistant_proposal_executions
          WHERE event_id = ? AND status = 'processing'
            AND claim_token IS NOT NULL
            AND claim_expires_at > unixepoch())) AS operations,
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

// Proposal previews are append-only audit records, so resetting their mutable
// event data cannot remove them. Append the assistant's terminal marker to
// every still-actionable proposal, regardless of which provider created it.
async function supersedeDemoAssistantProposals(env: CloudflareEnvironment) {
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
              'reason', 'demo_event_reset'
            ),
            unixepoch()
       FROM audit_events proposal
      WHERE proposal.organisation_id = ? AND proposal.event_id = ?
        AND proposal.action = 'assistant.proposal.previewed'
        AND proposal.entity_type = 'assistant_proposal'
        AND proposal.entity_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM audit_events terminal
           WHERE terminal.event_id = proposal.event_id
             AND (
               (terminal.action = 'assistant.proposal.superseded'
                 AND terminal.entity_type = 'assistant_proposal'
                 AND terminal.entity_id = proposal.entity_id)
               OR
               (terminal.action = 'assistant.action.executed'
                 AND json_extract(terminal.metadata_json, '$.proposalId') =
                     proposal.entity_id)
             )
        )`,
  )
    .bind(DEMO_ORGANISATION_ID, DEMO_EVENT_ID)
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
  showcasePublishedPublicSites: number;
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
    evidence.showcasePublishedPublicSites === 1 &&
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
  const publishedSite = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM event_public_sites site
      WHERE site.event_id = ? AND site.organisation_id = ?
        AND site.draft_revision = 1 AND site.published_revision = 1
        AND site.published_at IS NOT NULL
        AND site.last_operation_id = ?
        AND json_extract(site.draft_json, '$.theme') = 'light'
        AND json_extract(site.draft_json, '$.tagline') = ?
        AND json_extract(site.draft_json, '$.sectionVisibility.faq') = 0
        AND json_extract(site.published_json, '$.sectionVisibility.faq') = 0
        ${DEMO_SHOWCASE_ENABLED_PAGES.map(
          () => "AND json_extract(site.draft_json, ?) = 1",
        ).join("\n        ")}
        AND json_array_length(json_extract(site.draft_json, '$.featuredSessionIds')) = ?
        AND json_array_length(json_extract(site.draft_json, '$.featuredSpeakerIds')) = ?
        AND json_array_length(json_extract(site.draft_json, '$.faqItems')) = ?
        AND json_array_length(json_extract(site.published_json, '$.sponsors')) = ?
        AND (SELECT COUNT(*) FROM event_public_site_references reference
              WHERE reference.event_id = site.event_id
                AND reference.site_revision = site.published_revision
                AND (
                  (reference.kind = 'session' AND reference.record_id IN (${DEMO_SHOWCASE_FEATURED_SESSION_IDS.map(() => "?").join(", ")}))
                  OR (reference.kind = 'speaker' AND reference.record_id IN (${DEMO_SHOWCASE_FEATURED_SPEAKER_IDS.map(() => "?").join(", ")}))
                )) = ?
        AND (SELECT COUNT(*) FROM event_site_sponsors sponsor
              WHERE sponsor.event_id = site.event_id
                AND sponsor.id IN (${DEMO_SHOWCASE_SITE_SPONSORS.map(() => "?").join(", ")})) = ?
        AND EXISTS (
              SELECT 1 FROM event_changes change
               WHERE change.event_id = site.event_id
                 AND change.entity_type = 'public_site'
                 AND change.entity_id = site.event_id
                 AND change.change_type = 'published'
                 AND change.correlation_id = site.last_operation_id
            )`,
  )
    .bind(
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
      DEMO_SHOWCASE_PUBLIC_SITE_TAGLINE,
      ...DEMO_SHOWCASE_ENABLED_PAGES.map((page) => `$.pages."${page}".enabled`),
      DEMO_SHOWCASE_FEATURED_SESSION_IDS.length,
      DEMO_SHOWCASE_FEATURED_SPEAKER_IDS.length,
      DEMO_SHOWCASE_FAQ_ITEMS.length,
      DEMO_SHOWCASE_SITE_SPONSORS.length,
      ...DEMO_SHOWCASE_FEATURED_SESSION_IDS,
      ...DEMO_SHOWCASE_FEATURED_SPEAKER_IDS,
      DEMO_SHOWCASE_FEATURED_SESSION_IDS.length +
        DEMO_SHOWCASE_FEATURED_SPEAKER_IDS.length,
      ...DEMO_SHOWCASE_SITE_SPONSORS.map((sponsor) => sponsor.id),
      DEMO_SHOWCASE_SITE_SPONSORS.length,
    )
    .first<{ count: number }>();
  const evidence = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as DemoBaselineEvidence;
  evidence.verifiedDecisionSenders = Number(sender?.count ?? 0);
  evidence.showcasePublishedPublicSites = Number(publishedSite?.count ?? 0);
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
  const supersededAssistantProposals =
    await supersedeDemoAssistantProposals(env);

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
        supersededAssistantProposals,
        baseline,
      }),
    )
    .run();

  if (objectCleanupError) throw new DemoResetStorageError(objectCleanupError);
  return {
    objectCount,
    preservedAuditEvents,
    supersededAssistantProposals,
    baseline,
  };
}
