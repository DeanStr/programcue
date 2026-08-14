import { z } from "zod";
import type { AirtableEventTableSpec } from "./airtable-event-data-schema-shared";
import {
  booleanInteger,
  eventRecord,
  id,
  integer,
  jsonText,
  nullableInteger,
  nullableJsonText,
  nullableText,
  revision,
  text,
  timestamps,
} from "./airtable-event-data-schema-shared";

export const AIRTABLE_TASK_TABLE_SPECS: readonly AirtableEventTableSpec[] = [
  {
    key: "taskTemplates",
    domain: "tasks",
    entityType: "task_template",
    query: `SELECT id, event_id, name, description, target_type, task_type,
                   impact, evidence_mode, due_anchor, due_offset_minutes,
                   fixed_due_at, auto_assign_on_acceptance,
                   configuration_json, status,
                   created_at, updated_at
              FROM task_templates WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        name: text.min(1),
        description: nullableText,
        target_type: z.enum(["speaker", "session", "event"]),
        task_type: z.enum([
          "checklist",
          "acknowledgement",
          "short_form",
          "file_upload",
          "link_visit",
          "administrator_only",
        ]),
        impact: z.enum(["critical", "high", "medium", "low"]),
        evidence_mode: z.enum([
          "none",
          "checkbox",
          "file",
          "text",
          "link",
          "admin_approval",
        ]),
        due_anchor: z.enum(["none", "acceptance", "session_start", "fixed"]),
        due_offset_minutes: nullableInteger,
        fixed_due_at: nullableInteger,
        auto_assign_on_acceptance: booleanInteger,
        configuration_json: jsonText,
        status: z.enum(["active", "archived"]),
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
  {
    key: "taskInstances",
    domain: "tasks",
    entityType: "task_instance",
    query: `SELECT id, event_id, template_id, target_type, target_id,
                   owner_person_id, title, description, task_type, impact,
                   status, readiness_state, readiness_percent, revision,
                   due_at, evidence_json, waiver_json, submitted_at,
                   completed_at, completed_by_person_id, created_at, updated_at
              FROM task_instances WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        template_id: nullableText,
        target_type: z.enum(["speaker", "session", "event"]),
        target_id: text.min(1),
        owner_person_id: nullableText,
        title: text.min(1),
        description: nullableText,
        task_type: z.enum([
          "checklist",
          "acknowledgement",
          "short_form",
          "file_upload",
          "link_visit",
          "administrator_only",
        ]),
        impact: z.enum(["critical", "high", "medium", "low"]),
        status: z.enum([
          "not_started",
          "in_progress",
          "blocked",
          "submitted",
          "completed",
          "waived",
          "overdue",
        ]),
        readiness_state: z.enum(["on_track", "at_risk", "overdue", "blocked"]),
        readiness_percent: integer.min(0).max(100),
        revision: integer.positive(),
        due_at: nullableInteger,
        evidence_json: nullableJsonText,
        waiver_json: nullableJsonText,
        submitted_at: nullableInteger,
        completed_at: nullableInteger,
        completed_by_person_id: nullableText,
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "taskTemplateDependencies",
    domain: "tasks",
    entityType: "task_template_dependency",
    query: `SELECT dependency.template_id, template.event_id,
                   dependency.depends_on_template_id, dependency.created_at
              FROM task_template_dependencies dependency
              JOIN task_templates template ON template.id = dependency.template_id
             WHERE template.event_id = ?
             ORDER BY dependency.template_id, dependency.depends_on_template_id`,
    schema: z
      .object({
        template_id: text.min(1),
        event_id: text.min(1),
        depends_on_template_id: text.min(1),
        created_at: integer,
      })
      .strict(),
    entityId: (row) =>
      `${String(row.template_id)}:${String(row.depends_on_template_id)}`,
    revision: () => 1,
  },
  {
    key: "taskInstanceDependencies",
    domain: "tasks",
    entityType: "task_instance_dependency",
    query: `SELECT dependency.task_id, task.event_id,
                   dependency.depends_on_task_id, dependency.created_at
              FROM task_instance_dependencies dependency
              JOIN task_instances task ON task.id = dependency.task_id
             WHERE task.event_id = ?
             ORDER BY dependency.task_id, dependency.depends_on_task_id`,
    schema: z
      .object({
        task_id: text.min(1),
        event_id: text.min(1),
        depends_on_task_id: text.min(1),
        created_at: integer,
      })
      .strict(),
    entityId: (row) =>
      `${String(row.task_id)}:${String(row.depends_on_task_id)}`,
    revision: () => 1,
  },
  {
    key: "taskEvidence",
    domain: "tasks",
    entityType: "task_evidence",
    query: `SELECT id, event_id, task_id, submitted_by_person_id,
                   file_asset_id, evidence_json, status,
                   reviewed_by_person_id, created_at, reviewed_at
              FROM task_evidence WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        task_id: text.min(1),
        submitted_by_person_id: text.min(1),
        file_asset_id: nullableText,
        evidence_json: jsonText,
        status: z.enum(["submitted", "approved", "rejected", "superseded"]),
        reviewed_by_person_id: nullableText,
        created_at: integer,
        reviewed_at: nullableInteger,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
  {
    key: "taskComments",
    domain: "tasks",
    entityType: "task_comment",
    query: `SELECT id, event_id, task_id, author_person_id, body, visibility,
                   created_at, edited_at
              FROM task_comments WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        task_id: text.min(1),
        author_person_id: text.min(1),
        body: text.min(1),
        visibility: z.enum(["participant", "administrator"]),
        created_at: integer,
        edited_at: nullableInteger,
      })
      .strict(),
    entityId: id,
    revision: () => 1,
  },
] as const;
