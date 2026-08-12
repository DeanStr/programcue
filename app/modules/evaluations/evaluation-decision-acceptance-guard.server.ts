import type { Viewer } from "~/platform/auth/authorize.server";
import {
  acceptanceTaskPlanBindings,
  acceptanceTaskPlanCteSql,
} from "./evaluation-decision-statements.server";
import { EvaluationStateError } from "./evaluation-errors";

export async function assertDecisionViewerEvent(
  env: CloudflareEnvironment,
  viewer: Viewer,
) {
  const event = await env.DB.prepare(
    "SELECT id FROM events WHERE id = ? AND organisation_id = ?",
  )
    .bind(viewer.eventId, viewer.organisationId)
    .first();
  if (!event) {
    throw new Error("Event not found in the authorised organisation.");
  }
}

export async function assertAcceptanceTaskPlan(
  env: CloudflareEnvironment,
  eventId: string,
) {
  const result = await env.DB.prepare(
    `
    WITH RECURSIVE
    acceptance_scope(event_id) AS (VALUES (?)),
    acceptance_task_plan(template_id) AS (
      SELECT template.id
        FROM task_templates template, acceptance_scope scope
       WHERE template.event_id = scope.event_id
         AND template.status = 'active'
         AND template.auto_assign_on_acceptance = 1
      UNION
      SELECT dependency.depends_on_template_id
        FROM acceptance_task_plan plan
        JOIN task_template_dependencies dependency
          ON dependency.template_id = plan.template_id
    )
    SELECT CASE
      WHEN EXISTS (
        SELECT 1
          FROM acceptance_task_plan plan
          JOIN task_templates template ON template.id = plan.template_id
          CROSS JOIN acceptance_scope scope
         WHERE template.event_id IS NOT scope.event_id
            OR template.status <> 'active'
            OR template.due_anchor = 'session_start'
            OR (template.due_anchor = 'fixed' AND template.fixed_due_at IS NULL)
            OR (
              template.due_anchor = 'acceptance'
              AND template.due_offset_minutes IS NULL
            )
      ) THEN 'invalid_template'
      WHEN EXISTS (
        SELECT 1
          FROM acceptance_task_plan plan
          JOIN task_template_dependencies dependency
            ON dependency.template_id = plan.template_id
          JOIN task_templates template ON template.id = dependency.template_id
          JOIN task_templates prerequisite
            ON prerequisite.id = dependency.depends_on_template_id
         WHERE template.target_type <> prerequisite.target_type
      ) THEN 'mixed_scope'
      ELSE NULL
    END AS reason
  `,
  )
    .bind(eventId)
    .first<{ reason: "invalid_template" | "mixed_scope" | null }>();
  if (!result?.reason) return;
  const message = {
    invalid_template:
      "The automatic onboarding task plan contains an inactive, cross-event, or unresolved template.",
    mixed_scope:
      "Automatic onboarding prerequisites must use the same task scope.",
  }[result.reason];
  throw new EvaluationStateError(message);
}

export async function assertAcceptanceTaskPlanMaterialized(
  env: CloudflareEnvironment,
  input: {
    eventId: string;
    submissionId: string;
    sessionId: string;
    decisionId: string;
  },
) {
  const bindings = acceptanceTaskPlanBindings(input);
  const missing = await env.DB.prepare(
    `
    ${acceptanceTaskPlanCteSql}
    SELECT 'task' AS missingKind
      FROM acceptance_task_plan plan
      JOIN task_templates template ON template.id = plan.template_id
      JOIN acceptance_targets target
        ON target.target_type = template.target_type
      CROSS JOIN acceptance_scope scope
     WHERE NOT EXISTS (
       SELECT 1 FROM task_instances task
        WHERE task.event_id = scope.event_id
          AND task.template_id = template.id
          AND task.target_type = target.target_type
          AND task.target_id = target.target_id
     )
    UNION ALL
    SELECT 'dependency' AS missingKind
      FROM acceptance_task_plan plan
      JOIN task_template_dependencies dependency
        ON dependency.template_id = plan.template_id
      JOIN task_templates template ON template.id = dependency.template_id
      JOIN acceptance_targets target
        ON target.target_type = template.target_type
      CROSS JOIN acceptance_scope scope
      JOIN task_instances task
        ON task.event_id = scope.event_id
       AND task.template_id = dependency.template_id
       AND task.target_type = target.target_type
       AND task.target_id = target.target_id
      JOIN task_instances prerequisite
        ON prerequisite.event_id = task.event_id
       AND prerequisite.template_id = dependency.depends_on_template_id
       AND prerequisite.target_type = task.target_type
       AND prerequisite.target_id = task.target_id
     WHERE NOT EXISTS (
       SELECT 1 FROM task_instance_dependencies edge
        WHERE edge.task_id = task.id
          AND edge.depends_on_task_id = prerequisite.id
     )
     LIMIT 1
  `,
  )
    .bind(...bindings)
    .first<{ missingKind: "task" | "dependency" }>();
  if (missing)
    throw new EvaluationStateError(
      `The accepted decision committed without its complete automatic task ${missing.missingKind === "task" ? "plan" : "dependency plan"}. Retry the same decision operation before continuing.`,
    );
}
