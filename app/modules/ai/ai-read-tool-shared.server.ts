import type { z } from "zod";
import { participantResourceTaskAccessSql } from "~/modules/tasks/task-service-foundation.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  adminRoles,
  type reminderCohortSchema,
} from "./ai-tool-contracts.server";
import {
  AiToolPermissionError,
  AiToolValidationError,
} from "./ai-tool-execution";
import type { AiEvidence } from "./ai-types";

export function parseJson(value: string, context: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${context} contains invalid JSON.`, { cause: error });
  }
}

export function parseArguments<T>(
  name: string,
  value: string,
  schema: z.ZodType<T>,
) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new AiToolValidationError(
      `The selected AI provider returned invalid JSON arguments for ${name}.`,
    );
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new AiToolValidationError(
      `The selected AI provider returned invalid arguments for ${name}: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return parsed.data;
}

export function likePattern(value: string) {
  return `%${value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}

export function distinctEvidence(evidence: AiEvidence[]) {
  return [...new Map(evidence.map((item) => [item.id, item])).values()];
}

type ReminderCohort = z.infer<typeof reminderCohortSchema>;

export async function loadReminderCohort(
  env: CloudflareEnvironment,
  viewer: Viewer,
  cohort: ReminderCohort,
) {
  if (!adminRoles.has(viewer.role)) throw new AiToolPermissionError();
  const definitions: Record<
    ReminderCohort,
    { from: string; where: string; reason: string; href: string }
  > = {
    incomplete_speakers: {
      from: `people p JOIN task_instances ti
               ON ti.target_id = p.id AND ti.event_id = ?
              AND ti.target_type = 'speaker'`,
      where: `ti.status NOT IN ('completed','waived')
        AND ${participantResourceTaskAccessSql("ti")}`,
      reason: "incomplete speaker tasks",
      href: "/admin/tasks?target=speaker&state=open",
    },
    overdue_speaker_tasks: {
      from: `people p JOIN task_instances ti
               ON ti.target_id = p.id AND ti.event_id = ?
              AND ti.target_type = 'speaker'`,
      where: `(ti.status = 'overdue' OR (ti.status NOT IN ('completed','waived') AND ti.due_at IS NOT NULL AND ti.due_at < unixepoch()))
         AND ${participantResourceTaskAccessSql("ti")}`,
      reason: "overdue speaker tasks",
      href: "/admin/tasks?target=speaker&state=overdue",
    },
    reviewers_with_open_assignments: {
      from: `people p JOIN evaluator_assignments a
               ON a.evaluator_person_id = p.id AND a.event_id = ?
              JOIN evaluation_rounds round
                ON round.id = a.round_id AND round.event_id = a.event_id
              JOIN evaluation_plans plan
                ON plan.id = round.plan_id AND plan.event_id = round.event_id`,
      where: "a.status IN ('assigned','in_progress','reopened')",
      reason: "open review assignments",
      href: "/admin/review?filter=open",
    },
  };
  const definition = definitions[cohort];
  const base = `FROM ${definition.from}
    JOIN events e ON e.id = ? AND e.organisation_id = ?
   WHERE ${definition.where}
     ${cohort === "reviewers_with_open_assignments" ? "AND round.status = 'active' AND plan.status = 'active'" : ""}`;
  const [count, sample] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(DISTINCT p.id) AS count ${base}`)
      .bind(viewer.eventId, viewer.eventId, viewer.organisationId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT p.id, p.display_name AS name, COUNT(*) AS affected ${base}
       GROUP BY p.id, p.display_name ORDER BY affected DESC, p.display_name LIMIT 10`,
    )
      .bind(viewer.eventId, viewer.eventId, viewer.organisationId)
      .all<{ id: string; name: string; affected: number }>(),
  ]);
  return {
    cohort,
    count: Number(count?.count ?? 0),
    reason: definition.reason,
    sample: sample.results,
    href: definition.href,
  };
}
