import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { INITIAL_EVENT_SESSION_FORMATS_JSON } from "~/modules/events/event-configuration";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import {
  DEMO_EVENT_ID,
  DEMO_ASSISTANT_FIXTURE_MODEL,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
  DEMO_R2_PREFIX,
  DEMO_RESET_CONFIRMATION,
  SBEK_FIXTURE_PEOPLE,
  SBEK_SECOND_SPEAKER,
} from "~/platform/demo/demo-identities";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

export {
  DEMO_EVENT_ID,
  DEMO_ORGANISATION_ID,
  DEMO_R2_PREFIX,
  DEMO_RESET_CONFIRMATION,
} from "~/platform/demo/demo-identities";

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
  "file_multipart_uploads",
  "file_versions",
  "file_assets",
  "task_comments",
  "task_instances",
  "task_templates",
  "public_itineraries",
  "schedule_conflicts",
  "schedule_entries",
  "session_content_revisions",
  "schedule_session_contents",
  "schedule_versions",
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
  "reviews",
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

const DEMO_EVALUATION_RESET_CONFIRMATION = "clear-abstract-evaluation";

export { DEMO_EVALUATION_RESET_CONFIRMATION };

const DEMO_REMINDER_TEMPLATE_ID = "4eb07b55-60fe-4fd4-aab5-56a171283335";
const DEMO_REMINDER_VERSION_ID = "c4be71b7-cf55-4e8a-ac28-73f2c83bde42";
const DEMO_REVIEWER_REMINDER_TEMPLATE_ID =
  "cf82ad49-991e-40dd-896d-7b45b288d16f";
const DEMO_REVIEWER_REMINDER_VERSION_ID =
  "2a37e49b-95ca-4383-8c58-720c2e681bab";
const DEMO_SPEAKER_WELCOME_TEMPLATE_ID = "b5fa9880-c53b-49a9-8d30-dd6585089c41";
const DEMO_SPEAKER_WELCOME_VERSION_ID = "73e3200d-ec06-4d11-a87f-bce1543b7c21";
const DEMO_SUBMISSION_CONFIRMATION_TEMPLATE_ID =
  "353b1640-8e96-4f52-a657-9407ddf551fb";
const DEMO_SUBMISSION_CONFIRMATION_VERSION_ID =
  "7d527639-cf8c-4886-a490-c09d8019310f";
const DEMO_DECISION_TEMPLATE_ID = "572ae193-24e3-4746-b148-4757f54f83bd";
const DEMO_DECISION_VERSION_ID = "95e1b191-434c-4be1-acb8-915f435f561f";
const DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP = Math.floor(
  Date.parse("2025-05-01T12:00:00Z") / 1_000,
);

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
       id, organisation_id, event_id, actor_person_id, action,
       entity_type, entity_id, correlation_id, metadata_json, created_at
     )
     SELECT 'demo-reset-assistant-superseded:' || proposal.entity_id,
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
          SET name = 'Future of Events 2025', slug = 'future-of-events-2025',
              timezone = 'America/Toronto',
              starts_at = unixepoch('2025-05-20T00:00:00Z'),
              ends_at = unixepoch('2025-05-22T23:59:59Z'),
              venue_name = 'Metro Toronto Convention Centre', city = 'Toronto',
              description = 'The conference for modern event professionals.',
              brand_accent = '#4f46e5', participant_logo_url = NULL,
              participant_welcome_text = NULL, participant_support_url = NULL,
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

async function seedJudgedDemoWorkflow(env: CloudflareEnvironment) {
  await ensureDemoData(env);
  await ensureDemoSubmissionForm(env);
  await ensureDemoEvaluationData(env);
  await ensureDemoSpeakerData(env);
  await env.DB.batch([
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
  showcaseMemberships: number;
  showcaseReviewerAssignments: number;
  showcaseApplicantSubmissions: number;
  showcaseSpeakerTasks: number;
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
    evidence.showcaseMemberships === 6 &&
    evidence.showcaseReviewerAssignments >= 1 &&
    evidence.showcaseApplicantSubmissions >= 1 &&
    evidence.showcaseSpeakerTasks >= 1 &&
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
  const evidence = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as typeof row;
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
      "reviews",
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
       id, organisation_id, event_id, actor_person_id, actor_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, 'demo.reset', 'event', ?, ?, unixepoch())`,
  )
    .bind(
      crypto.randomUUID(),
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
