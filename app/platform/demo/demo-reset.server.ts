import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
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
  "schedule_session_contents",
  "schedule_versions",
  "session_tags",
  "session_archives",
  "session_speakers",
  "sessions",
  "tags",
  "rooms",
  "tracks",
  "schedule_policies",
  "submission_decisions",
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

const DEMO_REMINDER_TEMPLATE_ID = "4eb07b55-60fe-4fd4-aab5-56a171283335";
const DEMO_REMINDER_VERSION_ID = "c4be71b7-cf55-4e8a-ac28-73f2c83bde42";

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

async function clearDemoObjects(bucket: R2Bucket) {
  let deleted = 0;
  while (true) {
    const page = await bucket.list({ prefix: DEMO_R2_PREFIX, limit: 1_000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length === 0) return deleted;
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
  const identities = Object.values(DEMO_IDENTITIES);
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
              brand_accent = '#4f46e5', repository_provider = 'd1',
              repository_locked_at = NULL, retention_months = 24,
              file_retention_hold_at = NULL,
              submission_access_mode = 'email_verified',
              allow_anonymous_drafts = 1, duplicate_person_warnings = 1,
              revision = 1, last_operation_id = NULL,
              last_updated_by_person_id = ?, programme_published_at = NULL,
              updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ?`,
    ).bind(
      DEMO_IDENTITIES.administrator.personId,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
    ),
    env.DB.prepare(`INSERT INTO schedule_policies (event_id) VALUES (?)`).bind(
      DEMO_EVENT_ID,
    ),
    ...identities.map((identity) =>
      env.DB.prepare(
        `UPDATE people
            SET email = ?, display_name = ?, email_verified = 1,
                image_url = NULL, biography = NULL, pronunciation = NULL,
                organisation_name = NULL, job_title = NULL,
                profile_status = 'published', profile_revision = 1,
                last_operation_id = NULL, updated_at = unixepoch()
          WHERE id = ?`,
      ).bind(identity.email, identity.name, identity.personId),
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
                 unixepoch(), unixepoch())`,
    ).bind(
      DEMO_REMINDER_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Speaker task reminder', 'task_reminder', 'email',
         'Reminder: {{task.title}}', ?, NULL, 'published', ?,
         unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_REMINDER_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_REMINDER_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nPlease complete {{task.title}} for {{event.name}}.",
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
  publishedTemplates: number;
};

export function demoBaselineIsComplete(evidence: DemoBaselineEvidence) {
  return (
    evidence.forms >= 2 &&
    evidence.submissions >= 2 &&
    evidence.assignments >= 2 &&
    evidence.tasks >= 3 &&
    evidence.sessions >= 6 &&
    evidence.publishedSchedules === 1 &&
    evidence.publishedTemplates === 1
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
       (SELECT COUNT(*) FROM communication_template_versions
         WHERE event_id = ? AND id = ? AND status = 'published') AS publishedTemplates`,
  )
    .bind(
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_REMINDER_VERSION_ID,
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

export async function resetDemoEvent(
  env: CloudflareEnvironment,
  actorPersonId: string,
  confirmation: unknown,
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
  await ensureDemoData(env);
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
  await env.DB.batch([...tokenStatements, ...cleanup]);

  let objectCount = 0;
  let objectCleanupError: unknown = null;
  try {
    objectCount = await clearDemoObjects(env.FILES);
  } catch (error) {
    objectCleanupError = error;
  }

  await resetMutableIdentity(env);
  await seedJudgedDemoWorkflow(env);
  const baseline = await baselineEvidence(env);
  if (!demoBaselineIsComplete(baseline)) {
    throw new Error("The restored demo baseline is incomplete.");
  }
  await env.DB.prepare(
    `INSERT INTO audit_events (
       id, organisation_id, event_id, actor_person_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, 'demo.reset', 'event', ?, ?, unixepoch())`,
  )
    .bind(
      crypto.randomUUID(),
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      actorPersonId,
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
