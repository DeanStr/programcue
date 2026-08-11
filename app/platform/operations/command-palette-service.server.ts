import { z } from "zod";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";

export type CommandRecord = {
  id: string;
  kind: "speaker" | "submission" | "session" | "task";
  label: string;
  description: string;
  href: string;
  aliases: string[];
  eventId: string;
  eventName: string;
};

export type RecentCommandRecord = {
  id: string;
  label: string;
  description: string;
  href: string;
  createdAt: number;
};

const searchSchema = z.object({
  query: z.string().trim().min(2).max(100),
  scope: z.enum(["event", "organisation"]).default("event"),
});

function searchPattern(query: string) {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function recordHref(kind: CommandRecord["kind"], id: string) {
  if (kind === "speaker")
    return `/admin/speakers?person=${encodeURIComponent(id)}`;
  if (kind === "submission")
    return `/admin/submissions/${encodeURIComponent(id)}`;
  if (kind === "session")
    return `/admin/schedule?session=${encodeURIComponent(id)}`;
  return `/admin/tasks?task=${encodeURIComponent(id)}`;
}

function recentHref(entityType: string, entityId: string | null) {
  if (!entityId) return "/admin/command";
  if (
    [
      "submission",
      "submission_decision",
      "decision",
      "review",
      "evaluator_assignment",
    ].includes(entityType)
  )
    return `/admin/submissions/${encodeURIComponent(entityId)}`;
  if (["session", "schedule_entry"].includes(entityType))
    return `/admin/schedule?session=${encodeURIComponent(entityId)}`;
  if (
    ["schedule", "schedule_version", "schedule_conflict"].includes(entityType)
  )
    return "/admin/schedule";
  if (["task", "task_instance"].includes(entityType))
    return `/admin/tasks?task=${encodeURIComponent(entityId)}`;
  if (["speaker", "person"].includes(entityType))
    return `/admin/speakers?person=${encodeURIComponent(entityId)}`;
  if (
    [
      "communication",
      "delivery",
      "communication_delivery",
      "communication_template",
    ].includes(entityType)
  )
    return "/admin/communications";
  if (["integration_run", "integration_run_item"].includes(entityType))
    return `/admin/operations?operation=${encodeURIComponent(entityId)}`;
  if (entityType === "integration") return "/admin/integrations";
  if (["webhook_endpoint", "webhook_delivery", "api_key"].includes(entityType))
    return "/admin/settings";
  if (entityType === "event") return "/admin/event";
  if (entityType === "operation")
    return `/admin/operations?operation=${encodeURIComponent(entityId)}`;
  return "/admin/command";
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replaceAll(".", " · ");
}

export class CommandPaletteService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private async assertSearchReadable(
    viewer: Viewer,
    scope: "event" | "organisation",
  ) {
    if (scope === "event") {
      await this.airtable.assertReadable(viewer);
      return;
    }
    const events = await this.env.DB.prepare(
      "SELECT id FROM events WHERE organisation_id = ? ORDER BY id",
    )
      .bind(viewer.organisationId)
      .all<{ id: string }>();
    await Promise.all(
      events.results.map((event) =>
        this.airtable.assertReadable({
          organisationId: viewer.organisationId,
          eventId: event.id,
        }),
      ),
    );
  }

  async canSearchOrganisation(viewer: Viewer) {
    const membership = await this.env.DB.prepare(
      `
      SELECT 1
        FROM memberships
       WHERE organisation_id = ? AND event_id IS NULL AND person_id = ?
         AND role = 'owner' AND accepted_at IS NOT NULL AND revoked_at IS NULL
       LIMIT 1
    `,
    )
      .bind(viewer.organisationId, viewer.personId)
      .first();
    return Boolean(membership);
  }

  async recent(viewer: Viewer): Promise<RecentCommandRecord[]> {
    if (viewer.role === "committee_chair") {
      return this.recentCommitteeChairAssignments(viewer);
    }
    const rows = await this.env.DB.prepare(
      `
      SELECT a.id, a.action, a.entity_type AS entityType,
             CASE
               WHEN a.entity_type IN ('submission_decision','decision') THEN
                 COALESCE((SELECT d.submission_id FROM submission_decisions d WHERE d.id = a.entity_id AND d.event_id = a.event_id), a.entity_id)
               WHEN a.entity_type = 'review' THEN
                 COALESCE((SELECT assignment.submission_id FROM reviews review JOIN evaluator_assignments assignment ON assignment.id = review.assignment_id AND assignment.event_id = review.event_id WHERE review.id = a.entity_id AND review.event_id = a.event_id), a.entity_id)
               WHEN a.entity_type = 'evaluator_assignment' THEN
                 COALESCE((SELECT assignment.submission_id FROM evaluator_assignments assignment WHERE assignment.id = a.entity_id AND assignment.event_id = a.event_id), a.entity_id)
              WHEN a.entity_type = 'schedule_entry' THEN
                 COALESCE((SELECT entry.session_id FROM schedule_entries entry WHERE entry.id = a.entity_id AND entry.event_id = a.event_id), a.entity_id)
               WHEN a.entity_type = 'integration_run' THEN
                 COALESCE((SELECT run.operation_id FROM integration_runs run WHERE run.id = a.entity_id), a.entity_id)
               WHEN a.entity_type = 'integration_run_item' THEN
                 COALESCE((SELECT run.operation_id
                             FROM integration_run_items item
                             JOIN integration_runs run ON run.id = item.run_id
                            WHERE item.id = a.entity_id), a.entity_id)
               ELSE a.entity_id
             END AS entityId,
             a.created_at AS createdAt,
             COALESCE(p.display_name, 'System') AS actorName
        FROM audit_events a
        JOIN events e ON e.id = a.event_id AND e.organisation_id = ?
        LEFT JOIN people p ON p.id = a.actor_person_id
       WHERE a.event_id = ?
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 8
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        id: string;
        action: string;
        entityType: string;
        entityId: string | null;
        createdAt: number;
        actorName: string;
      }>();
    return rows.results.map((row) => ({
      id: row.id,
      label: humanize(row.action),
      description: `${row.actorName} · ${row.entityType}${row.entityId ? ` · ${row.entityId}` : ""}`,
      href: recentHref(row.entityType, row.entityId),
      createdAt: row.createdAt,
    }));
  }

  private async recentCommitteeChairAssignments(
    viewer: Viewer,
  ): Promise<RecentCommandRecord[]> {
    const rows = await this.env.DB.prepare(
      `
      SELECT * FROM (
        SELECT audit.id, audit.action, audit.entity_type AS entityType,
               assignment.id AS assignmentId, audit.created_at AS createdAt,
               COALESCE(actor.display_name, 'System') AS actorName
          FROM audit_events audit
          JOIN events event
            ON event.id = audit.event_id AND event.organisation_id = ?
          JOIN evaluator_assignments assignment
            ON assignment.id = audit.entity_id
           AND assignment.event_id = audit.event_id
           AND assignment.evaluator_person_id = ?
           AND assignment.status NOT IN ('recused','cancelled')
          LEFT JOIN people actor ON actor.id = audit.actor_person_id
         WHERE audit.event_id = ? AND audit.entity_type = 'evaluator_assignment'
        UNION ALL
        SELECT audit.id, audit.action, audit.entity_type AS entityType,
               assignment.id AS assignmentId, audit.created_at AS createdAt,
               COALESCE(actor.display_name, 'System') AS actorName
          FROM audit_events audit
          JOIN events event
            ON event.id = audit.event_id AND event.organisation_id = ?
          JOIN reviews review
            ON review.id = audit.entity_id AND review.event_id = audit.event_id
          JOIN evaluator_assignments assignment
            ON assignment.id = review.assignment_id
           AND assignment.event_id = review.event_id
           AND assignment.evaluator_person_id = ?
           AND assignment.status NOT IN ('recused','cancelled')
          LEFT JOIN people actor ON actor.id = audit.actor_person_id
         WHERE audit.event_id = ? AND audit.entity_type = 'review'
      ) authorised
      ORDER BY createdAt DESC, id DESC
      LIMIT 8
    `,
    )
      .bind(
        viewer.organisationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
        viewer.eventId,
      )
      .all<{
        id: string;
        action: string;
        entityType: "evaluator_assignment" | "review";
        assignmentId: string;
        createdAt: number;
        actorName: string;
      }>();
    return rows.results.map((row) => ({
      id: row.id,
      label: humanize(row.action),
      description: `${row.actorName} · ${humanize(row.entityType)}`,
      href: `/review/workbench?assignment=${encodeURIComponent(row.assignmentId)}`,
      createdAt: row.createdAt,
    }));
  }

  async search(viewer: Viewer, rawInput: unknown): Promise<CommandRecord[]> {
    const input = searchSchema.parse(rawInput);
    if (
      input.scope === "organisation" &&
      !(await this.canSearchOrganisation(viewer))
    ) {
      throw new Response("Organisation-wide search requires owner access.", {
        status: 403,
      });
    }
    if (viewer.role === "committee_chair" && input.scope !== "event") {
      throw new Response(
        "Committee chairs can search only their current event assignments.",
        { status: 403 },
      );
    }
    await this.assertSearchReadable(viewer, input.scope);
    const pattern = searchPattern(input.query);
    const eventPredicate =
      input.scope === "event" ? "AND e.id = ?" : "AND e.organisation_id = ?";
    const scopeBinding =
      input.scope === "event" ? viewer.eventId : viewer.organisationId;

    if (viewer.role === "committee_chair") {
      const assigned = await this.env.DB.prepare(
        `
        SELECT s.id, ea.id AS assignmentId,
               'submission' AS kind, s.title AS label,
               s.status || ' · ' || s.public_reference AS description,
               e.id AS eventId, e.name AS eventName
          FROM submissions s
          JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
          JOIN evaluator_assignments ea
            ON ea.submission_id = s.id AND ea.event_id = s.event_id
         WHERE s.event_id = ? AND ea.evaluator_person_id = ?
           AND ea.status NOT IN ('recused','cancelled')
           AND (s.title LIKE ? ESCAPE '\\' OR s.public_reference LIKE ? ESCAPE '\\')
         ORDER BY s.title, ea.assigned_at, ea.id LIMIT 30
      `,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          pattern,
          pattern,
        )
        .all<
          Omit<CommandRecord, "href" | "aliases"> & { assignmentId: string }
        >();
      return assigned.results.map(({ assignmentId, ...record }) => ({
        ...record,
        href: `/review/workbench?assignment=${encodeURIComponent(assignmentId)}`,
        aliases: ["proposal", "application", "review"],
      }));
    }

    const rows = await this.env.DB.prepare(
      `
      SELECT * FROM (
        SELECT DISTINCT p.id, 'speaker' AS kind, p.display_name AS label,
               COALESCE(p.email, '') || CASE WHEN p.organisation_name IS NULL THEN '' ELSE ' · ' || p.organisation_name END AS description,
               e.id AS eventId, e.name AS eventName
          FROM people p
          JOIN events e ON e.organisation_id = ?
         WHERE (
           EXISTS (
             SELECT 1 FROM memberships m
              WHERE m.person_id = p.id AND m.event_id = e.id
                AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM session_speakers ss
              WHERE ss.person_id = p.id AND ss.event_id = e.id
           )
           OR EXISTS (
             SELECT 1 FROM submissions s
              WHERE s.submitter_person_id = p.id AND s.event_id = e.id
           )
           OR EXISTS (
             SELECT 1 FROM submission_speakers speaker
              WHERE speaker.person_id = p.id AND speaker.event_id = e.id
           )
         )
           ${eventPredicate}
           AND (p.display_name LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\' OR COALESCE(p.organisation_name, '') LIKE ? ESCAPE '\\')
        UNION ALL
        SELECT s.id, 'submission' AS kind, s.title AS label,
               s.status || ' · ' || s.public_reference AS description,
               e.id AS eventId, e.name AS eventName
          FROM submissions s
          JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
         WHERE ${input.scope === "event" ? "e.id = ?" : "e.organisation_id = ?"}
           AND (s.title LIKE ? ESCAPE '\\' OR s.public_reference LIKE ? ESCAPE '\\' OR COALESCE(s.category, '') LIKE ? ESCAPE '\\')
        UNION ALL
        SELECT s.id, 'session' AS kind, s.title AS label,
               s.status || ' · ' || s.format AS description,
               e.id AS eventId, e.name AS eventName
          FROM sessions s
          JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
         WHERE ${input.scope === "event" ? "e.id = ?" : "e.organisation_id = ?"}
           AND (s.title LIKE ? ESCAPE '\\' OR s.slug LIKE ? ESCAPE '\\' OR COALESCE(s.description, '') LIKE ? ESCAPE '\\')
        UNION ALL
        SELECT ti.id, 'task' AS kind, ti.title AS label,
               ti.status || ' · ' || ti.impact AS description,
               e.id AS eventId, e.name AS eventName
          FROM task_instances ti
          JOIN events e ON e.id = ti.event_id AND e.organisation_id = ?
         WHERE ${input.scope === "event" ? "e.id = ?" : "e.organisation_id = ?"}
           AND (ti.title LIKE ? ESCAPE '\\' OR COALESCE(ti.description, '') LIKE ? ESCAPE '\\')
      ) records
      ORDER BY label, kind
      LIMIT 50
    `,
    )
      .bind(
        viewer.organisationId,
        scopeBinding,
        pattern,
        pattern,
        pattern,
        viewer.organisationId,
        scopeBinding,
        pattern,
        pattern,
        pattern,
        viewer.organisationId,
        scopeBinding,
        pattern,
        pattern,
        pattern,
        viewer.organisationId,
        scopeBinding,
        pattern,
        pattern,
      )
      .all<Omit<CommandRecord, "href" | "aliases">>();

    const aliases: Record<CommandRecord["kind"], string[]> = {
      speaker: ["presenter", "person", "people", "faculty"],
      submission: ["proposal", "application", "abstract", "cfp"],
      session: ["talk", "programme", "agenda"],
      task: ["readiness", "checklist", "todo"],
    };
    return rows.results.map((record) => ({
      ...record,
      href: recordHref(record.kind, record.id),
      aliases: aliases[record.kind],
    }));
  }
}
