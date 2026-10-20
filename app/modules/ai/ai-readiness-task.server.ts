import { z } from "zod";
import {
  type CommandCentreSnapshot,
  ReadinessService,
} from "~/modules/readiness/readiness-service.server";
import { taskReadinessRelevantSql } from "~/modules/tasks/task-service-foundation.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { AiProposalStateError } from "./ai-assistant-errors";

export class AiReadinessChangedError extends AiProposalStateError {}

const recordSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  href: z.string(),
});
const sourceRecordSchema = recordSchema.extend({
  scopeKey: z.string(),
  covered: z.boolean(),
});
export const readinessTaskContextSchema = z.object({
  blockerKey: z.string(),
  label: z.string(),
  count: z.number().int().nonnegative(),
  taskTarget: z.object({
    targetType: z.literal("event"),
    targetId: z.string(),
    taskType: z.literal("administrator_only"),
  }),
  records: z.array(sourceRecordSchema),
  existingWork: z.array(recordSchema),
  eligibleOwners: z.array(
    z.object({
      personId: z.string(),
      name: z.string(),
      responsibility: z.string(),
    }),
  ),
  sufficient: z.boolean(),
  limitation: z.string().nullable(),
  fingerprint: z.string(),
});
export type ReadinessTaskContext = z.infer<typeof readinessTaskContextSchema>;
// The context is also retained in audit rows and task previews (32K character limit).
const MAX_READINESS_CONTEXT_CHARACTERS = 8_000;

function boundReadinessTaskContext(
  context: Omit<ReadinessTaskContext, "fingerprint">,
) {
  const bounded = {
    ...context,
    records: [] as typeof context.records,
    existingWork: [] as typeof context.existingWork,
    eligibleOwners: [] as typeof context.eligibleOwners,
  };
  let limited = false;
  // Keep owner and existing-work context before adding new supporting records.
  for (const key of ["eligibleOwners", "existingWork", "records"] as const) {
    for (const record of context[key]) {
      (bounded[key] as unknown[]).push(record);
      if (
        JSON.stringify(bounded).length >
        MAX_READINESS_CONTEXT_CHARACTERS - 300
      ) {
        bounded[key].pop();
        limited = true;
        break;
      }
    }
  }
  if (limited) {
    bounded.sufficient = false;
    bounded.limitation =
      "Supporting evidence exceeds the assistant's retained evidence limit. Only a bounded subset is shown; inspect the linked records before proposing work.";
  }
  return bounded;
}

async function fingerprint(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Every branch is scoped through the authorised event. Only fields useful to
// the organiser's decision leave D1; provider credentials never enter evidence.
function blockerRecordsSql(key: string) {
  const task = `SELECT task.id, task.id AS scopeKey, task.title AS label,
    task.status || ' · ' || task.impact || ' · owner ' || COALESCE(task.owner_person_id, 'unassigned') || ' · due ' || COALESCE(task.due_at, 'none') || ' · revision ' || task.revision AS detail,
    '/admin/tasks?task=' || task.id AS href
    FROM task_instances task WHERE task.event_id IN (SELECT id FROM authorised_event)
      AND ${taskReadinessRelevantSql("task")}
      AND task.status IN ('not_started','in_progress','blocked','submitted','overdue')`;
  switch (key) {
    case "overdue_tasks":
      return `${task} AND (task.status = 'overdue' OR task.readiness_state = 'overdue' OR task.due_at < unixepoch())`;
    case "critical_tasks":
      return `${task} AND task.impact = 'critical'`;
    case "due_soon_tasks":
      return `${task} AND task.impact <> 'critical' AND task.due_at BETWEEN unixepoch() AND unixepoch() + 604800`;
    case "speaker_assets":
      return `${task} AND task.target_type = 'speaker' AND task.task_type = 'file_upload'`;
    case "schedule_conflicts":
      return `SELECT id, schedule_version_id || ':' || fingerprint AS scopeKey, conflict_type AS label, details_json AS detail, '/admin/schedule?filter=conflicts' AS href FROM schedule_conflicts WHERE event_id IN (SELECT id FROM authorised_event) AND severity = 'blocking' AND resolved_at IS NULL`;
    case "unscheduled_sessions":
      return `SELECT id, id AS scopeKey, title AS label, status AS detail, '/admin/schedule?session=' || id AS href FROM sessions WHERE event_id IN (SELECT id FROM authorised_event) AND status NOT IN ('cancelled','archived','scheduled','published')`;
    case "unassigned_reviews":
      return `SELECT record.id, record.id AS scopeKey, record.title AS label, record.status AS detail, '/admin/review?submission=' || record.id AS href FROM submissions record WHERE record.event_id IN (SELECT id FROM authorised_event) AND record.status IN ('submitted','assigned','in_review') AND NOT EXISTS (SELECT 1 FROM evaluator_assignments a JOIN evaluation_rounds r ON r.id = a.round_id AND r.event_id = a.event_id JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id WHERE a.event_id = record.event_id AND a.submission_id = record.id AND a.status NOT IN ('cancelled','recused') AND r.status = 'active' AND p.status = 'active')`;
    case "delivery_failures":
      return `SELECT id, id AS scopeKey, COALESCE(recipient_name, 'Communication delivery') AS label, status || ' · ' || COALESCE(failure_code, '') AS detail, '/admin/communications?deliveryCommunication=' || communication_id || '#communications-health' AS href FROM communication_deliveries WHERE event_id IN (SELECT id FROM authorised_event) AND status IN ('failed','bounced','suppressed')`;
    case "integration_failures":
      return `SELECT id, id AS scopeKey, provider AS label, status || ' · revision ' || revision AS detail, '/admin/integrations?connection=' || id AS href FROM integration_connections WHERE event_id IN (SELECT id FROM authorised_event) AND status IN ('needs_attention','failed') UNION ALL SELECT r.id, r.id AS scopeKey, c.provider AS label, r.status || ' · ' || r.summary_json AS detail, '/admin/integrations?connection=' || c.id AS href FROM integration_runs r JOIN integration_connections c ON c.id = r.connection_id WHERE c.event_id IN (SELECT id FROM authorised_event) AND r.status IN ('partially_failed','failed')`;
    case "operation_failures":
      return `SELECT id, id AS scopeKey, type AS label, status || ' · ' || COALESCE(last_error, '') AS detail, '/admin/operations?operation=' || id AS href FROM operation_jobs WHERE event_id IN (SELECT id FROM authorised_event) AND status IN ('failed','queue_failed','partially_failed') AND alert_acknowledged_at IS NULL`;
    case "unpublished_schedule":
      return `SELECT d.id, d.id AS scopeKey, 'Draft schedule v' || d.version_number AS label, d.status AS detail, '/admin/schedule' AS href FROM schedule_versions d WHERE d.event_id IN (SELECT id FROM authorised_event) AND d.status = 'draft' AND d.version_number > COALESCE((SELECT MAX(p.version_number) FROM schedule_versions p WHERE p.event_id = d.event_id AND p.status = 'published'), 0)`;
    default:
      return null;
  }
}

export async function loadReadinessTaskContext(
  env: CloudflareEnvironment,
  viewer: Viewer,
  snapshot: CommandCentreSnapshot,
): Promise<ReadinessTaskContext | null> {
  const blocker = snapshot.topAction;
  if (!blocker) return null;
  const sql = blockerRecordsSql(blocker.key);
  const [recordResult, owners, existing] = await Promise.all([
    sql
      ? env.DB.prepare(
          `WITH authorised_event AS (SELECT id FROM events WHERE id = ? AND organisation_id = ?) SELECT * FROM (${sql}) ORDER BY id LIMIT 101`,
        )
          .bind(viewer.eventId, viewer.organisationId)
          .all<Omit<z.infer<typeof sourceRecordSchema>, "covered">>()
      : Promise.resolve({ results: [] }),
    env.DB.prepare(
      `SELECT person.id AS personId, person.display_name AS name, CASE WHEN MAX(membership.role = 'owner') THEN 'owner' ELSE 'administrator' END AS responsibility FROM memberships membership JOIN people person ON person.id = membership.person_id JOIN events event ON (membership.event_id = event.id OR membership.event_id IS NULL) AND event.organisation_id = membership.organisation_id WHERE event.id = ? AND event.organisation_id = ? AND membership.role IN ('owner','administrator') AND membership.accepted_at IS NOT NULL AND membership.revoked_at IS NULL GROUP BY person.id, person.display_name ORDER BY person.id LIMIT 100`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .all<{ personId: string; name: string; responsibility: string }>(),
    sql
      ? env.DB.prepare(
          `WITH authorised_event AS (SELECT id FROM events WHERE id = ? AND organisation_id = ?),
                current_records AS (${sql})
         SELECT task.id, task.title AS label, task.status AS detail,
                '/admin/tasks?task=' || task.id AS href,
                (SELECT json_group_array(json_extract(recorded.value, '$.scopeKey'))
                   FROM json_each(preview.metadata_json, '$.readinessContext.records') recorded
                  WHERE json_extract(recorded.value, '$.covered') = 0) AS coveredScopeKeysJson
           FROM task_instances task
           JOIN events event ON event.id = task.event_id AND event.organisation_id = ?
           JOIN audit_events preview
             ON preview.organisation_id = event.organisation_id
            AND preview.event_id = task.event_id
            AND preview.action = 'assistant.proposal.previewed'
          WHERE task.event_id = ? AND task.status NOT IN ('completed','waived')
            AND json_extract(preview.metadata_json, '$.readinessContext.blockerKey') = ?
                 AND EXISTS (
                   SELECT 1 FROM current_records current_record
                    WHERE EXISTS (
                      SELECT 1 FROM json_each(preview.metadata_json, '$.readinessContext.records') recorded
                       WHERE json_extract(recorded.value, '$.scopeKey') = current_record.scopeKey
                         AND json_extract(recorded.value, '$.covered') = 0
                    )
                 )
                 AND (
                   EXISTS (SELECT 1 FROM assistant_proposal_executions execution
                     WHERE execution.proposal_id = preview.entity_id
                       AND execution.organisation_id = event.organisation_id
                       AND execution.event_id = task.event_id
                       AND execution.status = 'completed'
                       AND json_extract(execution.result_json, '$.taskId') = task.id)
                   OR EXISTS (SELECT 1 FROM idempotency_records command
                     WHERE command.organisation_id = event.organisation_id
                       AND command.event_id = task.event_id
                       AND command.actor_id = 'api_key:assistant:' || preview.actor_person_id
                       AND command.scope = 'task.create'
                       AND command.idempotency_key = 'assistant:' || preview.entity_id
                       AND command.status = 'completed' AND command.entity_id = task.id)
                 )
          ORDER BY task.id LIMIT 101`,
        )
          .bind(
            viewer.eventId,
            viewer.organisationId,
            viewer.organisationId,
            viewer.eventId,
            blocker.key,
          )
          .all<
            z.infer<typeof recordSchema> & { coveredScopeKeysJson: string }
          >()
      : Promise.resolve({ results: [] }),
  ]);
  const taskBacked = [
    "overdue_tasks",
    "critical_tasks",
    "due_soon_tasks",
    "speaker_assets",
  ].includes(blocker.key);
  // A task owns only the records that were uncovered in its retained preview.
  // Already-covered records remain context for older tasks, not its own scope.
  const coveredScopeKeys = new Set(
    existing.results.flatMap((work) =>
      z.array(z.string()).parse(JSON.parse(work.coveredScopeKeysJson)),
    ),
  );
  const records = recordResult.results.slice(0, 100).map((record) => ({
    ...record,
    covered: taskBacked || coveredScopeKeys.has(record.scopeKey),
  }));
  const existingWork = taskBacked
    ? records.map(({ id, label, detail, href }) => ({
        id,
        label,
        detail,
        href,
      }))
    : existing.results.map(({ coveredScopeKeysJson: _, ...work }) => work);
  const sufficient = Boolean(
    sql &&
      records.length &&
      records.every(
        (record) => record.detail.trim() && record.detail.trim() !== "{}",
      ) &&
      recordResult.results.length === blocker.count &&
      blocker.count <= 100 &&
      existing.results.length <= 100 &&
      owners.results.length,
  );
  const context = {
    blockerKey: blocker.key,
    label: blocker.label,
    count: blocker.count,
    taskTarget: {
      targetType: "event" as const,
      targetId: viewer.eventId,
      taskType: "administrator_only" as const,
    },
    records,
    existingWork,
    eligibleOwners: owners.results,
    sufficient,
    limitation: sufficient
      ? null
      : "A complete set of supporting records and eligible event organisers could not be established. Inspect the linked records and select responsibility before creating work.",
  };
  const bounded = boundReadinessTaskContext(context);
  return { ...bounded, fingerprint: await fingerprint(bounded) };
}

export async function revalidateReadinessTask(
  env: CloudflareEnvironment,
  viewer: Viewer,
  previous: ReadinessTaskContext,
) {
  const snapshot = await new ReadinessService(env).getCommandCentre(viewer);
  const current = await loadReadinessTaskContext(env, viewer, snapshot);
  if (!current?.sufficient || current.fingerprint !== previous.fingerprint) {
    throw new AiReadinessChangedError(
      "The readiness blocker, supporting records or eligible owners changed after inspection. Generate and review a fresh preview.",
    );
  }
  return snapshot.cursor;
}
