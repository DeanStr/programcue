import { requireValue } from "~/lib/required-value";
import type { Viewer } from "~/platform/auth/authorize.server";

import type { TemplateRow } from "./task-service-foundation.server";
import { TaskStateError } from "./task-service-foundation.server";

export type TaskAssignmentSnapshot = {
  targetRevision: number;
  templateAssignments: Array<{ templateId: string; assigned: boolean }>;
  templates: TaskTemplateAssignmentSnapshot[];
};

type TaskTemplateAssignmentSnapshot = {
  id: string;
  name: string;
  description: string | null;
  targetType: TemplateRow["targetType"];
  taskType: TemplateRow["taskType"];
  impact: TemplateRow["impact"];
  evidenceMode: TemplateRow["evidenceMode"];
  dueAnchor: TemplateRow["dueAnchor"];
  dueOffsetMinutes: number | null;
  fixedDueAt: number | null;
  autoAssignOnAcceptance: number;
  configurationJson: string;
  updatedAt: number;
  dependencyIds: string[];
};

export type PlannedTaskNode = {
  template: TemplateRow & { updatedAt: number };
  dependencyTemplateIds: string[];
  dueAt: number | null;
  existing: {
    id: string;
    title: string;
    status: string;
    lastOperationId: string | null;
  } | null;
  taskId: string;
  operationId: string;
  auditEventId: string;
};

export const matchingActiveTaskDefinitionSql = `
  (duplicate.template_id IS NULL OR duplicate.template_id <> ?)
  AND duplicate.status NOT IN ('completed','waived')
  AND lower(trim(duplicate.title)) = lower(trim(?))
  AND duplicate.description IS ?
  AND duplicate.task_type = ?
  AND duplicate.impact = ?
  AND duplicate.due_at IS ?
  AND duplicate.evidence_mode = ?
  AND duplicate.configuration_json = ?
`;

export function assignmentTemplateSnapshot(
  template: TemplateRow & { updatedAt: number },
  dependencyIds: string[] = [],
): TaskTemplateAssignmentSnapshot {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    targetType: template.targetType,
    taskType: template.taskType,
    impact: template.impact,
    evidenceMode: template.evidenceMode,
    dueAnchor: template.dueAnchor,
    dueOffsetMinutes: template.dueOffsetMinutes,
    fixedDueAt: template.fixedDueAt,
    autoAssignOnAcceptance: Number(template.autoAssignOnAcceptance),
    configurationJson: template.configurationJson,
    updatedAt: template.updatedAt,
    dependencyIds: [...dependencyIds].sort(),
  };
}

export function matchingActiveTaskDefinitionBindings(
  template: TemplateRow,
  dueAt: number | null,
) {
  return [
    template.id,
    template.name,
    template.description,
    template.taskType,
    template.impact,
    dueAt,
    template.evidenceMode,
    template.configurationJson,
  ];
}

export async function dependencyAssignmentOperationId(
  intentId: string,
  templateId: string,
) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${intentId.length}:${intentId}:${templateId}`),
    ),
  );
  const boundedHash = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 40);
  return `dep:${boundedHash}`;
}

async function getTemplate(
  env: CloudflareEnvironment,
  eventId: string,
  templateId: string,
) {
  return env.DB.prepare(
    `SELECT id, name, description, target_type AS targetType,
            task_type AS taskType, impact, evidence_mode AS evidenceMode,
            due_anchor AS dueAnchor, due_offset_minutes AS dueOffsetMinutes,
            fixed_due_at AS fixedDueAt,
            auto_assign_on_acceptance AS autoAssignOnAcceptance,
            configuration_json AS configurationJson, status,
            updated_at AS updatedAt
       FROM task_templates WHERE id = ? AND event_id = ?`,
  )
    .bind(templateId, eventId)
    .first<TemplateRow & { updatedAt: number }>();
}

export async function templateDueAt(
  env: CloudflareEnvironment,
  template: TemplateRow,
  eventId: string,
  targetId: string,
) {
  let anchor: number | null = null;
  if (template.dueAnchor === "fixed") anchor = template.fixedDueAt;
  if (template.dueAnchor === "acceptance") {
    const acceptanceQueries = {
      speaker: `
        SELECT MIN(sd.published_at) AS anchor
          FROM session_speakers ss
          JOIN sessions s ON s.id = ss.session_id AND s.event_id = ss.event_id
          JOIN submission_decisions sd
            ON sd.submission_id = s.source_submission_id AND sd.event_id = s.event_id
         WHERE ss.event_id = ? AND ss.person_id = ?
           AND sd.status = 'published' AND sd.decision = 'accepted'`,
      session: `
        SELECT MIN(sd.published_at) AS anchor
          FROM sessions s
          JOIN submission_decisions sd
            ON sd.submission_id = s.source_submission_id AND sd.event_id = s.event_id
         WHERE s.event_id = ? AND s.id = ?
           AND sd.status = 'published' AND sd.decision = 'accepted'`,
      event: `
        SELECT MIN(sd.published_at) AS anchor
          FROM submission_decisions sd
         WHERE sd.event_id = ? AND ? = sd.event_id
           AND sd.status = 'published' AND sd.decision = 'accepted'`,
    } satisfies Record<TemplateRow["targetType"], string>;
    const row = await env.DB.prepare(acceptanceQueries[template.targetType])
      .bind(eventId, targetId)
      .first<{ anchor: number | null }>();
    anchor = row?.anchor ?? null;
  }
  if (template.dueAnchor === "session_start") {
    const sessionStartQueries = {
      speaker: `
        SELECT MIN(se.starts_at) AS anchor
          FROM session_speakers ss
          JOIN schedule_versions sv
            ON sv.event_id = ss.event_id AND sv.status = 'published'
          JOIN schedule_entries se
            ON se.schedule_version_id = sv.id AND se.session_id = ss.session_id
         WHERE ss.event_id = ? AND ss.person_id = ?`,
      session: `
        SELECT MIN(se.starts_at) AS anchor
          FROM schedule_versions sv
          JOIN schedule_entries se ON se.schedule_version_id = sv.id
         WHERE sv.event_id = ? AND se.session_id = ? AND sv.status = 'published'`,
      event: `SELECT starts_at AS anchor FROM events WHERE id = ? AND id = ?`,
    } satisfies Record<TemplateRow["targetType"], string>;
    const row = await env.DB.prepare(sessionStartQueries[template.targetType])
      .bind(eventId, targetId)
      .first<{ anchor: number | null }>();
    anchor = row?.anchor ?? null;
  }
  return anchor === null
    ? null
    : anchor + (template.dueOffsetMinutes ?? 0) * 60;
}

export async function planTemplateAssignment(
  env: CloudflareEnvironment,
  viewer: Viewer,
  rootTemplateId: string,
  targetId: string,
  assignmentIntentId?: string,
) {
  const planned = new Map<string, PlannedTaskNode>();
  const ordered: PlannedTaskNode[] = [];
  const visiting = new Set<string>();
  let rootTargetType: TemplateRow["targetType"] | null = null;

  const visit = async (templateId: string): Promise<void> => {
    if (visiting.has(templateId)) {
      throw new TaskStateError("Task template dependencies contain a cycle.");
    }
    if (planned.has(templateId)) return;
    visiting.add(templateId);
    const template = await getTemplate(env, viewer.eventId, templateId);
    if (template?.status !== "active") {
      throw new TaskStateError("Task template not found or archived.");
    }
    rootTargetType ??= template.targetType;
    if (template.targetType !== rootTargetType) {
      throw new TaskStateError(
        "Prerequisite templates must use the same task scope.",
      );
    }
    const [existing, dependencyRows] = await Promise.all([
      env.DB.prepare(
        `SELECT id, title, status, last_operation_id AS lastOperationId
           FROM task_instances
          WHERE event_id = ? AND template_id = ?
            AND target_type = ? AND target_id = ?
          LIMIT 1`,
      )
        .bind(viewer.eventId, templateId, template.targetType, targetId)
        .first<NonNullable<PlannedTaskNode["existing"]>>(),
      env.DB.prepare(
        `SELECT depends_on_template_id AS id
           FROM task_template_dependencies
          WHERE template_id = ?
          ORDER BY depends_on_template_id`,
      )
        .bind(templateId)
        .all<{ id: string }>(),
    ]);
    const dueAt = existing
      ? null
      : await templateDueAt(env, template, viewer.eventId, targetId);
    if (!existing && template.dueAnchor !== "none" && dueAt === null) {
      throw new TaskStateError(
        `The ${template.dueAnchor.replace("_", " ")} due anchor cannot be resolved for this ${template.targetType}.`,
      );
    }
    if (!existing) {
      const matchingTask = await env.DB.prepare(
        `SELECT duplicate.id
           FROM task_instances duplicate
          WHERE duplicate.event_id = ?
            AND duplicate.target_type = ? AND duplicate.target_id = ?
            AND ${matchingActiveTaskDefinitionSql}
          LIMIT 1`,
      )
        .bind(
          viewer.eventId,
          template.targetType,
          targetId,
          ...matchingActiveTaskDefinitionBindings(template, dueAt),
        )
        .first<{ id: string }>();
      if (matchingTask) {
        throw new TaskStateError(
          `“${template.name}” with the same instructions, type, evidence, impact and due date is already assigned to this ${template.targetType}. Use the existing task instead of creating a duplicate.`,
        );
      }
    }
    for (const dependency of dependencyRows.results) {
      await visit(dependency.id);
    }
    const operationId = assignmentIntentId
      ? templateId === rootTemplateId
        ? assignmentIntentId
        : await dependencyAssignmentOperationId(assignmentIntentId, templateId)
      : crypto.randomUUID();
    const node: PlannedTaskNode = {
      template,
      dependencyTemplateIds: dependencyRows.results.map((row) => row.id),
      dueAt,
      existing: existing ?? null,
      taskId:
        existing?.id ??
        (assignmentIntentId ? `task:${operationId}` : crypto.randomUUID()),
      operationId,
      auditEventId: assignmentIntentId
        ? `audit:task-assigned:${operationId}`
        : crypto.randomUUID(),
    };
    planned.set(templateId, node);
    ordered.push(node);
    visiting.delete(templateId);
  };

  await visit(rootTemplateId);
  return {
    ordered,
    root: requireValue(
      planned.get(rootTemplateId),
      "Required planned.get(rootTemplateId) is unavailable.",
    ),
  };
}
