import { z } from "zod";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { reviewableSubmissionSql } from "~/modules/evaluations/evaluation-submission-review-eligibility.server";
import type { Viewer } from "~/platform/auth/authorize.server";

export type CommandRecord = {
  id: string;
  kind:
    | "speaker"
    | "submission"
    | "session"
    | "task"
    | "room"
    | "track"
    | "resource"
    | "operation";
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

const recordAliases: Record<CommandRecord["kind"], string[]> = {
  speaker: [
    "speaker",
    "speakers",
    "presenter",
    "presenters",
    "person",
    "people",
    "faculty",
  ],
  submission: [
    "submission",
    "submissions",
    "proposal",
    "proposals",
    "application",
    "applications",
    "abstract",
    "abstracts",
    "cfp",
  ],
  session: [
    "session",
    "sessions",
    "talk",
    "talks",
    "programme",
    "program",
    "agenda",
  ],
  task: [
    "task",
    "tasks",
    "readiness",
    "checklist",
    "checklists",
    "todo",
    "todos",
  ],
  room: ["room", "rooms", "venue", "venues", "space", "spaces"],
  track: ["track", "tracks", "stream", "streams"],
  resource: ["resource", "resources", "wiki", "guide", "guides"],
  operation: [
    "operation",
    "operations",
    "job",
    "jobs",
    "run",
    "runs",
    "communication",
    "communications",
    "integration",
    "integrations",
  ],
};

const aliasKinds = new Map(
  Object.entries(recordAliases).flatMap(([kind, aliases]) =>
    aliases.map((alias) => [alias, kind as CommandRecord["kind"]] as const),
  ),
);
const operationFamilyByAlias = new Map<string, "communication" | "integration">(
  [
    ["communication", "communication"],
    ["communications", "communication"],
    ["integration", "integration"],
    ["integrations", "integration"],
  ],
);
const coreRecordKinds = new Set<CommandRecord["kind"]>([
  "speaker",
  "submission",
  "session",
  "task",
]);
const operationalRecordKinds = new Set<CommandRecord["kind"]>([
  "room",
  "track",
  "resource",
  "operation",
]);

function parseRecordQuery(query: string) {
  const [first = "", ...remaining] = query.trim().split(/\s+/u);
  const normalizedAlias = first.toLocaleLowerCase();
  const kind = aliasKinds.get(normalizedAlias) ?? null;
  return {
    kind,
    operationFamily: operationFamilyByAlias.get(normalizedAlias) ?? null,
    query: kind ? remaining.join(" ") : query.trim(),
  };
}

function recordHref(kind: CommandRecord["kind"], id: string) {
  const encodedId = encodeURIComponent(id);
  switch (kind) {
    case "speaker":
      return `/admin/speakers?person=${encodedId}`;
    case "submission":
      return `/admin/submissions/${encodedId}`;
    case "session":
      return `/admin/schedule?session=${encodedId}`;
    case "task":
      return `/admin/tasks?task=${encodedId}`;
    case "room":
      return `/admin/event?room=${encodedId}`;
    case "track":
      return `/admin/event?track=${encodedId}`;
    case "resource":
      return `/admin/resources?resource=${encodedId}`;
    case "operation":
      return `/admin/operations?operation=${encodedId}`;
  }
  kind satisfies never;
  throw new Error(`Unsupported command record kind: ${String(kind)}`);
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
  if (entityType === "room") return recordHref("room", entityId);
  if (entityType === "track") return recordHref("track", entityId);
  if (["resource", "resource_page"].includes(entityType))
    return recordHref("resource", entityId);
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
      `SELECT id FROM events
        WHERE organisation_id = ? AND activation_status = 'active'
        ORDER BY id`,
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
      WITH authorised_assignments AS (
        SELECT assignment.id, assignment.event_id
          FROM evaluator_assignments assignment
          JOIN events event
            ON event.id = assignment.event_id
           AND event.organisation_id = ?
          JOIN evaluation_rounds round
            ON round.id = assignment.round_id
           AND round.event_id = assignment.event_id
          JOIN evaluation_plans plan
            ON plan.id = round.plan_id
           AND plan.event_id = round.event_id
          JOIN evaluation_round_reviewers pool
            ON pool.event_id = assignment.event_id
           AND pool.round_id = assignment.round_id
           AND pool.person_id = assignment.evaluator_person_id
          LEFT JOIN submissions submission
            ON submission.id = assignment.submission_id
           AND submission.event_id = assignment.event_id
          LEFT JOIN sessions session
            ON session.id = assignment.session_id
           AND session.event_id = assignment.event_id
         WHERE assignment.event_id = ?
           AND assignment.evaluator_person_id = ?
           AND assignment.status NOT IN ('recused','cancelled')
           AND plan.status = 'active'
           AND round.status = 'active'
           AND (round.opens_at IS NULL OR round.opens_at <= unixepoch())
           AND (round.closes_at IS NULL OR round.closes_at > unixepoch())
           AND EXISTS (
             SELECT 1
               FROM memberships reviewer_membership
              WHERE reviewer_membership.event_id = assignment.event_id
                AND reviewer_membership.person_id = assignment.evaluator_person_id
                AND reviewer_membership.accepted_at IS NOT NULL
                AND reviewer_membership.revoked_at IS NULL
                AND reviewer_membership.role IN ('evaluator','committee_chair')
           )
           AND (
             (assignment.submission_id IS NOT NULL
              AND ${reviewableSubmissionSql("submission", "review")})
             OR (assignment.session_id IS NOT NULL
                 AND session.status NOT IN ('cancelled','archived'))
           )
      )
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
          JOIN authorised_assignments authorised
            ON authorised.id = assignment.id
           AND authorised.event_id = assignment.event_id
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
          JOIN authorised_assignments authorised
            ON authorised.id = assignment.id
           AND authorised.event_id = assignment.event_id
          LEFT JOIN people actor ON actor.id = audit.actor_person_id
         WHERE audit.event_id = ? AND audit.entity_type = 'review'
      ) authorised
      ORDER BY createdAt DESC, id DESC
      LIMIT 8
    `,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
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
    const recordQuery = parseRecordQuery(input.query);
    const searchTerm = recordQuery.query;
    const eventPredicate =
      input.scope === "event"
        ? "AND e.activation_status = 'active' AND e.id = ?"
        : "AND e.activation_status = 'active' AND e.organisation_id = ?";
    const scopeBinding =
      input.scope === "event" ? viewer.eventId : viewer.organisationId;

    if (viewer.role === "committee_chair") {
      if (recordQuery.kind && recordQuery.kind !== "submission") return [];
      const assigned = await this.env.DB.prepare(
        `
        SELECT s.id, ea.id AS assignmentId,
               'submission' AS kind, s.title AS label,
               replace(s.status, '_', ' ') || ' · ' || s.public_reference AS description,
               e.id AS eventId, e.name AS eventName
          FROM submissions s
          JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
          JOIN evaluator_assignments ea
            ON ea.submission_id = s.id AND ea.event_id = s.event_id
          JOIN evaluation_rounds round
            ON round.id = ea.round_id AND round.event_id = ea.event_id
          JOIN evaluation_plans plan
            ON plan.id = round.plan_id AND plan.event_id = round.event_id
          JOIN evaluation_round_reviewers pool
            ON pool.event_id = ea.event_id
           AND pool.round_id = ea.round_id
           AND pool.person_id = ea.evaluator_person_id
         WHERE s.event_id = ? AND ea.evaluator_person_id = ?
           AND ea.status NOT IN ('recused','cancelled')
           AND plan.status = 'active'
           AND round.status = 'active'
           AND (round.opens_at IS NULL OR round.opens_at <= unixepoch())
           AND (round.closes_at IS NULL OR round.closes_at > unixepoch())
           AND ${reviewableSubmissionSql("s", "review")}
           AND EXISTS (
             SELECT 1
               FROM memberships reviewer_membership
              WHERE reviewer_membership.event_id = ea.event_id
                AND reviewer_membership.person_id = ea.evaluator_person_id
                AND reviewer_membership.accepted_at IS NOT NULL
                AND reviewer_membership.revoked_at IS NULL
                AND reviewer_membership.role IN ('evaluator','committee_chair')
           )
           AND (instr(lower(s.title), lower(?)) > 0 OR instr(lower(s.public_reference), lower(?)) > 0)
         ORDER BY s.title, ea.assigned_at, ea.id LIMIT 30
      `,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          searchTerm,
          searchTerm,
        )
        .all<
          Omit<CommandRecord, "href" | "aliases"> & { assignmentId: string }
        >();
      return assigned.results.map(({ assignmentId, ...record }) => ({
        ...record,
        href: `/review/workbench?assignment=${encodeURIComponent(assignmentId)}`,
        aliases: recordAliases.submission,
      }));
    }

    type SearchRow = Omit<CommandRecord, "href" | "aliases">;
    const searchCoreRecords = async (): Promise<SearchRow[]> => {
      if (recordQuery.kind && !coreRecordKinds.has(recordQuery.kind)) return [];
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
             AND (instr(lower(p.display_name), lower(?)) > 0 OR instr(lower(p.email), lower(?)) > 0 OR instr(lower(COALESCE(p.organisation_name, '')), lower(?)) > 0)
          UNION ALL
          SELECT s.id, 'submission' AS kind, s.title AS label,
                 replace(s.status, '_', ' ') || ' · ' || s.public_reference AS description,
                 e.id AS eventId, e.name AS eventName
           FROM submissions s
            JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
           WHERE e.activation_status = 'active'
             AND ${input.scope === "event" ? "e.id = ?" : "e.organisation_id = ?"}
             AND (
               instr(lower(s.title), lower(?)) > 0
               OR instr(lower(s.public_reference), lower(?)) > 0
               OR (
                 s.status = 'draft'
                 AND instr(lower(COALESCE(s.category, '')), lower(?)) > 0
               )
               OR EXISTS (
                 SELECT 1 FROM submission_track_selections selection
                  WHERE selection.submission_id = s.id
                    AND selection.event_id = s.event_id
                    AND instr(lower(selection.track_name_snapshot), lower(?)) > 0
               )
             )
          UNION ALL
          SELECT s.id, 'session' AS kind, s.title AS label,
                 replace(s.status, '_', ' ') || ' · ' || replace(s.format, '_', ' ') AS description,
                 e.id AS eventId, e.name AS eventName
            FROM sessions s
            JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
           WHERE e.activation_status = 'active'
             AND ${input.scope === "event" ? "e.id = ?" : "e.organisation_id = ?"}
             AND (instr(lower(s.title), lower(?)) > 0 OR instr(lower(s.slug), lower(?)) > 0 OR instr(lower(COALESCE(s.description, '')), lower(?)) > 0)
          UNION ALL
          SELECT ti.id, 'task' AS kind, ti.title AS label,
                 replace(ti.status, '_', ' ') || ' · ' || replace(ti.impact, '_', ' ') AS description,
                 e.id AS eventId, e.name AS eventName
            FROM task_instances ti
            JOIN events e ON e.id = ti.event_id AND e.organisation_id = ?
           WHERE e.activation_status = 'active'
             AND ${input.scope === "event" ? "e.id = ?" : "e.organisation_id = ?"}
             AND (instr(lower(ti.title), lower(?)) > 0 OR instr(lower(COALESCE(ti.description, '')), lower(?)) > 0)
        ) records
        WHERE (? IS NULL OR kind = ?)
        ORDER BY label, kind
        LIMIT 50
      `,
      )
        .bind(
          viewer.organisationId,
          scopeBinding,
          searchTerm,
          searchTerm,
          searchTerm,
          viewer.organisationId,
          scopeBinding,
          searchTerm,
          searchTerm,
          searchTerm,
          searchTerm,
          viewer.organisationId,
          scopeBinding,
          searchTerm,
          searchTerm,
          searchTerm,
          viewer.organisationId,
          scopeBinding,
          searchTerm,
          searchTerm,
          recordQuery.kind,
          recordQuery.kind,
        )
        .all<SearchRow>();
      return rows.results;
    };

    const searchOperationalRecords = async (): Promise<SearchRow[]> => {
      if (recordQuery.kind && !operationalRecordKinds.has(recordQuery.kind))
        return [];
      const rows = await this.env.DB.prepare(
        `
        SELECT * FROM (
          SELECT room.id, 'room' AS kind, room.name AS label,
                 room.status || ' · capacity ' || room.capacity ||
                   CASE WHEN room.building IS NULL THEN '' ELSE ' · ' || room.building END ||
                   CASE WHEN room.level IS NULL THEN '' ELSE ' · ' || room.level END AS description,
                 e.id AS eventId, e.name AS eventName
           FROM rooms room
            JOIN events e ON e.id = room.event_id AND e.organisation_id = ?
           WHERE e.activation_status = 'active'
             AND ${input.scope === "event" ? "e.id = ?" : "e.organisation_id = ?"}
             AND room.status = 'active'
             AND (instr(lower(room.name), lower(?)) > 0 OR instr(lower(COALESCE(room.building, '')), lower(?)) > 0 OR instr(lower(COALESCE(room.level, '')), lower(?)) > 0)
          UNION ALL
          SELECT track.id, 'track' AS kind, track.name AS label,
                 track.slug || CASE WHEN track.is_public = 1 THEN ' · public' ELSE ' · private' END ||
                   CASE WHEN track.exclusive = 1 THEN ' · exclusive' ELSE '' END AS description,
                 e.id AS eventId, e.name AS eventName
            FROM tracks track
            JOIN events e ON e.id = track.event_id AND e.organisation_id = ?
           WHERE e.activation_status = 'active'
             AND ${input.scope === "event" ? "e.id = ?" : "e.organisation_id = ?"}
             AND (instr(lower(track.name), lower(?)) > 0 OR instr(lower(track.slug), lower(?)) > 0)
          UNION ALL
          SELECT resource.id, 'resource' AS kind, resource.title AS label,
                 replace(resource.status, '_', ' ') || CASE WHEN resource.category IS NULL THEN '' ELSE ' · ' || resource.category END AS description,
                 e.id AS eventId, e.name AS eventName
            FROM resource_pages resource
            JOIN events e ON e.id = resource.event_id AND e.organisation_id = ?
           WHERE e.activation_status = 'active'
             AND ${input.scope === "event" ? "e.id = ?" : "e.organisation_id = ?"}
             AND (instr(lower(resource.title), lower(?)) > 0 OR instr(lower(resource.slug), lower(?)) > 0 OR instr(lower(COALESCE(resource.category, '')), lower(?)) > 0)
          UNION ALL
          SELECT operation.id, 'operation' AS kind,
                 COALESCE(
                   MIN(NULLIF(json_extract(communication.content_snapshot_json, '$.subjectTemplate'), '')),
                   MIN(CASE WHEN connection.provider IS NULL THEN NULL ELSE connection.provider || ' integration run' END),
                   replace(operation.type, '.', ' ')
                 ) AS label,
                 replace(operation.status, '_', ' ') || ' · ' || replace(operation.type, '_', ' ') AS description,
                 e.id AS eventId, e.name AS eventName
            FROM operation_jobs operation
            JOIN events e ON e.id = operation.event_id AND e.organisation_id = ?
            LEFT JOIN communications communication
              ON communication.operation_id = operation.id
             AND communication.event_id = operation.event_id
            LEFT JOIN integration_runs integration_run
              ON integration_run.operation_id = operation.id
            LEFT JOIN integration_connections connection
              ON connection.id = integration_run.connection_id
             AND connection.organisation_id = operation.organisation_id
             AND (connection.event_id IS NULL OR connection.event_id = operation.event_id)
           WHERE e.activation_status = 'active'
             AND ${input.scope === "event" ? "e.id = ?" : "e.organisation_id = ?"}
             AND (
               ? IS NULL
               OR (
                 ? = 'communication'
                 AND (
                   communication.id IS NOT NULL
                   OR operation.type IN (
                     'communication.send',
                     'decision.notification',
                     'submission.notification'
                   )
                 )
               )
               OR (
                 ? = 'integration'
                 AND (
                   integration_run.id IS NOT NULL
                   OR operation.type = 'integration.accelevents.export'
                 )
               )
             )
           GROUP BY operation.id, operation.correlation_id, operation.status,
                    operation.type, operation.last_error, e.id, e.name
          HAVING instr(lower(operation.id), lower(?)) > 0
              OR instr(lower(operation.correlation_id), lower(?)) > 0
              OR MAX(instr(lower(COALESCE(communication.id, '')), lower(?))) > 0
              OR MAX(instr(lower(COALESCE(integration_run.id, '')), lower(?))) > 0
              OR instr(lower(operation.type), lower(?)) > 0
              OR instr(lower(operation.status), lower(?)) > 0
              OR instr(lower(COALESCE(operation.last_error, '')), lower(?)) > 0
              OR MAX(instr(lower(COALESCE(json_extract(communication.content_snapshot_json, '$.subjectTemplate'), '')), lower(?))) > 0
              OR MAX(instr(lower(COALESCE(connection.provider, '')), lower(?))) > 0
        ) records
        WHERE (? IS NULL OR kind = ?)
        ORDER BY label, kind
        LIMIT 50
      `,
      )
        .bind(
          viewer.organisationId,
          scopeBinding,
          searchTerm,
          searchTerm,
          searchTerm,
          viewer.organisationId,
          scopeBinding,
          searchTerm,
          searchTerm,
          viewer.organisationId,
          scopeBinding,
          searchTerm,
          searchTerm,
          searchTerm,
          viewer.organisationId,
          scopeBinding,
          recordQuery.operationFamily,
          recordQuery.operationFamily,
          recordQuery.operationFamily,
          searchTerm,
          searchTerm,
          searchTerm,
          searchTerm,
          searchTerm,
          searchTerm,
          searchTerm,
          searchTerm,
          searchTerm,
          recordQuery.kind,
          recordQuery.kind,
        )
        .all<SearchRow>();
      return rows.results;
    };

    const records = (
      await Promise.all([searchCoreRecords(), searchOperationalRecords()])
    )
      .flat()
      .sort(
        (left, right) =>
          left.label.localeCompare(right.label) ||
          left.kind.localeCompare(right.kind),
      )
      .slice(0, 50);

    return records.map((record) => ({
      ...record,
      href: recordHref(record.kind, record.id),
      aliases: recordAliases[record.kind],
    }));
  }
}
